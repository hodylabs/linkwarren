-- A link moved during a day keeps each domain's clicks apart: the daily rollups key on (day, link, domain), not (day, link).
-- SQLite cannot change a primary key in place, so both tables are rebuilt; the existing rows carry over unchanged.

CREATE TABLE clicks_daily_new (
  day TEXT NOT NULL, link_id TEXT NOT NULL, domain_id TEXT NOT NULL, slug TEXT NOT NULL,
  qr INTEGER NOT NULL DEFAULT 0, typed INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, link_id, domain_id));
INSERT INTO clicks_daily_new (day, link_id, domain_id, slug, qr, typed, bots, visitors)
  SELECT day, link_id, domain_id, slug, qr, typed, bots, visitors FROM clicks_daily;
DROP TABLE clicks_daily;
ALTER TABLE clicks_daily_new RENAME TO clicks_daily;
CREATE INDEX clicks_daily_domain ON clicks_daily(domain_id, day);

CREATE TABLE clicks_daily_dim_new (
  day TEXT NOT NULL, link_id TEXT NOT NULL, domain_id TEXT NOT NULL,
  dim TEXT NOT NULL CHECK(dim IN ('country','device','referrer')), value TEXT NOT NULL,
  clicks INTEGER NOT NULL, PRIMARY KEY(day, link_id, domain_id, dim, value));
INSERT INTO clicks_daily_dim_new (day, link_id, domain_id, dim, value, clicks)
  SELECT day, link_id, domain_id, dim, value, clicks FROM clicks_daily_dim;
DROP TABLE clicks_daily_dim;
ALTER TABLE clicks_daily_dim_new RENAME TO clicks_daily_dim;
CREATE INDEX clicks_daily_dim_domain ON clicks_daily_dim(domain_id, day);
