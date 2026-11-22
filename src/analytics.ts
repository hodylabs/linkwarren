import { aeConfigured, AeError, aeReport, type DayRow, type DimCount, type LinkRow, type Scope, type Unit } from "./ae";
import { utcDay } from "./clicks";
import { rolledThrough } from "./cron";
import type { Env } from "./env";
import { usableDomainsSql } from "./perm";
import type { UserRow } from "./types";

/**
 * Report builder. One report reads the current window and the window before it in a single pass (they are
 * adjacent), so it costs 6 Analytics Engine queries per id chunk (one aeReport; 2 chunks for R5's 500 link ids, so
 * 12) and 4 D1 calls (usable ids, link search, watermark, one batch of up to 3 GROUP BY rollup selects). Both sides
 * are summed in SQL: the Worker gets buckets + links + dim values rows, never buckets x links.
 */

export type RangeQuery = { range: "1" | "7" | "30" | "90" | "custom"; from?: string; to?: string };
export type Range = { from: Date; to: Date; unit: Unit; prev: { from: Date; to: Date } | null };
export type Live = "ok" | "off" | "unavailable";
type Count = { value: string; clicks: number };
export type AnalyticsReport = {
  from: string; to: string; unit: Unit; live: Live; truncated: boolean;
  totals: { clicks: number; qr: number; typed: number; bots: number; visitors: number | null; prevClicks: number | null };
  series: { bucket: string; qr: number; typed: number }[];
  links: { linkId: string; domainId: string; host: string; slug: string; clicks: number }[];
  domains: { domainId: string; host: string; clicks: number }[];
  countries: Count[]; devices: Count[]; referrers: Count[];
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_SPAN_DAYS = 366;
const MAX_LINKS = 500; // R5
const TOP_LINKS = 50;
const AE_DAYS = 90; // raw retention

const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);
const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
/** Same keys as ae.ts buckets: `YYYY-MM-DD` (day) or `YYYY-MM-DDTHH:00:00Z` (hour). */
const bucketKey = (d: Date, unit: Unit) => (unit === "day" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 13) + ":00:00Z");

function realDay(v: string | undefined): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = dayStart(v);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? d : null; // rejects 2026-02-30
}

export function resolveRange(q: RangeQuery, nowSec: number): Range | { error: "bad_range" } {
  const today = dayStart(utcDay(nowSec));
  const tomorrow = addMs(today, DAY_MS);
  const back = (from: Date, to: Date) => ({ from: addMs(from, from.getTime() - to.getTime()), to: from });
  if (q.range === "1") {
    const to = new Date(Math.floor((nowSec * 1000) / HOUR_MS) * HOUR_MS + HOUR_MS);
    const from = addMs(to, -24 * HOUR_MS);
    return { from, to, unit: "hour", prev: back(from, to) };
  }
  if (q.range === "custom") {
    const f = realDay(q.from);
    const t = realDay(q.to);
    if (!f || !t || f > t || t > today) return { error: "bad_range" };
    const to = addMs(t, DAY_MS);
    if ((to.getTime() - f.getTime()) / DAY_MS > MAX_SPAN_DAYS) return { error: "bad_range" };
    return { from: f, to, unit: "day", prev: back(f, to) };
  }
  const n = Number(q.range);
  if (![7, 30, 90].includes(n)) return { error: "bad_range" };
  const from = addMs(tomorrow, -n * DAY_MS);
  return { from, to: tomorrow, unit: "day", prev: back(from, tomorrow) };
}

const ids = (r: { results: Record<string, unknown>[] }) => r.results.map((x) => String(x.id));

export async function resolveScope(
  env: Env, user: UserRow, domainIds: string[] | null, q: string,
): Promise<{ scope: Scope; truncated: boolean } | { error: "forbidden" }> {
  let scopeDomains: string[] | null = null;
  if (domainIds || user.role !== "owner") {
    const usable = new Set(ids(await env.DB.prepare(usableDomainsSql).bind(user.id).all()));
    if (domainIds) {
      if (domainIds.some((id) => !usable.has(id))) return { error: "forbidden" };
      scopeDomains = domainIds;
    } else scopeDomains = [...usable];
  }
  const text = q.trim();
  if (!text) return { scope: { domainIds: scopeDomains, linkIds: null }, truncated: false };
  // R5: free text stays in D1 as one LIKE bind; only the matching link ids go on to Analytics Engine.
  const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
  const inDomains = scopeDomains ? " AND d.id IN (SELECT value FROM json_each(?))" : "";
  const binds: unknown[] = scopeDomains ? [like, JSON.stringify(scopeDomains)] : [like];
  const found = ids(
    await env.DB.prepare(
      `SELECT l.id FROM links l JOIN domains d ON d.id = l.domain_id WHERE (d.host || '/' || l.slug) LIKE ? ESCAPE '\\'${inDomains} ORDER BY l.id LIMIT ${MAX_LINKS + 1}`,
    ).bind(...binds).all(),
  );
  return { scope: { domainIds: scopeDomains, linkIds: found.slice(0, MAX_LINKS) }, truncated: found.length > MAX_LINKS };
}

/** ` AND col IN (...)` as one json_each bind; "" when unfiltered. */
function scopeSql(scope: Scope, binds: unknown[]): string {
  let s = "";
  for (const [col, list] of [["domain_id", scope.domainIds], ["link_id", scope.linkIds]] as const) {
    if (!list) continue;
    s += ` AND ${col} IN (SELECT value FROM json_each(?))`;
    binds.push(JSON.stringify(list));
  }
  return s;
}

export type { DayRow, DimCount, LinkRow } from "./ae";
export type ReportRows = { days: DayRow[]; links: LinkRow[]; dims: DimCount[]; live: Live };

/**
 * D1 rollups, summed in SQL so the Worker gets at most (days + links + dim values) rows, never days x links.
 * Every statement filters on `day` first (the `(day, link_id)` primary key, or `(domain_id, day)` when the scope
 * names domains), so D1 reads only the rows inside the window and scope.
 */
async function d1Rows(env: Env, first: string, cur: string, end: string, scope: Scope) {
  const where = (from: string): [string, unknown[]] => {
    const b: unknown[] = [from, end];
    return [`WHERE day >= ? AND day <= ?${scopeSql(scope, b)}`, b];
  };
  const [wAll, bAll] = where(first);
  const stmts = [
    env.DB.prepare(`SELECT day AS bucket, SUM(qr) AS qr, SUM(typed) AS typed, SUM(bots) AS bots, SUM(visitors) AS visitors FROM clicks_daily ${wAll} GROUP BY day`).bind(...bAll),
  ];
  if (cur <= end) {
    const [wCur, bCur] = where(cur);
    stmts.push(
      // SQLite bare column: `slug` comes from the row with MAX(day), so a renamed link shows its latest slug.
      env.DB.prepare(`SELECT link_id AS linkId, domain_id AS domainId, slug, MAX(day) AS lastDay, SUM(qr + typed) AS clicks FROM clicks_daily ${wCur} GROUP BY link_id, domain_id`).bind(...bCur),
      env.DB.prepare(`SELECT dim, value, SUM(clicks) AS clicks FROM clicks_daily_dim ${wCur} GROUP BY dim, value`).bind(...bCur),
    );
  }
  const [days, links, dims] = await env.DB.batch(stmts);
  return { days: days.results as DayRow[], links: (links?.results ?? []) as LinkRow[], dims: (dims?.results ?? []) as DimCount[] };
}

/** Error name or fixed code only: a message could carry data. */
const errCode = (e: unknown) =>
  e instanceof AeError || (e instanceof Error && e.message === "bad_sql_id") ? e.message : e instanceof Error ? e.name : "unknown";

/**
 * Reads the whole report span (prev window + current window, they are adjacent) in one pass.
 * Hourly: Analytics Engine only. Daily: days up to the rollup watermark from D1, later days (within AE's
 * 90-day retention) from AE, so no day is read twice (R3). Any AE failure keeps the D1 rows (R9).
 */
export async function loadRows(env: Env, range: Range, scope: Scope, nowSec = Math.floor(Date.now() / 1000)): Promise<ReportRows> {
  const { unit } = range;
  const start = range.prev?.from ?? range.from;
  const curK = bucketKey(range.from, unit);
  const days = new Map<string, DayRow>();
  const links = new Map<string, LinkRow>();
  const dims = new Map<string, DimCount>();
  const addDay = (r: DayRow) => {
    const d = days.get(r.bucket) ?? { bucket: r.bucket, qr: 0, typed: 0, bots: 0, visitors: 0 };
    d.qr += r.qr; d.typed += r.typed; d.bots += r.bots; d.visitors += r.visitors;
    days.set(r.bucket, d);
  };
  const addLink = (r: LinkRow) => {
    const l = links.get(r.linkId) ?? { linkId: r.linkId, domainId: r.domainId, slug: "", clicks: 0 };
    l.clicks += r.clicks;
    if (r.slug) l.slug = r.slug; // AE rows come after D1 rows, so the newest slug wins
    links.set(r.linkId, l);
  };
  const addDim = (r: DimCount) => {
    const k = `${r.dim}|${r.value}`;
    const c = dims.get(k) ?? { dim: r.dim, value: r.value, clicks: 0 };
    c.clicks += r.clicks;
    dims.set(k, c);
  };
  const out = (live: Live): ReportRows => ({ days: [...days.values()], links: [...links.values()], dims: [...dims.values()], live });

  let aeFrom = start;
  if (unit === "day") {
    const w = await rolledThrough(env);
    const first = bucketKey(start, "day");
    const last = bucketKey(addMs(range.to, -DAY_MS), "day");
    if (w && w >= first) {
      const d1 = await d1Rows(env, first, curK, w < last ? w : last, scope);
      d1.days.forEach(addDay);
      d1.links.forEach((r) => addLink({ linkId: r.linkId, domainId: r.domainId, slug: r.slug, clicks: r.clicks }));
      d1.dims.forEach(addDim);
      aeFrom = addMs(dayStart(w), DAY_MS);
    }
    const floor = addMs(dayStart(utcDay(nowSec)), -(AE_DAYS - 1) * DAY_MS);
    if (aeFrom < floor) aeFrom = floor;
  }
  if (!aeConfigured(env)) return out("off");
  if (aeFrom >= range.to) return out("ok");
  let live: Awaited<ReturnType<typeof aeReport>>;
  try {
    live = await aeReport(env, aeFrom, range.from, range.to, unit, scope);
  } catch (e) {
    // R9: any AE-layer failure (an AeError, or sqlId's bad_sql_id on an odd stored id) degrades, never a 500.
    console.error("analytics live read failed", errCode(e));
    return out(e instanceof AeError && e.message === "ae_off" ? "off" : "unavailable");
  }
  const aeK = bucketKey(aeFrom, unit); // keep the seam exact even if AE answers outside the bounds
  for (const r of live.days) if (r.bucket >= aeK) addDay(r);
  live.links.forEach(addLink); // aeReport reads links and dims from max(aeFrom, range.from), after the seam
  live.dims.forEach(addDim);
  return out("ok");
}

const desc = <T extends { clicks: number }>(m: Map<string, T>) => [...m.values()].filter((x) => x.clicks > 0).sort((a, b) => b.clicks - a.clicks);

/** Pure: turns the loaded rows into the report. `hosts` maps domain id to host (a missing id gives ""). */
export function buildReport(range: Range, rows: ReportRows, hosts: Map<string, string>, opts: { truncated: boolean; visitors: boolean }): AnalyticsReport {
  const { unit } = range;
  const step = unit === "day" ? DAY_MS : HOUR_MS;
  const fromK = bucketKey(range.from, unit);
  const series = new Map<string, { bucket: string; qr: number; typed: number }>();
  for (let d = range.from; d < range.to; d = addMs(d, step)) series.set(bucketKey(d, unit), { bucket: bucketKey(d, unit), qr: 0, typed: 0 });

  const totals = { qr: 0, typed: 0, bots: 0, visitors: 0 };
  const prevK = range.prev ? bucketKey(range.prev.from, unit) : null;
  let prev = 0;
  for (const r of rows.days) {
    if (prevK && r.bucket >= prevK && r.bucket < fromK) prev += r.qr + r.typed;
    const s = series.get(r.bucket);
    if (!s) continue;
    s.qr += r.qr;
    s.typed += r.typed;
    totals.qr += r.qr;
    totals.typed += r.typed;
    totals.bots += r.bots;
    // Daily views follow R2 (sum of per-link per-day distinct visitors). In the 24-hour view AE counts distinct
    // visitors per hour, so in the 24-hour view a person who returns in a later hour counts again.
    totals.visitors += r.visitors;
  }
  const links = new Map<string, AnalyticsReport["links"][number]>();
  const domains = new Map<string, AnalyticsReport["domains"][number]>();
  for (const r of rows.links) {
    const host = hosts.get(r.domainId) ?? "";
    const l = links.get(r.linkId) ?? { linkId: r.linkId, domainId: r.domainId, host, slug: "", clicks: 0 };
    l.clicks += r.clicks;
    if (r.slug) l.slug = r.slug;
    links.set(r.linkId, l);
    const d = domains.get(r.domainId) ?? { domainId: r.domainId, host, clicks: 0 };
    d.clicks += r.clicks;
    domains.set(r.domainId, d);
  }
  const by = { country: new Map<string, Count>(), device: new Map<string, Count>(), referrer: new Map<string, Count>() };
  for (const r of rows.dims) {
    const m = by[r.dim];
    const c = m.get(r.value) ?? { value: r.value, clicks: 0 };
    c.clicks += r.clicks;
    m.set(r.value, c);
  }
  return {
    from: fromK,
    to: bucketKey(addMs(range.to, -step), unit),
    unit,
    live: rows.live,
    truncated: opts.truncated,
    totals: {
      clicks: totals.qr + totals.typed, qr: totals.qr, typed: totals.typed, bots: totals.bots,
      visitors: opts.visitors ? totals.visitors : null,
      prevClicks: range.prev && prev > 0 ? prev : null,
    },
    series: [...series.values()],
    links: desc(links).slice(0, TOP_LINKS),
    domains: desc(domains),
    countries: desc(by.country),
    devices: desc(by.device),
    referrers: desc(by.referrer),
  };
}
