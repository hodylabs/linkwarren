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
export type TotRow = { bucket: string; domainId: string; linkId: string; slug: string; qr: number; typed: number; bots: number; visitors: number };
export type DimRow = { bucket: string; domainId: string; linkId: string; dim: "country" | "device" | "referrer"; value: string; clicks: number };
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

export const aeConfigured = (env: Env): boolean =>
  !!trim(env.CF_ACCOUNT_ID) && !!trim(env.AE_READ_TOKEN) && DATASET_RE.test(dataset(env));

export async function aeQuery(env: Env, sql: string, params: Params): Promise<Record<string, unknown>[]> {
  if (!aeConfigured(env)) throw new AeError("off");
  let res: Response;
  try {
    res = await fetch(SQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${trim(env.AE_READ_TOKEN)}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AeError((e as Error)?.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new AeError(String(res.status));
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(json?.data)) throw new AeError("bad_response");
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
const SQL_OVERHEAD = 1000; // select, group by and fixed where terms of the longest statement

/**
 * Split ids so each statement stays under MAX_SQL, given the other id clause already in it. Chunks partition the ids,
 * so rows from different chunks never overlap and can simply be concatenated. Worst case (R5: 500 link ids, 17-18
 * bytes per term) is 2 chunks, i.e. 10 queries per report and 2 for the sparkline, far under 50 Free subrequests.
 */
function chunkIds(ids: string[], col: string, otherClauseLen: number): string[][] {
  const budget = MAX_SQL - SQL_OVERHEAD - otherClauseLen;
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const id of ids) {
    const term = ` OR ${col} = $l${cur.length}`.length;
    if (cur.length && len + term > budget) (chunks.push(cur), (cur = []), (len = 0));
    cur.push(id);
    len += ` OR ${col} = $l${cur.length - 1}`.length;
  }
  if (cur.length) chunks.push(cur);
  if (budget < 64) throw new AeError("too_large");
  return chunks;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** `2026-11-19 13:00:00` / ISO / bare date to `YYYY-MM-DD` (day) or `YYYY-MM-DDTHH:00:00Z` (hour). */
function bucketOf(v: unknown, unit: Unit): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}))?/.exec(String(v ?? ""));
  if (!m || (unit === "hour" && !m[2])) throw new AeError("bad_response");
  return unit === "day" ? m[1] : `${m[1]}T${m[2]}:00:00Z`;
}

const num = (v: unknown) => Math.round(Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));

export async function aeAggregate(env: Env, from: Date, to: Date, unit: Unit, scope: Scope): Promise<{ tot: TotRow[]; dims: DimRow[] }> {
  if (scope.domainIds?.length === 0 || scope.linkIds?.length === 0) return { tot: [], dims: [] };
  const params: Params = { account: trim(env.CF_ACCOUNT_ID) ?? "", from: iso(from), to: iso(to), human: "human", typed: "typed", none: "" };
  const base = "WHERE accountTag = $account AND timestamp >= $from AND timestamp < $to" + idClause("blob1", "d", scope.domainIds, params);
  const b = unit === "day" ? "toStartOfDay(timestamp)" : "toStartOfHour(timestamp)";
  const ds = `events.analyticsEngine."${dataset(env)}"`; // validated by aeConfigured inside aeQuery
  const keys = `${b} AS bucket, blob1 AS domainId, blob2 AS linkId`;
  const group = `GROUP BY ${b}, blob1, blob2`;
  const human = " AND blob8 = $human";
  const chunks = scope.linkIds ? chunkIds(scope.linkIds, "blob2", base.length) : [null];

  const runChunk = (links: string[] | null) => {
    const p: Params = { ...params };
    const where = base + idClause("blob2", "l", links, p);
    const q = (select: string, extra: string, groupMore: string) => aeQuery(env, `SELECT ${keys}, ${select} FROM ${ds} ${where}${extra} ${group}${groupMore}`, p);
    const dim = (col: string, extra: string) => q(`${col} AS value, COUNT(*) AS n`, extra, `, ${col}`);
    return Promise.all([
      q("blob3 AS slug, blob7 AS source, blob8 AS kind, COUNT(*) AS n", "", ", blob3, blob7, blob8"),
      q("COUNT(DISTINCT blob9) AS n", `${human} AND blob9 != $none`, ""),
      dim("blob4", human),
      dim("blob5", human),
      dim("blob6", `${human} AND blob7 = $typed`),
    ]);
  };
  const parts = await Promise.all(chunks.map(runChunk));
  const [tots, vis, country, device, referrer] = [0, 1, 2, 3, 4].map((i) => parts.flatMap((p) => p[i]));

  const tot = new Map<string, TotRow>();
  const row = (r: Record<string, unknown>) => {
    const bucket = bucketOf(r.bucket, unit);
    const linkId = str(r.linkId);
    const k = `${bucket}|${linkId}`;
    let t = tot.get(k);
    if (!t) tot.set(k, (t = { bucket, domainId: str(r.domainId), linkId, slug: "", qr: 0, typed: 0, bots: 0, visitors: 0 }));
    return t;
  };
  for (const r of tots) {
    const t = row(r);
    if (r.slug != null && r.slug !== "") t.slug = str(r.slug);
    const n = num(r.n);
    if (r.kind === "bot" || r.kind === "preview") t.bots += n;
    else if (r.kind === "human" && r.source === "qr") t.qr += n;
    else if (r.kind === "human" && r.source === "typed") t.typed += n;
  }
  for (const r of vis) row(r).visitors += num(r.n);

  const dims: DimRow[] = [];
  for (const [name, rows] of [["country", country], ["device", device], ["referrer", referrer]] as const)
    for (const r of rows)
      dims.push({ bucket: bucketOf(r.bucket, unit), domainId: str(r.domainId), linkId: str(r.linkId), dim: name, value: str(r.value), clicks: num(r.n) });

  const sorted = [...tot.values()].sort((a, c) => (a.bucket === c.bucket ? (a.linkId < c.linkId ? -1 : 1) : a.bucket < c.bucket ? -1 : 1));
  return { tot: sorted, dims };
}

/** Human clicks per link and UTC day for the Links sparkline: one query per id chunk (see chunkIds), ids validated and bound. */
export async function aeLinkDays(env: Env, from: Date, to: Date, linkIds: string[]): Promise<{ bucket: string; linkId: string; qr: number; typed: number }[]> {
  if (linkIds.length === 0) return [];
  const ds = `events.analyticsEngine."${dataset(env)}"`; // validated by aeConfigured inside aeQuery
  const rows = (
    await Promise.all(
      chunkIds(linkIds, "blob2", 0).map((ids) => {
        const params: Params = { account: trim(env.CF_ACCOUNT_ID) ?? "", from: iso(from), to: iso(to), human: "human" };
        const where = "WHERE accountTag = $account AND timestamp >= $from AND timestamp < $to AND blob8 = $human" + idClause("blob2", "l", ids, params);
        return aeQuery(env, `SELECT toStartOfDay(timestamp) AS bucket, blob2 AS linkId, blob7 AS source, COUNT(*) AS n FROM ${ds} ${where} GROUP BY toStartOfDay(timestamp), blob2, blob7`, params);
      }),
    )
  ).flat();
  return rows.map((r) => ({
    bucket: bucketOf(r.bucket, "day"),
    linkId: str(r.linkId),
    qr: r.source === "qr" ? num(r.n) : 0,
    typed: r.source === "typed" ? num(r.n) : 0,
  }));
}
