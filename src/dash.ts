import { authMode } from "./auth";
import type { Env } from "./env";
import { hostError, normalizeHost } from "./host";

/** Where the dashboard lives (S8c). Host mode: prefix "" and base = origin. Path mode: base = origin + prefix. */
export type Dash = {
  host: string;
  prefix: string;
  origin: string;
  base: string;
  legacy: string | null;
  pathMode: boolean;
  cookie: { name: string; path: string };
};

// R1: one lowercase segment, no trailing slash, at most 32 characters after the slash.
const PREFIX = /^\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// Root segments of the app and the OAuth provider (and Cloudflare's own /cdn-cgi): a prefix equal to one would make the
// wrapper's OAuth gate and the registration limiter judge a stripped path that collides with them.
const RESERVED_PREFIXES: readonly string[] = ["/api", "/assets", "/auth", "/authorize", "/cdn-cgi", "/healthz", "/join", "/mcp", "/register", "/sign-in", "/token"];
const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

function compute(env: Env): Dash | string {
  const rawHost: unknown = env.DASHBOARD_HOST;
  if (typeof rawHost !== "string" || rawHost.trim() === "") return "DASHBOARD_HOST";
  const host = normalizeHost(rawHost);
  const rawPath: unknown = env.DASHBOARD_PATH;
  const pathMode = !blank(rawPath);
  if (pathMode && (typeof rawPath !== "string" || !PREFIX.test(rawPath) || RESERVED_PREFIXES.includes(rawPath))) return "DASHBOARD_PATH";
  // R14: an Access application cannot cover the prefix and bypass the discovery paths, so path mode is app mode only.
  if (pathMode && authMode(env) !== "app") return "AUTH_MODE";
  const rawLegacy: unknown = env.LEGACY_DASHBOARD_HOST;
  let legacy: string | null = null;
  if (!blank(rawLegacy)) {
    if (typeof rawLegacy !== "string") return "LEGACY_DASHBOARD_HOST";
    legacy = normalizeHost(rawLegacy.trim());
    if (hostError(legacy, host) !== null) return "LEGACY_DASHBOARD_HOST";
  }
  const prefix = pathMode ? (rawPath as string) : "";
  const origin = `https://${host}`;
  return {
    host, prefix, origin, base: origin + prefix, legacy, pathMode,
    cookie: pathMode ? { name: "__Secure-lw_session", path: prefix } : { name: "__Host-lw_session", path: "/" },
  };
}

let memo: { key: string; value: Dash | null } | undefined;

/** R1: validated once per isolate (keyed on the raw values, so a changed env is re-read); null = misconfigured. */
export function dash(env: Env): Dash | null {
  const key = JSON.stringify([env.DASHBOARD_HOST, env.DASHBOARD_PATH, env.LEGACY_DASHBOARD_HOST, String(env.AUTH_MODE)]);
  if (memo?.key === key) return memo.value;
  const r = compute(env);
  if (typeof r === "string") console.error(`dashboard config invalid: ${r}`); // the name only, never the value
  memo = { key, value: typeof r === "string" ? null : r };
  return memo.value;
}

/** An absolute dashboard URL; `path` starts with "/". Callers run after the misconfigured gate. */
export function dashUrl(env: Env, path: string): string {
  const d = dash(env);
  if (!d) throw new Error("dashUrl: misconfigured");
  return d.base + path;
}

/** The one MCP resource: always the root /mcp of the dashboard host, in both modes (never under the prefix). */
export const mcpUrl = (env: Env): string => `https://${normalizeHost(env.DASHBOARD_HOST)}/mcp`;

/** Exact, case-sensitive, on the raw (parser-normalized, not decoded) pathname: "P" or "P/...", never "Px". */
export const underPrefix = (pathname: string, prefix: string) =>
  prefix === "" || pathname === prefix || pathname.startsWith(prefix + "/");

/** Host mode: the request itself. Path mode: the same request with the prefix stripped (root routes), or null outside it. */
export function innerRequest(req: Request, d: Dash): Request | null {
  if (!d.pathMode) return req;
  const url = new URL(req.url);
  if (!underPrefix(url.pathname, d.prefix)) return null;
  url.pathname = url.pathname.slice(d.prefix.length) || "/";
  return new Request(url, req);
}

/** Root OAuth and OpenID discovery documents on the main short domain (R4, R5): never a short link. */
export const isDiscoveryPath = (pathname: string) =>
  pathname.startsWith("/.well-known/oauth-") || pathname.startsWith("/.well-known/openid-configuration");

/**
 * R10: the old dashboard host. GET/HEAD 301 to the same path under the base; the target is built from the configured base
 * and the parsed path and query only, then re-parsed and checked to stay on the dashboard host under the prefix.
 * Every other method and every /.well-known/ path is 410: a 301 would turn a POST into a GET, and OAuth clients must be re-pointed.
 */
export function legacyAnswer(req: Request, d: Dash): Response {
  const url = new URL(req.url);
  // The machine API and MCP live at the root of the new host, never under the dashboard: point callers there (no redirect,
  // so a Bearer credential is never re-sent on its own).
  const root = /^\/(?:api\/v1|mcp)(?:\/|$)/.exec(url.pathname)?.[0].replace(/\/$/, "");
  if (root) return Response.json({ error: "moved", to: d.origin + root }, { status: 410 });
  if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/.well-known/")) {
    const loc = d.base + url.pathname + url.search;
    const to = URL.parse(loc);
    if (to && to.host === d.host && underPrefix(to.pathname, d.prefix)) return new Response(null, { status: 301, headers: { location: loc } });
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ error: "moved", to: d.base + "/" }, { status: 410 });
}

/** Slugs the dashboard shadows on `host`: in path mode on the dashboard host the prefix segment, `mcp` and `api` (the MCP
 * server and the machine API live at the root there), else none. */
export function reservedSlugs(env: Env, host: string): string[] {
  const d = dash(env);
  return d?.pathMode && host === d.host ? [d.prefix.slice(1), "mcp", "api"] : [];
}
