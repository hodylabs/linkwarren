-- S13 alerts: opt-in per person. One email per person per UTC day at most, so the send state (the weekly digest's claim
-- columns, by day instead of week) lives here; `secret` signs the unsubscribe link, a new one on every opt-in.
CREATE TABLE alert_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  quiet INTEGER NOT NULL DEFAULT 1 CHECK(quiet IN (0, 1)),
  spike INTEGER NOT NULL DEFAULT 1 CHECK(spike IN (0, 1)),
  secret TEXT NOT NULL,
  -- last_day: the UTC day last handled (sent, or checked with nothing to send); the cron's idempotency key.
  last_day TEXT,
  last_attempt_at INTEGER,
  try_day TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alert_prefs_enabled ON alert_prefs(enabled, last_attempt_at);

-- What each person was already told about each link: the spike's day, or the day a "gone quiet" email went out.
CREATE TABLE alert_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('quiet', 'spike')),
  last_day TEXT NOT NULL,
  PRIMARY KEY (user_id, link_id, kind)
);
-- The cascade from links looks rows up by link_id: without this index every link delete would scan the table.
CREATE INDEX alert_state_link ON alert_state(link_id);

-- S13 share page: only the SHA-256 of the token is kept. `domain_id` is the domain the share covers (a link share's domain
-- when it was made), so a link moved to another domain stops being shared.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('link', 'domain')),
  scope_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX share_links_scope ON share_links(scope, scope_id, revoked_at);
