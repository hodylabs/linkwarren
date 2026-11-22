-- Click analytics: daily rollups of the Analytics Engine data (kept beyond its 90-day retention) and the rollup watermark.
-- analytics_state holds 'rolled_through' (the last UTC day written to D1); later days are read live from Analytics Engine.

CREATE TABLE clicks_daily (
  day TEXT NOT NULL, link_id TEXT NOT NULL, domain_id TEXT NOT NULL, slug TEXT NOT NULL,
  qr INTEGER NOT NULL DEFAULT 0, typed INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, link_id));
CREATE INDEX clicks_daily_domain ON clicks_daily(domain_id, day);
CREATE TABLE clicks_daily_dim (
  day TEXT NOT NULL, link_id TEXT NOT NULL, domain_id TEXT NOT NULL,
  dim TEXT NOT NULL CHECK(dim IN ('country','device','referrer')), value TEXT NOT NULL,
  clicks INTEGER NOT NULL, PRIMARY KEY(day, link_id, dim, value));
CREATE INDEX clicks_daily_dim_domain ON clicks_daily_dim(domain_id, day);
CREATE TABLE analytics_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
