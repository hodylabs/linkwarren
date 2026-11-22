import type { Env } from "./env";

/**
 * The only module that queries click analytics. It reads the Analytics Engine dataset through the Cloudflare
 * Analytics SQL API (POST /client/v4/analytics/sql, JSON body with bound `$name` params), not the classic
 * /accounts/<id>/analytics_engine/sql endpoint, which refuses account-owned tokens.
 *
 * Dialect choices (from developers.cloudflare.com/analytics/sql-api):
 * - Counts use COUNT(*): the SQL API applies the Analytics Engine sample weights to COUNT/SUM itself, so
 *   SUM(_sample_interval) would weight twice. COUNT(DISTINCT ...) is supported on Analytics Engine datasets.
 * - Buckets use toStartOfDay / toStartOfHour (listed time-bucket functions, UTC); date_trunc is not listed.
 * - Params are strings, numbers, booleans or null only (no arrays), so an id list is `blob1 = $d0 OR blob1 = $d1 ...`.
 * Every value is a bound param; ids also pass sqlId first (defence in depth). The SQL text holds no literals.
 */

export type Unit = "day" | "hour";
export type Dim = "country" | "device" | "referrer";
/** Per-bucket totals (series, totals, prevClicks). Also the D1 report shape. */
export type DayRow = { bucket: string; qr: number; typed: number; bots: number; visitors: number };
/** Per-link human clicks over the current window. */
export type LinkRow = { linkId: string; domainId: string; slug: string; clicks: number };
/** Per (dim, value) human clicks over the current window. */
export type DimCount = { dim: Dim; value: string; clicks: number };
/** One clicks_daily row (without the day). */
export type RollTot = { linkId: string; domainId: string; slug: string; qr: number; typed: number; bots: number; visitors: number };
/** One clicks_daily_dim row (without the day). */
export type RollDim = { linkId: string; domainId: string; dim: Dim; value: string; clicks: number };
/** `null` = no filter, `[]` = match nothing. */
export type Scope = { domainIds: string[] | null; linkIds: string[] | null };
type Params = Record<string, string>;

const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATASET_RE = /^[A-Za-z0-9_]{1,64}$/;
const TIMEOUT_MS = 8000;

/** Any read failure. The message is a fixed code (ae_<status>, ae_timeout, ...), never response text or the token. */
export class AeError extends Error {
  constructor(code: string) {
    super(`ae_${code}`);
    this.name = "AeError";
  }
}

export function sqlId(v: string): string {
  if (!ID_RE.test(v)) throw new Error("bad_sql_id");
  return `'${v}'`;
}

const trim = (v: string | undefined) => v?.trim() || null;
const dataset = (env: Env) => trim(env.AE_DATASET) ?? "linkwarren_clicks";

/** Reads need the account, the read token and a valid dataset name; without the CLICKS binding nothing is recorded, so live reads are off too. */
export const aeConfigured = (env: Env): boolean =>
  !!env.CLICKS && !!trim(env.CF_ACCOUNT_ID) && !!trim(env.AE_READ_TOKEN) && DATASET_RE.test(dataset(env));

/**
 * Most rows one query may return. aeQuery appends `LIMIT ROW_CAP + 1`, so a bigger answer is detected, never
 * silently cut: more than ROW_CAP rows, a `rows` count that differs from the data, or a
 * `rows_before_limit_at_least` above it is AeError("truncated"). A dataset maximum below the LIMIT makes the API
 * reject the query (an error too), so a capped answer is never taken for a complete one.
 */
export const ROW_CAP = 2000;

export async function aeQuery(env: Env, sql: string, params: Params): Promise<Record<string, unknown>[]> {
  if (!aeConfigured(env)) throw new AeError("off");
  let res: Response;
  try {
    res = await fetch(SQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${trim(env.AE_READ_TOKEN)}`, "content-type": "application/json" },
      body: JSON.stringify({ query: `${sql} LIMIT ${ROW_CAP + 1}`, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AeError((e as Error)?.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new AeError(String(res.status));
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown; rows?: unknown; rows_before_limit_at_least?: unknown } | null;
  if (!Array.isArray(json?.data)) throw new AeError("bad_response");
  const n = json.data.length;
  const more = json.rows_before_limit_at_least;
  if (n > ROW_CAP || (typeof json.rows === "number" && json.rows !== n) || (typeof more === "number" && more > n)) throw new AeError("truncated");
  return json.data as Record<string, unknown>[];
}

/** `(col = $p0 OR col = $p1 ...)` with each id validated and bound; "" when unfiltered. */
function idClause(col: string, prefix: string, ids: string[] | null, params: Params): string {
  if (!ids) return "";
  const parts = ids.map((id, i) => {
    sqlId(id);
    params[`${prefix}${i}`] = id;
    return `${col} = $${prefix}${i}`;
  });
  return ` AND (${parts.join(" OR ")})`;
}

/** Analytics Engine caps a statement at 10 KiB; stay well under it. */
export const MAX_SQL = 8192;
const SQL_OVERHEAD = 1100; // select, group by, limit and fixed where terms of the longest statement

const BUDGET = MAX_SQL - SQL_OVERHEAD;
/** The length an id clause adds for `n` ids (` OR col = $p<i>` per id). */
const clauseLen = (col: string, prefix: string, n: number) => {
  let len = 0;
  for (let i = 0; i < n; i++) len += ` OR ${col} = $${prefix}${i}`.length;
  return len;
};

/**
 * Split ids so each clause stays under `budget` bytes. Chunks partition the ids, so rows from different chunks never
 * overlap and sum correctly. R5's 500 link ids (17-18 bytes per term) make 2 chunks.
 */
function chunkIds(all: string[], col: string, prefix: string, budget = BUDGET): string[][] {
  const ids = [...new Set(all)]; // a repeated id would be counted once per copy
  ids.forEach(sqlId); // every id checked before any chunk is sent: a bad one never leaves a partial send
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const id of ids) {
    const term = ` OR ${col} = $${prefix}${cur.length}`.length;
    if (cur.length && len + term > budget) (chunks.push(cur), (cur = []), (len = 0));
    len += ` OR ${col} = $${prefix}${cur.length}`.length;
    cur.push(id);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

type Chunk = { links: string[] | null; domains: string[] | null };
/** Both id clauses of one chunk, bound into `p`. */
const chunkClause = (c: Chunk, p: Params) => idClause("blob2", "l", c.links, p) + idClause("blob1", "d", c.domains, p);

/**
 * The id chunks of a scope. A moved link keeps its older points under the domain of the moment, so when links are named
 * the domain clause stays too: a usable link never brings in clicks from a domain the caller cannot use. With both lists,
 * the chunks are their cross product (each list partitioned), sized so one statement holds a link chunk and a domain chunk.
 */
function scopeChunks(scope: Scope): Chunk[] {
  const { linkIds, domainIds } = scope;
  if (!linkIds) return domainIds ? chunkIds(domainIds, "blob1", "d").map((domains) => ({ links: null, domains })) : [{ links: null, domains: null }];
  if (!domainIds) return chunkIds(linkIds, "blob2", "l").map((links) => ({ links, domains: null }));
  // Usually the domain clause fits in one piece and the links get the rest of the budget.
  const whole = clauseLen("blob1", "d", new Set(domainIds).size);
  const dBudget = whole <= BUDGET / 2 ? whole : BUDGET / 2;
  const ds = chunkIds(domainIds, "blob1", "d", dBudget), ls = chunkIds(linkIds, "blob2", "l", BUDGET - dBudget);
  // shortcut: past MAX_CHUNKS (6 queries each, under the 50 subrequests of Workers Free) the live part is refused as unavailable;
  // only a search by someone with hundreds of usable domains gets here.
  if (ds.length * ls.length > MAX_CHUNKS) throw new AeError("scope_too_big");
  return ls.flatMap((links) => ds.map((domains) => ({ links, domains })));
}
const MAX_CHUNKS = 6;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** `2026-11-19 13:00:00` / ISO / bare date to `YYYY-MM-DD` (day) or `YYYY-MM-DDTHH:00:00Z` (hour). */
function bucketOf(v: unknown, unit: Unit): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}))?/.exec(String(v ?? ""));
  if (!m || (unit === "hour" && !m[2])) throw new AeError("bad_response");
  return unit === "day" ? m[1] : `${m[1]}T${m[2]}:00:00Z`;
}

const num = (v: unknown) => Math.round(Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
const ds = (env: Env) => `events.analyticsEngine."${dataset(env)}"`; // validated by aeConfigured inside aeQuery
const DIMS = [["country", "blob4", ""], ["device", "blob5", ""], ["referrer", "blob6", " AND blob7 = $typed"]] as const;
// countIf takes the Analytics Engine sample weights into account, like COUNT(*).
const COUNTS = "countIf(blob8 = $human AND blob7 = $qr) AS qr, countIf(blob8 = $human AND blob7 = $typed) AS typed, countIf(blob8 != $human) AS bots";
const VISITORS = "COUNT(DISTINCT blob9) AS n";
const HUMAN = " AND blob8 = $human";
const VISITOR = " AND blob8 = $human AND blob9 != $none";

function baseParams(env: Env, from: Date, to: Date): Params {
  return { account: trim(env.CF_ACCOUNT_ID) ?? "", from: iso(from), to: iso(to), human: "human", qr: "qr", typed: "typed", none: "" };
}
const WINDOW = "WHERE accountTag = $account AND timestamp >= $from AND timestamp < $to";

/**
 * Report rows from Analytics Engine, summed by the SQL API so the Worker gets at most buckets + links + dim values
 * rows (each query at most ROW_CAP), never buckets x links. Series cover `from`..`to`; links and dims cover the
 * current window `cur`..`to` only. Per id chunk: 6 queries (series, visitors, links, 3 dims).
 * Visitors here are distinct visitor codes per bucket over the scope (per chunk), not summed per link as in D1:
 * Analytics Engine has no way to count (link, visitor) pairs per bucket without a row per link.
 */
export async function aeReport(env: Env, from: Date, cur: Date, to: Date, unit: Unit, scope: Scope): Promise<{ days: DayRow[]; links: LinkRow[]; dims: DimCount[] }> {
  if (scope.domainIds?.length === 0 || scope.linkIds?.length === 0) return { days: [], links: [], dims: [] };
  const b = unit === "day" ? "toStartOfDay(timestamp)" : "toStartOfHour(timestamp)";
  const curFrom = cur > from ? cur : from;
  const runChunk = (c: ReturnType<typeof scopeChunks>[number]) => {
    const p = baseParams(env, from, to);
    p.cur = iso(curFrom);
    const where = (start: "from" | "cur") => WINDOW.replace("$from", () => `$${start}`) + chunkClause(c, p);
    const q = (select: string, start: "from" | "cur", extra: string, group: string) => aeQuery(env, `SELECT ${select} FROM ${ds(env)} ${where(start)}${extra} GROUP BY ${group}`, p);
    const now = curFrom < to;
    return Promise.all([
      q(`${b} AS bucket, ${COUNTS}`, "from", "", b),
      q(`${b} AS bucket, ${VISITORS}`, "from", VISITOR, b),
      // Per link and domain: a link moved inside the window keeps each domain's clicks apart.
      now ? q("blob2 AS linkId, blob1 AS domainId, argMax(blob3, timestamp) AS slug, COUNT(*) AS clicks", "cur", HUMAN, "blob2, blob1") : [],
      ...DIMS.map(([, col, extra]) => (now ? q(`${col} AS value, COUNT(*) AS n`, "cur", HUMAN + extra, col) : [])),
    ]);
  };
  const parts = await Promise.all(scopeChunks(scope).map(runChunk));
  const days = new Map<string, DayRow>();
  const day = (bucket: string) => days.get(bucket) ?? days.set(bucket, { bucket, qr: 0, typed: 0, bots: 0, visitors: 0 }).get(bucket)!;
  const dims = new Map<string, DimCount>();
  const links: LinkRow[] = [];
  for (const [tot, vis, ls, ...dimRows] of parts) {
    for (const r of tot) {
      const d = day(bucketOf(r.bucket, unit));
      d.qr += num(r.qr); d.typed += num(r.typed); d.bots += num(r.bots);
    }
    for (const r of vis) day(bucketOf(r.bucket, unit)).visitors += num(r.n);
    for (const r of ls) links.push({ linkId: str(r.linkId), domainId: str(r.domainId), slug: str(r.slug), clicks: num(r.clicks) });
    dimRows.forEach((rows, i) => {
      for (const r of rows) {
        const k = `${DIMS[i][0]}|${str(r.value)}`;
        const c = dims.get(k) ?? dims.set(k, { dim: DIMS[i][0], value: str(r.value), clicks: 0 }).get(k)!;
        c.clicks += num(r.n);
      }
    });
  }
  return { days: [...days.values()], links, dims: [...dims.values()] };
}

/**
 * One UTC day for the D1 rollup, grouped by the SQL API to exactly the clicks_daily and clicks_daily_dim rows
 * (one row per link and domain; one per link, domain and dim value), so a link moved that day keeps each domain's clicks
 * under that domain. 5 queries; each answer at most ROW_CAP rows or AeError("truncated").
 */
export async function aeDay(env: Env, day: string): Promise<{ tot: RollTot[]; dims: RollDim[] }> {
  const from = new Date(`${day}T00:00:00Z`);
  const p = baseParams(env, from, new Date(from.getTime() + 86_400_000));
  const q = (select: string, extra: string, group: string) => aeQuery(env, `SELECT ${select} FROM ${ds(env)} ${WINDOW}${extra} GROUP BY ${group}`, p);
  // argMax: the newest slug of the day, so every (link, domain) is exactly one row (the clicks_daily key).
  const link = "blob2 AS linkId, blob1 AS domainId";
  const [tot, vis, ...dimRows] = await Promise.all([
    q(`${link}, argMax(blob3, timestamp) AS slug, ${COUNTS}`, "", "blob2, blob1"),
    q(`${link}, ${VISITORS}`, VISITOR, "blob2, blob1"),
    ...DIMS.map(([, col, extra]) => q(`${link}, ${col} AS value, COUNT(*) AS n`, HUMAN + extra, `blob2, blob1, ${col}`)),
  ]);
  const key = (r: Record<string, unknown>) => `${str(r.linkId)}|${str(r.domainId)}`;
  const visitors = new Map(vis.map((r) => [key(r), num(r.n)]));
  return {
    tot: tot.map((r) => ({
      linkId: str(r.linkId), domainId: str(r.domainId), slug: str(r.slug),
      qr: num(r.qr), typed: num(r.typed), bots: num(r.bots), visitors: visitors.get(key(r)) ?? 0,
    })),
    dims: dimRows.flatMap((rows, i) => rows.map((r) => ({ linkId: str(r.linkId), domainId: str(r.domainId), dim: DIMS[i][0], value: str(r.value), clicks: num(r.n) }))),
  };
}

/**
 * Human clicks per link and UTC day for the Links sparkline: one query per id chunk (see scopeChunks), ids validated and
 * bound. `domainIds` (null: any) keeps only points recorded on a domain the caller may use.
 */
export async function aeLinkDays(env: Env, from: Date, to: Date, linkIds: string[], domainIds: string[] | null = null): Promise<{ bucket: string; linkId: string; qr: number; typed: number }[]> {
  if (linkIds.length === 0 || domainIds?.length === 0) return [];
  const b = "toStartOfDay(timestamp)";
  const rows = (
    await Promise.all(
      scopeChunks({ linkIds, domainIds }).map((c) => {
        const p = baseParams(env, from, to);
        const where = WINDOW + HUMAN + chunkClause(c, p);
        return aeQuery(env, `SELECT ${b} AS bucket, blob2 AS linkId, ${COUNTS} FROM ${ds(env)} ${where} GROUP BY ${b}, blob2`, p);
      }),
    )
  ).flat();
  return rows.map((r) => ({ bucket: bucketOf(r.bucket, "day"), linkId: str(r.linkId), qr: num(r.qr), typed: num(r.typed) }));
}
