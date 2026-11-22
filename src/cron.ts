import { AeError, aeConfigured, aeDay } from "./ae";
import { utcDay } from "./clicks";
import type { Env } from "./env";

const DAY_MS = 86_400_000;
export const MAX_DAYS = 3; // per hourly run: 3 x 5 AE queries and a few D1 calls; a 90-day backlog clears in about 30 hours
/**
 * D1 rows written per run (Free plan: 100,000 per day for the whole account). A day costs 3 writes per inserted row
 * (the row, its primary-key index and the domain index), 3 per row it replaces, plus 4 for the state rows; counted
 * before its batch is sent. The run stops before a day that would go over and the next hour continues.
 */
export const RUN_WRITE_BUDGET = 10_000;
/** Rollup writes per UTC day across all runs, so hourly catch-up runs leave most of the account's daily writes free. */
export const DAY_WRITE_BUDGET = 40_000;
const WRITES_PER_ROW = 3;
const STATE_WRITES = 4; // watermark and write counter, each with its primary-key index
const MAX_PARAMS = 100; // D1 bound-parameter limit per statement
const AUDIT_KEEP_DAYS = 1096; // 3 years
export const PURGE_MAX = 5000; // audit rows deleted per run, oldest first; the next run continues

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export async function rolledThrough(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM analytics_state WHERE k = 'rolled_through'").first<{ v: string }>();
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.v) ? r.v : null;
}

/** Moves the watermark forward only: a slower, older run can never pull it back. */
export const watermarkStmt = (env: Env, day: string) =>
  env.DB.prepare(
    "INSERT INTO analytics_state (k, v) VALUES ('rolled_through', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE excluded.v > analytics_state.v",
  ).bind(day);

/** Multi-row INSERTs, each at or under MAX_PARAMS bound params. */
function inserts(env: Env, head: string, rows: unknown[][]): D1PreparedStatement[] {
  if (!rows.length) return [];
  const width = rows[0].length;
  const per = Math.floor(MAX_PARAMS / width);
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const ph = `(${Array(width).fill("?").join(",")})`;
    out.push(env.DB.prepare(`${head} VALUES ${chunk.map(() => ph).join(",")}`).bind(...chunk.flat()));
  }
  return out;
}

/** `day|n`: rollup rows written so far on that UTC day (the D1 write budget). */
async function writtenToday(env: Env, today: string): Promise<number> {
  const r = await env.DB.prepare("SELECT v FROM analytics_state WHERE k = 'rollup_writes'").first<{ v: string }>();
  const [d, n] = (r?.v ?? "").split("|");
  return d === today ? Number(n) || 0 : 0;
}

/**
 * Rolls UTC days that are at least 2 full days old (through today-2, so late AE points for yesterday are not lost)
 * from Analytics Engine into D1, oldest first: at most MAX_DAYS per run, one AE round per day, inside the write
 * budgets. Returns the days written.
 */
export async function rollup(env: Env, nowSec: number, spent = { writes: 0 }): Promise<string[]> {
  if (!aeConfigured(env)) {
    console.log("analytics rollup skipped: not configured");
    return [];
  }
  const today = utcDay(nowSec);
  const through = addDays(today, -2);
  const rt = await rolledThrough(env);
  const floor = addDays(today, -88); // AE keeps about 3 months; today-89 could already be partly gone
  const start = rt && addDays(rt, 1) > floor ? addDays(rt, 1) : floor;
  const days: string[] = [];
  for (let d = start; d <= through && days.length < MAX_DAYS; d = addDays(d, 1)) days.push(d);
  if (!days.length) return [];

  // Safe code only (`ae_<code>` / error name), never the token or a response body.
  const fail = (day: string, e: unknown) => {
    console.error(`analytics rollup failed day=${day}`, e instanceof AeError ? e.message : errName(e));
    return e;
  };
  let dayUsed = await writtenToday(env, today);
  let runUsed = 0;
  const written: string[] = [];
  for (const d of days) {
    // A capped or failed answer throws here: nothing of this day is written (never a partial day).
    const { tot, dims } = await aeDay(env, d).catch((e) => {
      throw fail(d, e);
    });
    const old = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM clicks_daily WHERE day = ?1) + (SELECT COUNT(*) FROM clicks_daily_dim WHERE day = ?1) AS n",
    ).bind(d).first<{ n: number }>();
    const cost = (tot.length + dims.length + (old?.n ?? 0)) * WRITES_PER_ROW + STATE_WRITES;
    if (runUsed + cost > RUN_WRITE_BUDGET || dayUsed + cost > DAY_WRITE_BUDGET) {
      console.log(`analytics rollup paused day=${d} writes=${cost} run=${runUsed} today=${dayUsed}`);
      break; // the next run continues; a day over RUN_WRITE_BUDGET on its own never fits (see docs/deploy.md)
    }
    const t = tot.map((r) => [d, r.linkId, r.domainId, r.slug, r.qr, r.typed, r.bots, r.visitors]);
    const x = dims.map((r) => [d, r.linkId, r.domainId, r.dim, r.value, r.clicks]);
    // Delete-then-insert per day in one batch: a re-run replaces the day, never adds to it.
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM clicks_daily WHERE day = ?").bind(d),
        env.DB.prepare("DELETE FROM clicks_daily_dim WHERE day = ?").bind(d),
        ...inserts(env, "INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors)", t),
        ...inserts(env, "INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks)", x),
        watermarkStmt(env, d),
        env.DB.prepare("INSERT OR REPLACE INTO analytics_state (k, v) VALUES ('rollup_writes', ?)").bind(`${today}|${dayUsed + cost}`),
      ]);
    } catch (e) {
      throw fail(d, e); // stops here: later days stay in AE for the next run
    }
    runUsed += cost;
    spent.writes = runUsed;
    dayUsed += cost;
    written.push(d);
  }
  return written;
}

/** Deletes up to PURGE_MAX audit rows older than 3 years (oldest first by id), audited in the same batch as actor "system". */
export async function purgeAudit(env: Env, nowSec: number): Promise<number> {
  const cutoff = nowSec - AUDIT_KEEP_DAYS * 86400;
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY id LIMIT ?)").bind(cutoff, PURGE_MAX),
    // changes() is the DELETE's own count, so overlapping purges cannot overstate it; no row when nothing was deleted.
    env.DB.prepare(
      "INSERT INTO audit_log (at, actor_id, action, target_type, target_id, detail) SELECT ?, 'system', 'audit.purge', 'audit', 'audit_log', json_object('deleted', changes(), 'before', ?) WHERE changes() > 0",
    ).bind(Math.floor(Date.now() / 1000), cutoff),
  ]);
  return res[0].meta.changes;
}

export const PRUNE_MAX = 2000; // rows deleted per table per run; a backlog clears over the next runs
/** Expired rows of the sign-in and unlock tables; auth_limits windows are at most an hour (LIMITS.instance). */
const PRUNES = [
  ["auth_limits", "window_start", 3600],
  ["login_tokens", "expires_at", 0],
  ["auth_challenges", "expires_at", 0],
  ["sessions", "expires_at", 0],
] as const;

/**
 * Deletes expired rows, at most PRUNE_MAX per table and within `budget` D1 writes (WRITES_PER_ROW per deleted row,
 * counted before each DELETE). Returns the writes used. Hourly, so visitors' IP ranges in auth_limits do not linger.
 */
export async function pruneExpired(env: Env, nowSec: number, budget: number, spent = { writes: 0 }, today?: string): Promise<number> {
  const charge = today ? COUNTER_WRITES : 0; // the counter row and its key index, when this run records its writes
  let used = 0;
  for (const [table, col, age] of PRUNES) {
    const rows = Math.min(PRUNE_MAX, Math.floor((budget - used - charge) / WRITES_PER_ROW));
    if (rows <= 0) break;
    // D1 has no DELETE ... LIMIT: the same bounded subquery as the sign-in prune.
    const del = env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} <= ? LIMIT ?)`).bind(nowSec - age, rows);
    // One batch per table: a deletion and its charge to the daily counter commit together or not at all.
    const res = today ? await env.DB.batch([del, chargeStmt(env, today)]) : [await del.run()];
    const n = res[0]!.meta.changes;
    if (n > 0) used += n * WRITES_PER_ROW + charge;
    spent.writes = used; // kept per table, so writes done before a later table fails are still counted
  }
  return used;
}

const COUNTER_WRITES = 2;
/** Adds the preceding DELETE's rows (changes()) to today's `rollup_writes`; writes nothing when it deleted nothing. */
const chargeStmt = (env: Env, today: string) =>
  env.DB.prepare(
    `INSERT OR REPLACE INTO analytics_state (k, v)
     SELECT 'rollup_writes', ?1 || '|' || CAST(
       COALESCE((SELECT CAST(substr(v, instr(v, '|') + 1) AS INTEGER) FROM analytics_state WHERE k = 'rollup_writes' AND substr(v, 1, instr(v, '|') - 1) = ?1), 0)
       + changes() * ?2 + ?3 AS INTEGER)
     WHERE changes() > 0`,
  ).bind(today, WRITES_PER_ROW, COUNTER_WRITES);

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown"); // name only: messages could carry data

/** Hourly at :15. Every run rolls up, then prunes expired rows with what is left of the run budget; only the 00:15 UTC run purges the audit log. */
export async function scheduled(c: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(c.scheduledTime / 1000);
  const spent = { writes: 0 };
  try {
    const days = await rollup(env, now, spent);
    console.log(`analytics rollup: ${days.length ? days.join(",") : "none"}`);
  } catch (e) {
    console.error("analytics rollup failed", errName(e));
  }
  // Cleanup shares the rollup's daily D1 write budget; each table's deletion and its charge commit together.
  const today = utcDay(now);
  const pruned = { writes: 0 };
  try {
    const left = Math.min(RUN_WRITE_BUDGET - spent.writes, DAY_WRITE_BUDGET - (await writtenToday(env, today)));
    console.log(`expired-row cleanup writes: ${await pruneExpired(env, now, left, pruned, today)}`);
  } catch (e) {
    console.error("expired rows prune failed", errName(e));
  }
  if (new Date(c.scheduledTime).getUTCHours() !== 0) return;
  try {
    console.log(`audit purge: ${await purgeAudit(env, now)}`);
  } catch (e) {
    console.error("audit purge failed", errName(e));
  }
}
