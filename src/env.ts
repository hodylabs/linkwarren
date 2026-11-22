import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  /** OAuth grants, tokens, clients and consent (the library hard-codes this binding name). */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider for the handlers behind it. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** "0" locks MCP and the OAuth endpoints off; unset or "1" lets the owner's D1 setting decide (no setting yet: on only with "1"). */
  MCP_ENABLED?: string;
  DASHBOARD_HOST: string;
  /** "app" (default when unset or blank) or "access"; any other value fails closed with 500 misconfigured. */
  AUTH_MODE?: string;
  /** Access mode only; verifyAccess refuses blanks. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL: string;
  /** App mode: sender address for sign-in emails. RESEND_API_KEY is a secret, never a var. */
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** Workers static assets (the built dashboard); absent in tests without the fake and in unbuilt deploys. */
  ASSETS?: Fetcher;
  /** Test-only: a JWKS JSON string used instead of the remote Access certs. Never set in production. */
  ACCESS_JWKS_JSON?: string;
  /** Cloudflare onboarding (all optional; features stay off when unset). CF_API_TOKEN is a secret. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_WORKER_NAME?: string;
  CF_SAAS_ZONE_ID?: string;
  CF_CNAME_TARGET?: string;
  /** Click analytics (all optional). CLICKS is the Analytics Engine dataset binding; no binding, nothing recorded. */
  CLICKS?: AnalyticsEngineDataset;
  /** Secret: API token with only Account Analytics Read on CF_ACCOUNT_ID. Never logged or returned. */
  AE_READ_TOKEN?: string;
  /** Dataset name, default "linkwarren_clicks", must match ^[A-Za-z0-9_]{1,64}$. */
  AE_DATASET?: string;
  /** Secret: daily visitor hash salt; unset leaves the visitor blob empty. */
  VISITOR_SALT?: string;
  /** PBKDF2 iterations for new link passwords: integer, clamped 1000..100000; unset or invalid uses PASSWORD_DEFAULT_ITERATIONS. */
  PASSWORD_HASH_ITERATIONS?: string;
};
