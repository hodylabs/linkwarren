import { aeAggregate, aeConfigured, type DimRow, type TotRow } from "./ae";
import { auditStmt } from "./audit";
import { utcDay } from "./clicks";
import type { Env } from "./env";

const DAY_MS = 86_400_000;
const MAX_DAYS = 31; // R4: one AE round (5 queries) and at most 31 D1 batches per run, inside the Free plan limits
const MAX_PARAMS = 100; // D1 bound-parameter limit per statement
const AUDIT_KEEP_DAYS = 1096; // 3 years

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

/** Rolls finished UTC days from Analytics Engine into D1, oldest first. Returns the days written. */
export async function rollup(env: Env, nowSec: number): Promise<string[]> {
  if (!aeConfigured(env)) {
    console.log("analytics rollup skipped: not configured");
    return [];
  }
  const today = utcDay(nowSec);
  const yesterday = addDays(today, -1);
  const rt = await rolledThrough(env);
  const floor = addDays(today, -89);
  const start = rt && addDays(rt, 1) > floor ? addDays(rt, 1) : floor;
  const days: string[] = [];
  for (let d = start; d <= yesterday && days.length < MAX_DAYS; d = addDays(d, 1)) days.push(d);
  if (!days.length) return [];

  const last = days[days.length - 1];
  const { tot, dims } = await aeAggregate(env, new Date(`${start}T00:00:00Z`), new Date(`${addDays(last, 1)}T00:00:00Z`), "day", {
    domainIds: null,
    linkIds: null,
  });
  const byDay = <T extends { bucket: string }>(rows: T[], d: string) => rows.filter((r) => r.bucket === d);

  const written: string[] = [];
  for (const d of days) {
    const t = byDay<TotRow>(tot, d).map((r) => [d, r.linkId, r.domainId, r.slug, r.qr, r.typed, r.bots, r.visitors]);
    const x = byDay<DimRow>(dims, d).map((r) => [d, r.linkId, r.domainId, r.dim, r.value, r.clicks]);
    // Delete-then-insert per day in one batch: a re-run replaces the day, never adds to it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM clicks_daily WHERE day = ?").bind(d),
      env.DB.prepare("DELETE FROM clicks_daily_dim WHERE day = ?").bind(d),
      ...inserts(env, "INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors)", t),
      ...inserts(env, "INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks)", x),
      watermarkStmt(env, d),
    ]); // a throw stops here: later days stay in AE for the next run
    written.push(d);
  }
  return written;
}

/** Deletes audit rows older than 3 years, audited in the same batch as actor "system". */
export async function purgeAudit(env: Env, nowSec: number): Promise<number> {
  const cutoff = nowSec - AUDIT_KEEP_DAYS * 86400;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM audit_log WHERE at < ?").bind(cutoff).first<{ n: number; maxId: number | null }>();
  const n = r?.n ?? 0;
  if (!n) return 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log WHERE at < ? AND id <= ?").bind(cutoff, r!.maxId),
    auditStmt(
      env,
      { actorId: "system", action: "audit.purge", targetType: "audit", targetId: "audit_log", detail: { deleted: n, before: cutoff } },
      { sql: "changes() > 0", binds: [] },
    ),
  ]);
  return n;
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
