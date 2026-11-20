CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  status TEXT NOT NULL CHECK(status IN ('invited','active','disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('main','shared','private')),
  status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  bare_redirect TEXT,
  notfound_redirect TEXT,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  noindex INTEGER NOT NULL DEFAULT 1,
  reserved_extra TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE domain_members (
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(domain_id, user_id)
);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  url TEXT NOT NULL,
  redirect_code INTEGER NOT NULL DEFAULT 302 CHECK(redirect_code IN (301,302)),
  starts_at INTEGER,
  expires_at INTEGER,
  pass_query INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(domain_id, slug_key)
);
CREATE INDEX links_domain_created ON links(domain_id, created_at);

CREATE TABLE slug_locks (
  domain_id TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  locked_at INTEGER NOT NULL,
  locked_by TEXT NOT NULL,
  PRIMARY KEY(domain_id, slug_key)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  via TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log(at);
