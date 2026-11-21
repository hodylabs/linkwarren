CREATE TABLE domain_cf (
  domain_id TEXT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('outside','account','manual')),
  zone_id TEXT,
  dns_record_id TEXT,
  route_id TEXT,
  hostname_id TEXT,
  dns TEXT NOT NULL DEFAULT 'unknown' CHECK(dns IN ('unknown','found','missing','wrong_target')),
  ownership TEXT NOT NULL DEFAULT 'unknown' CHECK(ownership IN ('unknown','pending','verified','failed')),
  certificate TEXT NOT NULL DEFAULT 'unknown' CHECK(certificate IN ('unknown','pending','issued','failed','not_covered')),
  errors TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  checked_at INTEGER,
  security_level TEXT,
  rate_limit INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT INTO domain_cf (domain_id, kind, updated_at) SELECT id, 'manual', created_at FROM domains;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE INDEX domains_owner_status ON domains(owner_id, status);
