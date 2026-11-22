import { OAuthError, OAuthProvider, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { app } from "./app";
import { mcpHandler } from "./mcp/server";

/** Every path the OAuth provider answers; all of them are JSON 404 unless MCP_ENABLED is "1". */
export const OAUTH_PATHS: readonly string[] = [
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

/** Exact OAuth paths plus what the provider also routes below them (/mcp/... and other protected-resource suffixes). */
export const isOAuthPath = (p: string) =>
  OAUTH_PATHS.includes(p) || p.startsWith("/mcp/") || p.startsWith("/.well-known/oauth-protected-resource/");

/** Hosted agent callbacks, exact strings only. */
const CALLBACKS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];
// /callback, or /callback/<id> as Codex sends it (one segment of the id alphabet: no dots, slashes or escapes).
const LOOPBACK_CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):([1-9]\d{0,4})\/callback(?:\/[A-Za-z0-9_-]{1,64})?$/;

/** The only redirect URIs a client may register: one of CALLBACKS exactly, or a loopback /callback[/<id>] on port 1-65535. */
export function allowedRedirect(u: unknown): boolean {
  if (typeof u !== "string") return false;
  if (CALLBACKS.includes(u)) return true;
  const m = LOOPBACK_CALLBACK.exec(u);
  return !!m && Number(m[1]) <= 65535;
}

/** Runs before the library stores the client, so a refusal writes nothing to KV. RFC 7591 error shape, 400. */
const checkRegistration = ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(allowedRedirect))
    return { code: "invalid_redirect_uri", description: `Only ${CALLBACKS.join(", ")} and http://localhost|127.0.0.1:<port>/callback[/<id>] are accepted` };
};

/**
 * Every code exchange and refresh re-reads the connection and its person (one D1 read): a revoked connection (for example a
 * disconnect whose KV revoke failed) or a disabled person gets invalid_grant, and the library then revokes the grant.
 * No D1, no token (temporarily_unavailable, the grant is kept).
 */
export async function checkConnection(o: TokenExchangeCallbackOptions<Env>): Promise<void> {
  const connId = (o.props as { connId?: unknown } | undefined)?.connId;
  let ok: unknown = null;
  if (typeof connId === "string") {
    try {
      ok = await o.env.DB.prepare(
        "SELECT 1 FROM agent_connections c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.user_id = ? AND c.revoked_at IS NULL AND u.status = 'active'",
      ).bind(connId, o.userId).first();
    } catch (e) {
      console.error("connection check failed", e instanceof Error ? e.name : "unknown");
      throw new OAuthError("temporarily_unavailable", { description: "Try again later", statusCode: 503 });
    }
  }
  if (!ok) throw new OAuthError("invalid_grant", { description: "This connection was disconnected" });
}

let cached: { host: string; p: OAuthProvider<Env> } | undefined;

/** One provider per dashboard host (the resource URL is derived from it). The library reads its KV as env.OAUTH_KV. */
export function provider(env: Env): OAuthProvider<Env> {
  const host = normalizeHost(env.DASHBOARD_HOST);
  if (cached?.host !== host)
    cached = {
      host,
      p: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler,
        defaultHandler: { fetch: (req, e, ctx) => app.fetch(req, e, ctx) },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        clientRegistrationCallback: checkRegistration,
        tokenExchangeCallback: checkConnection,
        accessTokenTTL: 86400,
        refreshTokenTTL: 2592000,
        clientRegistrationTTL: 2592000, // abandoned DCR clients age out
        scopesSupported: ["offline_access", "read", "write", "delete"],
        clientIdMetadataDocumentEnabled: false,
        resourceMetadata: { resource: `https://${host}/mcp` },
      }),
    };
  return cached.p;
}
