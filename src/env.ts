export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
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
};
