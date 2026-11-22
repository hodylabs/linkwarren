import { AeError, aeAggregate, aeConfigured, type DimRow, type TotRow } from "./ae";
import { utcDay } from "./clicks";
import type { Env } from "./env";

const DAY_MS = 86_400_000;
const MAX_DAYS = 31; // R4: one AE round (5 queries) and at most 31 D1 batches per run, inside the Free plan limits
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

/** Rolls UTC days that are at least 2 full days old (through today-2) from Analytics Engine into D1, oldest first, so late AE points for yesterday are not lost. Returns the days written. */
export async function rollup(env: Env, nowSec: number): Promise<string[]> {
  if (!aeConfigured(env)) {
    console.log("analytics rollup skipped: not configured");
    return [];
  }
  const today = utcDay(nowSec);
  const through = addDays(today, -2);
  const rt = await rolledThrough(env);
  const floor = addDays(today, -89);
  const start = rt && addDays(rt, 1) > floor ? addDays(rt, 1) : floor;
  const days: string[] = [];
  for (let d = start; d <= through && days.length < MAX_DAYS; d = addDays(d, 1)) days.push(d);
  if (!days.length) return [];

  const last = days[days.length - 1];
  // Safe code only (`ae_<code>` / error name), never the token or a response body.
  const fail = (day: string, e: unknown) => {
    console.error(`analytics rollup failed day=${day}`, e instanceof AeError ? e.message : errName(e));
    return e;
  };
  const { tot, dims } = await aeAggregate(env, new Date(`${start}T00:00:00Z`), new Date(`${addDays(last, 1)}T00:00:00Z`), "day", {
    domainIds: null,
    linkIds: null,
  }).catch((e) => {
    throw fail(start, e);
  });
  const group = <T extends { bucket: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.bucket) ?? m.set(r.bucket, []).get(r.bucket)!).push(r);
    return m;
  };
  const totBy = group<TotRow>(tot);
  const dimBy = group<DimRow>(dims);

  const written: string[] = [];
  for (const d of days) {
    const t = (totBy.get(d) ?? []).map((r) => [d, r.linkId, r.domainId, r.slug, r.qr, r.typed, r.bots, r.visitors]);
    const x = (dimBy.get(d) ?? []).map((r) => [d, r.linkId, r.domainId, r.dim, r.value, r.clicks]);
    // Delete-then-insert per day in one batch: a re-run replaces the day, never adds to it.
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM clicks_daily WHERE day = ?").bind(d),
        env.DB.prepare("DELETE FROM clicks_daily_dim WHERE day = ?").bind(d),
        ...inserts(env, "INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors)", t),
        ...inserts(env, "INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks)", x),
        watermarkStmt(env, d),
      ]);
    } catch (e) {
      throw fail(d, e); // stops here: later days stay in AE for the next run
    }
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

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown"); // name only: messages could carry data

export async function scheduled(c: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(c.scheduledTime / 1000);
  try {
    const days = await rollup(env, now);
    console.log(`analytics rollup: ${days.length ? days.join(",") : "none"}`);
  } catch (e) {
    console.error("analytics rollup failed", errName(e));
  }
  try {
    console.log(`audit purge: ${await purgeAudit(env, now)}`);
  } catch (e) {
    console.error("audit purge failed", errName(e));
  }
}
