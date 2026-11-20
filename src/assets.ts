import type { Env } from "./env";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Dashboard host only (the caller gates the host). Unknown extensionless paths get the SPA shell; a missing file stays 404. */
export async function serveDashboard(req: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response(JSON.stringify({ error: "no_assets" }), { status: 503, headers: { "content-type": "application/json" } });
  const url = new URL(req.url);
  let res = await env.ASSETS.fetch(req);
  if (res.status === 404 && !url.pathname.split("/").pop()!.includes("."))
    res = await env.ASSETS.fetch(new Request(new URL("/", req.url), { method: req.method, headers: req.headers }));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
