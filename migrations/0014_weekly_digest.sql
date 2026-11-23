-- S10 weekly email summary: opt-in per person. `secret` signs the unsubscribe link (a new one on every opt-in, so older
-- links stop working); `last_week` is the local Monday of the last week sent, the cron's idempotency key.
CREATE TABLE digest_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  tz TEXT NOT NULL,
  secret TEXT NOT NULL,
  last_week TEXT,
  -- Delivery state: attempts go oldest last_attempt_at first, so a failing address falls behind the others. `tries` counts the
  -- attempts in `try_week` (and suffixes the Idempotency-Key); `last_error` is the last outcome code (refused_<status>, gave_up, ...).
  last_attempt_at INTEGER,
  try_week TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX digest_prefs_enabled ON digest_prefs(enabled, last_attempt_at);
