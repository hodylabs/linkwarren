-- Stage 6: personal API keys, agent (OAuth) connections and the MCP tool-call log.
-- A key is stored only as the SHA-256 hex of the whole secret (hash) plus a 10-char display prefix; the secret never reaches the database.

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  domain_ids TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK(can_delete = 0 OR can_write = 1)
);
CREATE UNIQUE INDEX api_keys_active_name ON api_keys(user_id, name) WHERE revoked_at IS NULL;

CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(can_delete = 0 OR can_write = 1)
);
CREATE INDEX agent_connections_user ON agent_connections(user_id);

-- Plain rowid table (no AUTOINCREMENT, so no sqlite_sequence write per insert). Kept 90 days, pruned by the hourly cron.
-- Never arguments, results or tokens.
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  via TEXT NOT NULL,
  conn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','refused','error','rate_limited'))
);
CREATE INDEX tool_calls_conn_at ON tool_calls(conn_id, at);
CREATE INDEX tool_calls_at ON tool_calls(at); -- the hourly 90-day prune filters on `at` alone
