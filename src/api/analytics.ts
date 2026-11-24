import { Hono, type Context } from "hono";
import { z } from "zod";
import { aeConfigured, aeLinkDays, FILTER_DIMS, type Filter, type FilterDim } from "../ae";
import { buildReport, everyDomain, linkScope, loadDetail, loadRecent, loadRows, parseTz, resolveRange, resolveScope, type AnalyticsReport, type Range, type RangeQuery } from "../analytics";
import type { Scope } from "../ae";
import { utcDay } from "../clicks";
import { rolledThrough } from "../cron";
import type { Env } from "../env";
import { usableDomains } from "../perm";
import type { Grant } from "../principal";
import { can } from "../roles";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const analytics = new Hono<E>();

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const idList = (max: number, min: number) =>
  z.string().transform((s) => (s === "" ? [] : s.split(","))).pipe(z.array(z.string().regex(ID)).min(min).max(max));

const query = z.strictObject({
  range: z.string().default("30"),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  domains: idList(100, 0).optional(),
  q: z.string().optional(),
  /** S10: one link's report; refuses domains and q alongside. */
  link: z.string().regex(ID).optional(),
  /** S10 detail only: the viewer's zone (parseTz). */
  tz: z.string().max(64).optional(),
});

type Prepared = { range: Range; scope: Scope; truncated: boolean; link?: AnalyticsReport["link"]; nowSec: number };

const MAX_FILTERS = 6;
const FILTER_VALUE_MAX = 100;
/**
 * S13 `f=<dim>:<value>` (repeatable): split on the first colon, the dimension from FILTER_DIMS, at most MAX_FILTERS, each
 * dimension once, values at most FILTER_VALUE_MAX characters (an empty value is a real one: print "" is a scan with no code).
 * Anything else is null (bad_filter). The values only ever reach Analytics Engine as bound params.
 */
export function parseFilters(raw: string[]): Filter[] | null {
  if (raw.length > MAX_FILTERS) return null;
  const out: Filter[] = [];
  for (const f of raw) {
    const i = f.indexOf(":");
    if (i < 0) return null;
    const dim = f.slice(0, i), value = f.slice(i + 1);
    if (!Object.hasOwn(FILTER_DIMS, dim) || [...value].length > FILTER_VALUE_MAX || out.some((x) => x.dim === dim)) return null;
    out.push({ dim: dim as FilterDim, value });
  }
  return out;
}

/**
 * Shared by the report, the detail and recent clicks: the query checked, the range resolved and the scope cut to what the caller
 * may see. `withRange` false (recent clicks, which read their own 24 hours): `range`, `from` and `to` are ignored, never refused.
 */
async function prepare(c: Context<E>, withRange = true): Promise<Prepared | Response> {
  const sp = new URL(c.req.url).searchParams;
  const filters = parseFilters(sp.getAll("f"));
  if (!filters) return c.json({ error: "bad_filter" }, 400);
  sp.delete("f");
  if (!withRange) for (const k of ["range", "from", "to"]) sp.delete(k);
  const p = query.safeParse(Object.fromEntries(sp));
  if (!p.success) return c.json({ error: "bad_query" }, 400);
  const { range: r, from, to, domains, q = "", link } = p.data;
  if (q.length > 48) return c.json({ error: "q_too_long" }, 400);
  if (link && (q || domains?.length)) return c.json({ error: "bad_query" }, 400);
  const nowSec = Math.floor(Date.now() / 1000);
  // R8: 7 days are hourly when Analytics Engine is read; without it the D1 daily rollups keep answering.
  const range = resolveRange({ range: r as RangeQuery["range"], from, to }, nowSec, aeConfigured(c.env));
  if ("error" in range) return c.json({ error: "bad_range" }, 400);
  if (link) {
    const l = await linkScope(c.env, c.var.user, link, c.var.grant.domains);
    if ("error" in l) return c.json({ error: "not_found" }, 404);
    return { range, scope: { ...l.scope, filters }, truncated: false, link: l.link, nowSec };
  }
  const s = await resolveScope(c.env, c.var.user, domains?.length ? domains : null, q, c.var.grant.domains);
  if ("error" in s) return c.json({ error: "forbidden" }, 403);
  return { range, scope: { ...s.scope, filters }, truncated: s.truncated, nowSec };
}

analytics.get("/", async (c) => {
  const p = await prepare(c);
  if (p instanceof Response) return p;
  let rows = await loadRows(c.env, p.range, p.scope, p.nowSec);
  // R9 as before R8: a failed live read of the hourly 7 days falls back to the daily 7 days, whose older days D1 still answers.
  if (rows.live === "unavailable" && p.range.unit === "hour" && p.range.to.getTime() - p.range.from.getTime() === WEEK_MS) {
    const daily = resolveRange({ range: "7" }, p.nowSec);
    if (!("error" in daily)) {
      p.range = daily;
      rows = await loadRows(c.env, daily, p.scope, p.nowSec);
    }
  }
  const hosts = new Map(
    ((await c.env.DB.prepare("SELECT id, host FROM domains").all<{ id: string; host: string }>()).results).map((d) => [d.id, d.host]),
  );
  const report = buildReport(p.range, rows, hosts, { truncated: p.truncated, visitors: !!c.env.VISITOR_SALT?.trim() });
  // S12: the top links' names (only the ones set), so Top links can show them; one read for at most TOP_LINKS ids. Only for a
  // link whose current domain is in the reader's scope: a link moved to a domain they cannot use keeps its old address, never its name.
  if (report.links.length) {
    const dom = p.scope.domainIds;
    const named = new Map((await c.env.DB.prepare(
      `SELECT id, name FROM links WHERE name IS NOT NULL AND id IN (SELECT value FROM json_each(?))${dom ? " AND domain_id IN (SELECT value FROM json_each(?))" : ""}`,
    ).bind(JSON.stringify(report.links.map((l) => l.linkId)), ...(dom ? [JSON.stringify(dom)] : [])).all<{ id: string; name: string }>()).results.map((r) => [r.id, r.name]));
    report.links = report.links.map((l) => (named.has(l.linkId) ? { ...l, name: named.get(l.linkId)! } : l));
  }
  return c.json(p.link ? { ...report, link: p.link } : report);
});

/** S10: OS, browser, language, place and busiest hours, from Analytics Engine only (the last 90 days at most). */
analytics.get("/detail", async (c) => {
  const tz = parseTz(new URL(c.req.url).searchParams.get("tz") ?? undefined);
  if (!tz) return c.json({ error: "bad_tz" }, 400);
  const p = await prepare(c);
  if (p instanceof Response) return p;
  return c.json(await loadDetail(c.env, p.range, p.scope, tz, p.nowSec));
});

/** S13: the last 50 human clicks of the last 24 hours, scoped like the report (its scope params and `f`; the range is ignored). */
analytics.get("/recent", async (c) => {
  const p = await prepare(c, false);
  if (p instanceof Response) return p;
  return c.json(await loadRecent(c.env, p.scope, p.nowSec));
});

const linksQuery = z.strictObject({ ids: idList(50, 1) });

/** Per-link 7-day counts for the Links sparkline: D1 rollups up to the watermark, Analytics Engine after it. */
export const linkStats = async (c: Context<E>) => {
  const p = linksQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!p.success) return c.json({ error: "bad_query" }, 400);
  const asked = [...new Set(p.data.ids)];
  const env = c.env;
  const found = (await env.DB.prepare("SELECT id, domain_id FROM links WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(asked)).all<{ id: string; domain_id: string }>()).results;
  const all = can(c.var.user, "analytics.all"), only = c.var.grant.domains;
  const u = all ? everyDomain(only) : usableDomains(c.var.user.id, only);
  const usable = new Set((await env.DB.prepare(u.sql).bind(...u.binds).all<{ id: string }>()).results.map((d) => d.id));
  if (found.some((l) => !usable.has(l.domain_id))) return c.json({ error: "forbidden" }, 403);
  const linkIds = found.map((l) => l.id);
  // A moved link keeps older points under the domain of the moment: only points on a usable domain count here
  // (null: every domain counts, with analytics.all and no grant restriction, so no filter and no extra AE chunks).
  const usableIds = all && !only ? null : [...usable];

  const nowSec = Math.floor(Date.now() / 1000);
  const today = utcDay(nowSec);
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  const acc = new Map(linkIds.map((id) => [id, { days: new Array<number>(7).fill(0), qr: 0, countries: new Map<string, number>() }]));
  const add = (id: string, day: string, qr: number, typed: number) => {
    const a = acc.get(id), i = days.indexOf(day);
    if (!a || i < 0) return;
    a.days[i] += qr + typed;
    a.qr += qr;
  };
  const addCountry = (id: string, v: string, n: number) => {
    const m = acc.get(id)?.countries;
    if (m) m.set(v, (m.get(v) ?? 0) + n);
  };

  let aeFrom = start;
  const w = await rolledThrough(env);
  if (w && w >= days[0]) {
    const last = w < today ? w : today;
    const dl = JSON.stringify(days.filter((d) => d <= last));
    const b = JSON.stringify(linkIds), u = usableIds && JSON.stringify(usableIds);
    // Point lookups on the (day, link_id, domain_id) primary key, not a day range (a range scans every clicked link of the
    // window). Only the country dim is read (topCountry); device and referrer rows are never touched.
    const [t, d] = await env.DB.batch([
      env.DB.prepare("SELECT day, link_id AS id, qr, typed FROM clicks_daily WHERE day IN (SELECT value FROM json_each(?1)) AND link_id IN (SELECT value FROM json_each(?2)) AND (?3 IS NULL OR domain_id IN (SELECT value FROM json_each(?3)))").bind(dl, b, u),
      env.DB.prepare("SELECT link_id AS id, value, SUM(clicks) AS n FROM clicks_daily_dim WHERE dim = 'country' AND day IN (SELECT value FROM json_each(?1)) AND link_id IN (SELECT value FROM json_each(?2)) AND (?3 IS NULL OR domain_id IN (SELECT value FROM json_each(?3))) GROUP BY link_id, value").bind(dl, b, u),
    ]);
    for (const r of t.results as { day: string; id: string; qr: number; typed: number }[]) add(r.id, r.day, r.qr, r.typed);
    for (const r of d.results as { id: string; value: string; n: number }[]) addCountry(r.id, r.value, r.n);
    aeFrom = new Date(Date.parse(`${w}T00:00:00Z`) + DAY_MS);
  }
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS);
  let live: "ok" | "off" | "unavailable" = aeConfigured(env) ? "ok" : "off";
  if (aeFrom < end && linkIds.length && live === "ok") {
    try {
      // One AE query per id chunk (clicks per link and day). topCountry comes from D1 days only; the AE days add no country.
      for (const r of await aeLinkDays(env, aeFrom, end, linkIds, usableIds)) add(r.linkId, r.bucket, r.qr, r.typed);
    } catch (e) {
      live = "unavailable";
      console.error("analytics links live read failed", e instanceof Error ? e.name : "unknown"); // degrade to D1 only
    }
  }
  const items = linkIds.map((linkId) => {
    const a = acc.get(linkId)!;
    const top = [...a.countries].filter(([v]) => v).sort((x, y) => y[1] - x[1])[0];
    return { linkId, days: a.days, clicks: a.days.reduce((x, y) => x + y, 0), qr: a.qr, topCountry: top ? top[0] : null };
  });
  return c.json({ items, live });
};
analytics.get("/links", linkStats);
