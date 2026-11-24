import { AeError, aeConfigured, aeDay, aeDayDetail } from "./ae";
import { utcDay } from "./clicks";
import type { Env } from "./env";
import { DAY_KEYS_SQL } from "./limits";
import { sendDigests } from "./digest";
import { checkUpdate } from "./update";

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
export const AUDIT_KEEP_DAYS = 1096; // 3 years
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

/** R3: values kept per link, domain, dimension and day; the rest is summed into "(other)". */
export const DETAIL_TOP = 20;
const OTHER = "(other)";

export async function detailRolledThrough(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM analytics_state WHERE k = 'detail_rolled_through'").first<{ v: string }>();
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.v) ? r.v : null;
}

/** The top DETAIL_TOP values of each (link, domain, dim) and one "(other)" row for the rest (R3). */
export function capDetail<T extends { linkId: string; domainId: string; dim: string; value: string; clicks: number }>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (r.clicks <= 0) continue;
    const k = `${r.linkId}|${r.domainId}|${r.dim}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: T[] = [];
  for (const g of groups.values()) {
    // Ties break on the value, so a re-run keeps the same rows. A real "(other)" value (a UTM can say anything) joins the rest.
    g.sort((a, b) => b.clicks - a.clicks || (a.value < b.value ? -1 : 1));
    const top = g.filter((r) => r.value !== OTHER).slice(0, DETAIL_TOP);
    const rest = g.filter((r) => !top.includes(r)).reduce((n, r) => n + r.clicks, 0);
    out.push(...top);
    if (rest > 0) out.push({ ...g[0]!, value: OTHER, clicks: rest });
  }
  return out;
}

/**
 * S13 detail rollup (R2): one UTC day per run into clicks_daily_detail, with its own watermark `detail_rolled_through`, starting at
 * today-89 (days still in Analytics Engine are rolled again for the new dimensions) and stopping at today-2 like the main rollup.
 * 8 Analytics Engine queries and 3 D1 calls per run. Shares the run and daily write budgets with the main rollup (`spent`).
 * shortcut: a day whose answer is over ROW_CAP rows, or whose rows alone need more than RUN_WRITE_BUDGET writes (thousands of
 * links with many values each), is skipped, logged, and the
 * watermark moves past it, so it never blocks the days after it; that day's detail is then Analytics Engine only. Query per link
 * chunk if an instance ever reaches it.
 */
export async function rollupDetail(env: Env, nowSec: number, spent = { writes: 0 }): Promise<string | null> {
  if (!aeConfigured(env)) return null;
  const today = utcDay(nowSec);
  const rt = await detailRolledThrough(env);
  const floor = addDays(today, -89);
  const d = rt && addDays(rt, 1) > floor ? addDays(rt, 1) : floor;
  if (d > addDays(today, -2)) return null;
  let rows: Awaited<ReturnType<typeof aeDayDetail>>;
  try {
    rows = capDetail(await aeDayDetail(env, d));
  } catch (e) {
    if (!(e instanceof AeError && e.message === "ae_truncated")) {
      console.error(`analytics detail rollup failed day=${d}`, e instanceof AeError ? e.message : errName(e));
      throw e;
    }
    console.warn(`analytics detail rollup skipped day=${d}: too many rows`);
    rows = [];
  }
  const dayUsed = await writtenToday(env, today);
  const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM clicks_daily_detail WHERE day = ?").bind(d).first<{ n: number }>();
  const costOf = (n: number) => (n + (old?.n ?? 0)) * WRITES_PER_ROW + STATE_WRITES;
  if (costOf(rows.length) > RUN_WRITE_BUDGET) {
    console.warn(`analytics detail rollup skipped day=${d}: too many rows`); // could never fit one run; same shortcut as above
    rows = [];
  }
  const cost = costOf(rows.length);
  if (spent.writes + cost > RUN_WRITE_BUDGET || dayUsed + cost > DAY_WRITE_BUDGET) {
    console.log(`analytics detail rollup paused day=${d} writes=${cost} run=${spent.writes} today=${dayUsed}`);
    return null;
  }
  // Delete-then-insert in one batch with the watermark and the write counter: a re-run replaces the day, never adds to it.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM clicks_daily_detail WHERE day = ?").bind(d),
    ...inserts(env, "INSERT INTO clicks_daily_detail (day, link_id, domain_id, dim, value, clicks)", rows.map((r) => [d, r.linkId, r.domainId, r.dim, r.value, r.clicks])),
    env.DB.prepare(
      "INSERT INTO analytics_state (k, v) VALUES ('detail_rolled_through', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE excluded.v > analytics_state.v",
    ).bind(d),
    env.DB.prepare("INSERT OR REPLACE INTO analytics_state (k, v) VALUES ('rollup_writes', ?)").bind(`${today}|${dayUsed + cost}`),
  ]);
  spent.writes += cost;
  return d;
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
/** Expired rows of the sign-in and unlock tables and the 90-day MCP tool-call log; auth_limits windows are at most an hour (LIMITS.instance), except the day keys. */
const PRUNES: readonly (readonly [table: string, col: string, age: number, where?: string])[] = [
  ["auth_limits", "window_start", 3600, `NOT (${DAY_KEYS_SQL})`],
  ["auth_limits", "window_start", 86400, DAY_KEYS_SQL],
  ["login_tokens", "expires_at", 0],
  ["auth_challenges", "expires_at", 0],
  ["sessions", "expires_at", 0],
  ["tool_calls", "at", 7_776_000], // MCP tool-call log: 90 days
];

/**
 * Deletes expired rows, at most PRUNE_MAX per table and within `budget` D1 writes (WRITES_PER_ROW per deleted row,
 * counted before each DELETE). Returns the writes used. Hourly, so visitors' IP ranges in auth_limits do not linger.
 */
export async function pruneExpired(env: Env, nowSec: number, budget: number, spent = { writes: 0 }, today?: string): Promise<number> {
  const charge = today ? COUNTER_WRITES : 0; // the counter row and its key index, when this run records its writes
  let used = 0;
  for (const [table, col, age, where] of PRUNES) {
    const rows = Math.min(PRUNE_MAX, Math.floor((budget - used - charge) / WRITES_PER_ROW));
    if (rows <= 0) break;
    // D1 has no DELETE ... LIMIT: the same bounded subquery as the sign-in prune.
    const del = env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} <= ?${where ? ` AND ${where}` : ""} LIMIT ?)`).bind(nowSec - age, rows);
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

/** Hourly at :15. Every run rolls up, prunes expired rows with what is left of the run budget and sends due weekly emails; only the 00:15 UTC run purges the audit log and checks for a new release. */
export async function scheduled(c: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(c.scheduledTime / 1000);
  const spent = { writes: 0 };
  try {
    const days = await rollup(env, now, spent);
    console.log(`analytics rollup: ${days.length ? days.join(",") : "none"}`);
  } catch (e) {
    console.error("analytics rollup failed", errName(e));
  }
  // Its own step: a failing detail day never stops the main rollup (above), the cleanup or the weekly emails.
  try {
    console.log(`analytics detail rollup: ${(await rollupDetail(env, now, spent)) ?? "none"}`);
  } catch (e) {
    console.error("analytics detail rollup failed", errName(e));
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
  try {
    console.log(`weekly emails sent: ${await sendDigests(env, now)}`);
  } catch (e) {
    console.error("weekly emails failed", errName(e));
  }
  if (new Date(c.scheduledTime).getUTCHours() !== 0) return;
  try {
    console.log(`audit purge: ${await purgeAudit(env, now)}`);
  } catch (e) {
    console.error("audit purge failed", errName(e));
  }
  await checkUpdate(env, now); // catches and logs its own failures
}
