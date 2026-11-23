import { OAuthError, OAuthProvider, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { app } from "./app";
import { dash, innerRequest } from "./dash";
import { mcpHandler } from "./mcp/server";

/** Every path the OAuth provider answers; all of them are JSON 404 while agent connections are off (mcpState). */
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
  "https://vertexaisearch.cloud.google.com/oauth-redirect", // Gemini Enterprise
  "https://antigravity.google/oauth-callback", // Google Antigravity
];
// /callback, /callback/<id> as Codex sends it (one segment of the id alphabet: no dots, slashes or escapes), or
// /oauth/callback (Gemini CLI).
const LOOPBACK_CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):([1-9]\d{0,4})\/(?:callback(?:\/[A-Za-z0-9_-]{1,64})?|oauth\/callback)$/;

/** The only redirect URIs a client may register: one of CALLBACKS exactly, or a loopback callback path on port 1-65535. */
export function allowedRedirect(u: unknown): boolean {
  if (typeof u !== "string") return false;
  if (CALLBACKS.includes(u)) return true;
  const m = LOOPBACK_CALLBACK.exec(u);
  return !!m && Number(m[1]) <= 65535;
}

/** Runs before the library stores the client, so a refusal writes nothing to KV. RFC 7591 error shape, 400. */
/** One log line for a refused redirect, so a live attempt by an unlisted client shows what to allow: origin and path only. */
export function logRefused(u: unknown): void {
  const raw = typeof u === "string" ? u.replace(/[\p{Cc}\p{Cf}]/gu, "") : "";
  const p = URL.parse(raw);
  console.error(`redirect refused origin=${p ? `${p.protocol}//${p.host}` : "invalid"} path=${p?.pathname ?? ""}`.slice(0, 200));
}

const checkRegistration = ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
  const uris = clientMetadata.redirect_uris;
  const bad = Array.isArray(uris) ? uris.find((u) => !allowedRedirect(u)) : undefined;
  if (bad !== undefined) logRefused(bad);
  if (!Array.isArray(uris) || uris.length === 0 || bad !== undefined)
    return { code: "invalid_redirect_uri", description: `Only ${CALLBACKS.join(", ")} and http://localhost|127.0.0.1:<port>/callback[/<id>] or /oauth/callback are accepted` };
};

/**
 * Every code exchange and refresh re-reads the connection and its person (one D1 read): a revoked connection (for example a
 * disconnect whose KV revoke failed) or a disabled person gets invalid_grant, and the library then revokes the grant.
 * The role is not checked here (S8 R7 ruling): a token for a role without `agents` still refreshes, and every tool call is
 * refused in resolve (src/mcp/run.ts), so turning the permission back on restores the connection as it was.
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

let cached: { key: string; p: OAuthProvider<Env> } | undefined;

/**
 * One provider per dashboard base (host + prefix; the resource URL is derived from it, so a token is bound to one base and
 * refused after a switch). R5: every endpoint under the prefix, the issuer stays the origin (the token endpoint's origin),
 * so the authorization-server metadata is the root RFC 8414 document. The library reads its KV as env.OAUTH_KV.
 */
export function provider(env: Env): OAuthProvider<Env> {
  const d = dash(env);
  const host = d?.host ?? normalizeHost(env.DASHBOARD_HOST);
  const P = d?.prefix ?? "";
  const key = host + P;
  if (cached?.key !== key)
    cached = {
      key,
      p: new OAuthProvider<Env>({
        apiRoute: `${P}/mcp`,
        apiHandler: mcpHandler,
        // Path mode: the app only ever sees inner (root) paths (R3); the wrapper sends nothing outside the prefix here.
        defaultHandler: {
          fetch: (req, e, ctx) => {
            const d = dash(e);
            const inner = d ? innerRequest(req, d) : req;
            return inner ? app.fetch(inner, e, ctx) : Response.json({ error: "not_found" }, { status: 404 });
          },
        },
        authorizeEndpoint: `${P}/authorize`,
        tokenEndpoint: `${P}/token`,
        clientRegistrationEndpoint: `${P}/register`,
        clientRegistrationCallback: checkRegistration,
        tokenExchangeCallback: checkConnection,
        accessTokenTTL: 86400,
        refreshTokenTTL: 2592000,
        clientRegistrationTTL: 2592000, // abandoned DCR clients age out
        scopesSupported: ["offline_access", "read", "write", "delete"],
        clientIdMetadataDocumentEnabled: false,
        resourceMetadata: { resource: `https://${host}${P}/mcp` },
      }),
    };
  return cached.p;
}
