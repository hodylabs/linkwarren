import { app } from "./app";
import { scheduled } from "./cron";
import { dash, isDiscoveryPath, legacyAnswer, underPrefix } from "./dash";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { hitAll, LIMITS, limitKey } from "./limits";
import { mcpState } from "./mcp/switch";
import { handleRedirect } from "./redirect";
import { isOAuthPath, provider } from "./oauth";
import { ipPrefix } from "./session";

export { app };

const decoded = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/** POST /register spends a KV write: D1 limits per IP range and per UTC day, one atomic statement so a refused call writes nothing. */
async function registerLimited(req: Request, env: Env): Promise<Response | null> {
  const ipKey = limitKey.reg(ipPrefix(req.headers.get("cf-connecting-ip")));
  try {
    if (!(await hitAll(env, [{ key: ipKey, limit: LIMITS.reg }, { key: limitKey.regDay, limit: LIMITS.regDay }])).ok)
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "3600" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 }); // fail closed: no limiter, no registration
  }
  return null;
}

/**
 * Front door. Order: misconfigured, legacy host, other hosts (the app answers short links), then the dashboard host. In path
 * mode the decision is string compares on the host and pathname only, before any D1, KV or provider work: under the prefix
 * goes to the OAuth gate and provider (whose default handler strips the prefix for the app), a root discovery path is JSON,
 * and every other path is a short link straight to handleRedirect.
 */
export async function wrapper(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const d = dash(env);
  if (!d) return Response.json({ error: "misconfigured" }, { status: 500 });
  const url = new URL(req.url);
  const host = normalizeHost(req.headers.get("host") ?? url.host);
  if (host === d.legacy) return legacyAnswer(req, d);
  if (host !== d.host) return app.fetch(req, env, ctx);
  let p = url.pathname;
  if (d.pathMode) {
    if (!underPrefix(p, d.prefix)) {
      if (isDiscoveryPath(p)) return notFound(); // shortcut: discovery documents arrive with the OAuth prefix work (Task 4)
      return handleRedirect(req, env, Math.floor(Date.now() / 1000), ctx);
    }
    p = p.slice(d.prefix.length) || "/"; // the gate below judges the inner path, as host mode does
  }
  // The decoded form too, so an encoded OAuth path (/%6dcp) is closed with the rest while agents are off.
  if (isOAuthPath(p) || isOAuthPath(decoded(p))) {
    try {
      if (!(await mcpState(env)).on) return notFound();
    } catch {
      return Response.json({ error: "unavailable" }, { status: 503 }); // fail closed: no setting, no agents
    }
    // The library serves only the RFC 9728 suffix form; the bare form gets the same metadata, never the dashboard HTML.
    if (!d.pathMode && p === "/.well-known/oauth-protected-resource") return provider(env).fetch(new Request(new URL("/.well-known/oauth-protected-resource/mcp", url), req), env, ctx);
    if (p === "/register" && req.method === "POST") {
      const limited = await registerLimited(req, env);
      if (limited) return limited;
    }
  }
  try {
    return await provider(env).fetch(req, env, ctx);
  } catch (err) {
    // For example the KV daily write cap: JSON, not the platform's HTML error page. Only the error name is logged.
    console.error("oauth provider error", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

export default { fetch: wrapper, scheduled } satisfies ExportedHandler<Env>;
