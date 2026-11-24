-- S14: Google, GitHub and generic OIDC sign-in (app mode). Client secrets live in settings as `secret.<NAME>` (src/secrets.ts).

-- One row per started sign-in. id_hash is the SHA-256 of the state cookie secret; the row is claimed once (used_at).
CREATE TABLE sso_states (
  id_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','github','oidc')),
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  next TEXT NOT NULL DEFAULT '/',
  ip_prefix TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX sso_states_expires ON sso_states(expires_at);

-- A person's provider account, matched on (provider, subject) after the first sign-in, never on the email alone.
CREATE TABLE sso_identities (
  provider TEXT NOT NULL CHECK(provider IN ('google','github','oidc')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);

-- Per email domain: auto-join role (NULL = no auto-join, never the owner role) and SSO enforcement.
-- Deleting a role an auto-join uses turns that auto-join off instead of failing the delete.
CREATE TABLE email_domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  join_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL CHECK(join_role_id IS NULL OR join_role_id != 'owner'),
  enforce_sso INTEGER NOT NULL DEFAULT 0 CHECK(enforce_sso IN (0,1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- sessions.method gains the three providers: SQLite cannot change a CHECK, so rebuild the table (0004 is its only
-- definition; no later migration adds columns, indexes or triggers on it, and no table references it).
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('email','passkey','google','github','oidc')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT,
  ip_prefix TEXT
);
INSERT INTO sessions_new (id, token_hash, user_id, method, created_at, last_seen_at, expires_at, device, ip_prefix)
  SELECT id, token_hash, user_id, method, created_at, last_seen_at, expires_at, device, ip_prefix FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
