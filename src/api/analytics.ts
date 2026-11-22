import { Hono } from "hono";
import { z } from "zod";
import { aeAggregate, aeConfigured } from "../ae";
import { buildReport, loadRows, resolveRange, resolveScope, type RangeQuery } from "../analytics";
import { utcDay } from "../clicks";
import { rolledThrough } from "../cron";
import type { Env } from "../env";
import { usableDomainsSql } from "../perm";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const analytics = new Hono<E>();

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_MS = 86_400_000;
const idList = (max: number, min: number) =>
  z.string().transform((s) => (s === "" ? [] : s.split(","))).pipe(z.array(z.string().regex(ID)).min(min).max(max));

const query = z.strictObject({
  range: z.string().default("30"),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  domains: idList(100, 0).optional(),
  q: z.string().optional(),
});

analytics.get("/", async (c) => {
  const p = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!p.success) return c.json({ error: "bad_query" }, 400);
  const { range: r, from, to, domains, q = "" } = p.data;
  if (q.length > 48) return c.json({ error: "q_too_long" }, 400);
  const nowSec = Math.floor(Date.now() / 1000);
  const range = resolveRange({ range: r as RangeQuery["range"], from, to }, nowSec);
  if ("error" in range) return c.json({ error: "bad_range" }, 400);
  const s = await resolveScope(c.env, c.var.user, domains?.length ? domains : null, q);
  if ("error" in s) return c.json({ error: "forbidden" }, 403);
  const rows = await loadRows(c.env, range, s.scope, nowSec);
  const hosts = new Map(
    ((await c.env.DB.prepare("SELECT id, host FROM domains").all<{ id: string; host: string }>()).results).map((d) => [d.id, d.host]),
  );
  return c.json(buildReport(range, rows, hosts, { truncated: s.truncated, visitors: !!c.env.VISITOR_SALT?.trim() }));
});

const linksQuery = z.strictObject({ ids: idList(50, 1) });

/** Per-link 7-day counts for the Links sparkline: D1 rollups up to the watermark, Analytics Engine after it. */
analytics.get("/links", async (c) => {
  const p = linksQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!p.success) return c.json({ error: "bad_query" }, 400);
  const asked = [...new Set(p.data.ids)];
  const env = c.env;
  const found = (await env.DB.prepare("SELECT id, domain_id FROM links WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(asked)).all<{ id: string; domain_id: string }>()).results;
  const usable = new Set((await env.DB.prepare(usableDomainsSql).bind(c.var.user.id).all<{ id: string }>()).results.map((d) => d.id));
  if (found.some((l) => !usable.has(l.domain_id))) return c.json({ error: "forbidden" }, 403);
  const linkIds = found.map((l) => l.id);

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
    const b = JSON.stringify(linkIds);
    const [t, d] = await env.DB.batch([
      env.DB.prepare("SELECT day, link_id AS id, qr, typed FROM clicks_daily WHERE day >= ? AND day <= ? AND link_id IN (SELECT value FROM json_each(?))").bind(days[0], last, b),
      env.DB.prepare("SELECT link_id AS id, value, SUM(clicks) AS n FROM clicks_daily_dim WHERE dim = 'country' AND day >= ? AND day <= ? AND link_id IN (SELECT value FROM json_each(?)) GROUP BY link_id, value").bind(days[0], last, b),
    ]);
    for (const r of t.results as { day: string; id: string; qr: number; typed: number }[]) add(r.id, r.day, r.qr, r.typed);
    for (const r of d.results as { id: string; value: string; n: number }[]) addCountry(r.id, r.value, r.n);
    aeFrom = new Date(Date.parse(`${w}T00:00:00Z`) + DAY_MS);
  }
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS);
  if (aeFrom < end && linkIds.length && aeConfigured(env)) {
    try {
      const live = await aeAggregate(env, aeFrom, end, "day", { domainIds: null, linkIds });
      for (const r of live.tot) add(r.linkId, r.bucket, r.qr, r.typed);
      for (const r of live.dims) if (r.dim === "country") addCountry(r.linkId, r.value, r.clicks);
    } catch (e) {
      console.error("analytics links live read failed", e instanceof Error ? e.name : "unknown"); // degrade to D1 only
    }
  }
  const items = linkIds.map((linkId) => {
    const a = acc.get(linkId)!;
    const top = [...a.countries].filter(([v]) => v).sort((x, y) => y[1] - x[1])[0];
    return { linkId, days: a.days, clicks: a.days.reduce((x, y) => x + y, 0), qr: a.qr, topCountry: top ? top[0] : null };
  });
  return c.json({ items });
});
