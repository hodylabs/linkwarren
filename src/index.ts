import { app } from "./app";
import { isV1 } from "./api/shared";
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

/** The owner's agent switch: null when on, else the JSON answer (404 off, 503 when the setting cannot be read: fail closed). */
async function agentsOff(env: Env): Promise<Response | null> {
  try {
    return (await mcpState(env)).on ? null : notFound();
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

async function providerFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await provider(env).fetch(req, env, ctx);
  } catch (err) {
    // For example the KV daily write cap: JSON, not the platform's HTML error page. Only the error name is logged.
    console.error("oauth provider error", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

// Path mode: the main domain's root paths that are never short links (the MCP server and the machine API), one regex test.
const ROOT_MACHINE = /^\/(?:mcp|api)(?:\/|$)/;
const isMcpPath = (p: string) => p === "/mcp" || p.startsWith("/mcp/");

/**
 * Path mode, /mcp, /mcp/..., /api or /api/... at the root of the main domain. /mcp is the one MCP resource (agents gate, then
 * the provider); /api/v1/... is the machine API, straight to the app (Bearer keys only, as in host mode). Every other path
 * here is JSON 404: never a short link, never the dashboard app (its session API lives under the prefix only).
 */
async function rootMachine(req: Request, env: Env, ctx: ExecutionContext, p: string): Promise<Response> {
  if (p === "/mcp") {
    const off = await agentsOff(env);
    return off ?? providerFetch(req, env, ctx);
  }
  return isV1(p) ? app.fetch(req, env, ctx) : notFound();
}

const AS_METADATA = "/.well-known/oauth-authorization-server";
const PR_BARE = "/.well-known/oauth-protected-resource";

/**
 * Path mode, a root discovery path on the main short domain (R4, R5): exactly the authorization-server metadata (the issuer is
 * the origin), the RFC 9728 path-inserted protected-resource metadata of the root /mcp and its bare alias, while agents are on.
 * Every other discovery path is JSON 404 without a D1 read.
 */
async function discovery(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const pr = `${PR_BARE}/mcp`;
  if (url.pathname !== AS_METADATA && url.pathname !== pr && url.pathname !== PR_BARE) return notFound();
  const off = await agentsOff(env);
  if (off) return off;
  return providerFetch(url.pathname === PR_BARE ? new Request(new URL(pr, url), req) : req, env, ctx);
}

/**
 * Front door. Order: misconfigured, legacy host, other hosts (the app answers short links), then the dashboard host. In path
 * mode the decision is string compares on the host and pathname only, before any D1, KV or provider work: under the prefix
 * goes to the OAuth gate and provider (whose default handler strips the prefix for the app), a root discovery path is the
 * discovery branch, and every other path is a short link straight to handleRedirect.
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
      if (ROOT_MACHINE.test(p)) return rootMachine(req, env, ctx, p);
      if (isDiscoveryPath(p)) return discovery(req, env, ctx);
      // The app's onError does not cover this direct call: a D1 or KV error must still be JSON, not the platform's 1101 page.
      return handleRedirect(req, env, Math.floor(Date.now() / 1000), ctx).catch((err: unknown) => {
        console.error("unhandled error", err instanceof Error ? err.name : "unknown");
        return Response.json({ error: "internal" }, { status: 500 });
      });
    }
    p = p.slice(d.prefix.length) || "/"; // the gate below judges the inner path, as host mode does
    // Discovery documents live at the root only (R5): under the prefix they are JSON 404, never the dashboard HTML.
    if (isDiscoveryPath(p) || isDiscoveryPath(decoded(p))) return notFound();
    // MCP and the machine API live at the root (one resource each): under the prefix they are JSON 404, never served twice.
    // 404, not a redirect: an agent or script with a bearer credential must be re-pointed, not silently followed.
    if (isMcpPath(p) || isMcpPath(decoded(p)) || isV1(p) || isV1(decoded(p))) return notFound();
  }
  // The decoded form too, so an encoded OAuth path (/%6dcp) is closed with the rest while agents are off.
  if (isOAuthPath(p) || isOAuthPath(decoded(p))) {
    const off = await agentsOff(env);
    if (off) return off;
    // The library serves only the RFC 9728 suffix form; the bare form gets the same metadata, never the dashboard HTML.
    if (!d.pathMode && p === PR_BARE) return providerFetch(new Request(new URL(`${PR_BARE}/mcp`, url), req), env, ctx);
    if (p === "/register" && req.method === "POST") {
      const limited = await registerLimited(req, env);
      if (limited) return limited;
    }
  }
  return providerFetch(req, env, ctx);
}

export default { fetch: wrapper, scheduled } satisfies ExportedHandler<Env>;
