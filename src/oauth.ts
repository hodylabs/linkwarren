import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
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

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LOOPBACK_CALLBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):([1-9]\d{0,4})\/callback$/;

/** The only redirect URIs a client may register: the claude.ai callback exactly, or a loopback /callback on port 1-65535. */
export function allowedRedirect(u: unknown): boolean {
  if (typeof u !== "string") return false;
  if (u === CLAUDE_CALLBACK) return true;
  const m = LOOPBACK_CALLBACK.exec(u);
  return !!m && Number(m[1]) <= 65535;
}

/** Runs before the library stores the client, so a refusal writes nothing to KV. RFC 7591 error shape, 400. */
const checkRegistration = ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(allowedRedirect))
    return { code: "invalid_redirect_uri", description: "Only the claude.ai callback and http://localhost|127.0.0.1:<port>/callback are accepted" };
};

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
