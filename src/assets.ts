import { dash, type Dash } from "./dash";
import type { Env } from "./env";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** R11: path mode limits every source to the prefix, so the dashboard never loads anything from a short-link path. */
const pathCsp = (d: Dash) => {
  const b = d.base;
  return `default-src 'self'; script-src ${b}/assets/; style-src ${b}/assets/; font-src ${b}/assets/; img-src ${b}/ data:; connect-src ${b}/; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
};

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** R11: the build uses relative URLs ("./"); the shell gets them rooted at the prefix ("/" in host mode) and the base as a meta. */
function rewriteShell(res: Response, prefix: string): Response {
  const root = (attr: string) => ({
    element(el: Element) {
      el.setAttribute(attr, prefix + "/" + el.getAttribute(attr)!.slice(2));
    },
  });
  return new HTMLRewriter()
    .on('[src^="./"]', root("src"))
    .on('[href^="./"]', root("href"))
    .on("head", { element: (el) => void el.append(`<meta name="lw-base" content="${escAttr(prefix)}">`, { html: true }) })
    .transform(res);
}

/** Dashboard host only (the caller gates the host; `req` is the inner request). Unknown extensionless paths get the SPA shell; a missing file stays 404. */
export async function serveDashboard(req: Request, env: Env): Promise<Response> {
  if (!env.ASSETS)
    return new Response(JSON.stringify({ error: "no_assets" }), { status: 503, headers: { "content-type": "application/json", ...SECURITY_HEADERS } });
  const d = dash(env)!; // the app's misconfigured gate ran first
  const url = new URL(req.url);
  let res = await env.ASSETS.fetch(req);
  if (res.status === 404 && !url.pathname.split("/").pop()!.includes("."))
    res = await env.ASSETS.fetch(new Request(new URL("/", req.url), { method: req.method, headers: req.headers }));
  const shell = res.ok && (res.headers.get("content-type") ?? "").startsWith("text/html");
  const out = new Response(shell ? rewriteShell(res, d.prefix).body : res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (d.pathMode) out.headers.set("Content-Security-Policy", pathCsp(d));
  if (shell) {
    out.headers.set("X-Robots-Tag", "noindex");
    out.headers.delete("content-length"); // the rewrite changes the size
  }
  // R4: the sign-in link token sits in this page's fragment; no Referer may leave it, on any spelling of the path.
  if (signInPath(url.pathname)) out.headers.set("Referrer-Policy", "no-referrer");
  return out;
}

/** True for every path that normalizes to /sign-in: percent-decoded, repeated slashes collapsed, trailing slashes dropped. */
function signInPath(p: string): boolean {
  try {
    p = decodeURIComponent(p);
  } catch {
    // malformed escapes: compare the raw path
  }
  return p.replace(/\/{2,}/g, "/").replace(/\/+$/, "") === "/sign-in";
}
