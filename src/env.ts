export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  DASHBOARD_HOST: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  /** Workers static assets (the built dashboard); absent in tests without the fake and in unbuilt deploys. */
  ASSETS?: Fetcher;
  /** Test-only: a JWKS JSON string used instead of the remote Access certs. Never set in production. */
  ACCESS_JWKS_JSON?: string;
};
