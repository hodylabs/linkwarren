import type { Env } from "./env";
import { sha256Hex } from "./session";

/** R6 fixed windows: n events per s seconds. */
export const LIMITS = {
  address: { n: 5, s: 900 },
  ip: { n: 20, s: 900 },
  instance: { n: 50, s: 3600 },
  failIp: { n: 20, s: 900 },
  reg: { n: 5, s: 3600 },
  regDay: { n: 50, s: 86400, utc: true },
  apiUser: { n: 120, s: 60 },
  apiKey: { n: 60, s: 60 },
  apiConn: { n: 60, s: 60 },
  apiDay: { n: 1000, s: 86400, utc: true },
  apiInstanceDay: { n: 3000, s: 86400, utc: true },
  authz: { n: 10, s: 3600 },
  /** The settings test email, instance wide. */
  mailTest: { n: 1, s: 60 },
  /** One invite email per person per minute. */
  inviteResend: { n: 1, s: 60 },
  /** KV deletes spent by bulk edits per UTC day: half the account's 1,000, the rest stays for single edits and OAuth. */
  bulkKvDay: { n: 500, s: 86400, utc: true },
} as const;
/** utc: the window is aligned to multiples of s since the epoch (s = 86400 is the UTC day) instead of starting at the first event. */
export type Limit = { n: number; s: number; utc?: boolean };

/** Windows longer than an hour: the hourly prunes keep these keys for a day (SQL on auth_limits.key). */
export const DAY_KEYS_SQL = "(key IN ('reg:day', 'api:day', 'bulk:kv') OR key LIKE 'api:ud:%')";

/** A window_start at or below this is outside the current window. */
const since = (l: Limit, now: number) => (l.utc ? now - (now % l.s) - 1 : now - l.s);

export const limitKey = {
  addr: async (email: string) => `addr:${await sha256Hex(email.toLowerCase())}`,
  ip: (prefix: string | null) => `ip:${prefix ?? "none"}`,
  opts: (prefix: string | null) => `opts:${prefix ?? "none"}`,
  fail: (prefix: string | null) => `fail:${prefix ?? "none"}`,
  inst: "inst",
  reg: (prefix: string | null) => `reg:${prefix ?? "none"}`,
  regDay: "reg:day",
  apiUser: (userId: string) => `api:u:${userId}`,
  apiKey: (keyId: string) => `api:k:${keyId}`,
  apiConn: (connId: string) => `api:c:${connId}`,
  apiDay: (userId: string) => `api:ud:${userId}`,
  /** Every /mcp tool call and /api/v1 request of the instance, per UTC day. */
  apiInstanceDay: "api:day",
  /** GET and POST /authorize per person: each consent page and approval spends KV writes. */
  authz: (userId: string) => `authz:u:${userId}`,
  mailTest: "mail:test",
  invite: (userId: string) => `invite:${userId}`,
  /** Instance KV deletes spent by bulk edits, per UTC day (LIMITS.bulkKvDay). */
  bulkKv: "bulk:kv",
} as const;

/** Counts one event in one atomic upsert (a window older than s restarts at 1); true when still within the limit. */
export async function hit(env: Env, key: string, l: Limit): Promise<boolean> {
  return (await hitCount(env, key, l)) <= l.n;
}

/** hit, returning the count after this event. */
export function hitCount(env: Env, key: string, l: Limit): Promise<number> {
  return hitBy(env, key, l, 1);
}

/** Counts n events (integer 1..1000) in one atomic upsert, same window rule as hitCount; returns the count after. */
export async function hitBy(env: Env, key: string, l: Limit, n: number): Promise<number> {
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RangeError(`hitBy: n must be an integer 1..1000, got ${n}`);
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    "INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start <= ? THEN excluded.count ELSE count + excluded.count END, window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END RETURNING count",
  ).bind(key, now, n, since(l, now), since(l, now)).first<{ count: number }>();
  return r ? r.count : Number.POSITIVE_INFINITY; // no row back: treat as over
}

/** One check of hitAll: `charge` events (default 1) on `key`; charge 0 only checks that one more event would fit. */
export type Check = { key: string; limit: Limit; charge?: number };
export type HitAll = { ok: true } | { ok: false; key: string; counts: number[] };

/**
 * Checks and charges every key of a request in one atomic statement: it writes only when every key has room
 * (count + max(charge, 1) <= n in its current window), otherwise it writes nothing. A refusal then reads the counts
 * (in checks order) to name the first key over. Keys must be distinct, and at least one check must charge.
 */
export async function hitAll(env: Env, checks: Check[]): Promise<HitAll> {
  if (new Set(checks.map((c) => c.key)).size !== checks.length) throw new RangeError("hitAll: duplicate key");
  const charges = checks.map((c) => c.charge ?? 1);
  if (charges.some((n) => !Number.isSafeInteger(n) || n < 0) || !charges.some((n) => n > 0))
    throw new RangeError("hitAll: each charge must be a whole number, and one above 0");
  const now = Math.floor(Date.now() / 1000);
  const binds = checks.flatMap((c, i) => [c.key, since(c.limit, now), c.limit.n, charges[i]]);
  // The SELECT reads auth_limits before any row is upserted (SQLite buffers an INSERT that reads its own table).
  const r = await env.DB.prepare(
    `WITH k(key, since, n, c) AS (VALUES ${checks.map(() => "(?, ?, ?, ?)").join(", ")})
     INSERT INTO auth_limits (key, window_start, count)
     SELECT key, ?, c FROM k WHERE c > 0 AND NOT EXISTS
       (SELECT 1 FROM k b JOIN auth_limits a ON a.key = b.key AND a.window_start > b.since WHERE a.count + max(b.c, 1) > b.n)
       -- A charge above a whole limit never fits, even on a key with no row in this window yet.
       AND NOT EXISTS (SELECT 1 FROM k b WHERE b.c > b.n)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= (SELECT since FROM k WHERE k.key = excluded.key) THEN excluded.count ELSE count + excluded.count END,
       window_start = CASE WHEN window_start <= (SELECT since FROM k WHERE k.key = excluded.key) THEN excluded.window_start ELSE window_start END
     RETURNING key`,
  ).bind(...binds, now).all();
  if (r.results.length) return { ok: true };
  const rows = await env.DB.prepare("SELECT key, window_start, count FROM auth_limits WHERE key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(checks.map((c) => c.key))).all<{ key: string; window_start: number; count: number }>();
  const counts = checks.map((c) => {
    const row = rows.results.find((x) => x.key === c.key);
    return row && row.window_start > since(c.limit, now) ? row.count : 0;
  });
  // A window that rolled over or a refund between the two reads leaves no key over: name the first.
  const i = checks.findIndex((c, i) => counts[i]! + Math.max(charges[i]!, 1) > c.limit.n);
  return { ok: false, key: checks[Math.max(i, 0)]!.key, counts };
}

/** Read only: true when n more events still fit the current window. Not atomic with a later hitBy; hitAll is. */
export async function fits(env: Env, key: string, l: Limit, n: number): Promise<boolean> {
  return (await windowCount(env, key, l)) + n <= l.n;
}

/** Read only: true when the current window already holds n events, so the next one would be refused. */
export async function blocked(env: Env, key: string, l: Limit): Promise<boolean> {
  return (await windowCount(env, key, l)) >= l.n;
}

/** Read only: events in the current window (0 when none). */
export async function windowCount(env: Env, key: string, l: Limit): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare("SELECT count FROM auth_limits WHERE key = ? AND window_start > ?").bind(key, since(l, now)).first<{ count: number }>();
  return r?.count ?? 0;
}

/** Best effort: gives one event back (never below 0), e.g. a reserved attempt that turned out legitimate. */
export async function refund(env: Env, key: string): Promise<void> {
  await env.DB.prepare("UPDATE auth_limits SET count = count - 1 WHERE key = ? AND count > 0").bind(key).run();
}
