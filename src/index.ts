import { app } from "./app";
import { scheduled } from "./cron";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { hitAll, LIMITS, limitKey } from "./limits";
import { mcpState } from "./mcp/switch";
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

/** OAuth front door. Short hosts and a misconfigured instance never reach the provider; the app answers them. */
export async function wrapper(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DASHBOARD_HOST?.trim()) return app.fetch(req, env, ctx);
  const url = new URL(req.url);
  if (normalizeHost(req.headers.get("host") ?? url.host) !== normalizeHost(env.DASHBOARD_HOST)) return app.fetch(req, env, ctx);
  const p = url.pathname;
  // The decoded form too, so an encoded OAuth path (/%6dcp) is closed with the rest while agents are off.
  if (isOAuthPath(p) || isOAuthPath(decoded(p))) {
    try {
      if (!(await mcpState(env)).on) return notFound();
    } catch {
      return Response.json({ error: "unavailable" }, { status: 503 }); // fail closed: no setting, no agents
    }
    // The library serves only the RFC 9728 suffix form; the bare form gets the same metadata, never the dashboard HTML.
    if (p === "/.well-known/oauth-protected-resource") return provider(env).fetch(new Request(new URL("/.well-known/oauth-protected-resource/mcp", url), req), env, ctx);
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
