import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { app } from "./index";

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

// Task 7 replaces this with the MCP handler.
const mcpStub = { fetch: async () => Response.json({ jsonrpc: "2.0" }, { status: 501 }) };

let cached: { host: string; p: OAuthProvider<Env> } | undefined;

/** One provider per dashboard host (the resource URL is derived from it). The library reads its KV as env.OAUTH_KV. */
export function provider(env: Env): OAuthProvider<Env> {
  const host = normalizeHost(env.DASHBOARD_HOST);
  if (cached?.host !== host)
    cached = {
      host,
      p: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpStub,
        defaultHandler: { fetch: (req, e, ctx) => app.fetch(req, e, ctx) },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
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
