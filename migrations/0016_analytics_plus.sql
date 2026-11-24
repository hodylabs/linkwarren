-- S13 per-print QR labels: a link can carry several labelled QR codes, each with its own marker `?lw=qr.<code>`.
-- `code` is server-generated ([a-z0-9]{6}); at most 20 labels per link (enforced by the API). Deleted with the link.
CREATE TABLE qr_labels (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  UNIQUE(link_id, code)
);

-- S13 detail rollup (R2, R3): per day, link and domain, the top 20 values per detail dimension plus "(other)", so these
-- breakdowns outlive Analytics Engine's 3 months. Kept apart from clicks_daily_dim, which the main rollup replaces per day.
-- analytics_state holds its own watermark, 'detail_rolled_through'.
CREATE TABLE clicks_daily_detail (
  day TEXT NOT NULL, link_id TEXT NOT NULL, domain_id TEXT NOT NULL,
  dim TEXT NOT NULL CHECK(dim IN ('os','browser','language','place','print','utm_source','utm_medium','utm_campaign')),
  value TEXT NOT NULL, clicks INTEGER NOT NULL,
  PRIMARY KEY(day, link_id, domain_id, dim, value));
CREATE INDEX clicks_daily_detail_domain ON clicks_daily_detail(domain_id, day);
