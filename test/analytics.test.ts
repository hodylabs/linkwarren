import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReport, type DayRow, loadRows, type Range, type ReportRows, resolveRange, resolveScope } from "../src/analytics";
import type { Env } from "../src/env";
import type { UserRow } from "../src/types";

const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const NOW = Date.parse("2026-11-20T12:34:00Z") / 1000;
const ae: Env = { ...env, CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" };
const D = (s: string) => new Date(s);

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const user = (id: string, role: "owner" | "member"): UserRow => ({ id, email: `${id}@example.com`, name: null, role, status: "active", createdAt: 1, roleId: role, roleName: role, perms: [] });

/** `rows` answer the series query (bucket, qr, typed, bots); `links` the per-link query. */
function stubAe(rows: unknown[], status = 200, links: unknown[] = []) {
  const bodies: { query: string; params: Record<string, string> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SQL_URL) throw new Error("unexpected fetch");
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if (status !== 200) return new Response("no", { status });
    const q = b.query as string;
    return Response.json({ data: q.includes("AS bucket, countIf") ? rows : q.includes("blob2 AS linkId") ? links : [] });
  });
  return bodies;
}

beforeEach(async () => {
  await env.DB.batch(
    ["clicks_daily", "clicks_daily_dim", "analytics_state", "links", "slug_locks", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("resolveRange", () => {
  it('"7" (S13 R8): 168 hourly buckets ending at the current hour\'s end, prev the 168 before', () => {
    const r = resolveRange({ range: "7" }, NOW, true);
    if ("error" in r) throw new Error(r.error);
    expect([r.from.toISOString(), r.to.toISOString(), r.unit]).toEqual(["2026-11-13T13:00:00.000Z", "2026-11-20T13:00:00.000Z", "hour"]);
    expect(r.prev?.from.toISOString()).toBe("2026-11-06T13:00:00.000Z");
  });
  it('"7" without Analytics Engine: the last 7 UTC days through tomorrow 00:00, prev the 7 before', () => {
    const r = resolveRange({ range: "7" }, NOW, false);
    if ("error" in r) throw new Error(r.error);
    expect([r.from.toISOString(), r.to.toISOString(), r.unit]).toEqual(["2026-11-14T00:00:00.000Z", "2026-11-21T00:00:00.000Z", "day"]);
    expect([r.prev?.from.toISOString(), r.prev?.to.toISOString()]).toEqual(["2026-11-07T00:00:00.000Z", "2026-11-14T00:00:00.000Z"]);
  });
  it('"1": 24 hourly buckets ending at the current hour\'s end', () => {
    const r = resolveRange({ range: "1" }, NOW);
    if ("error" in r) throw new Error(r.error);
    expect([r.from.toISOString(), r.to.toISOString(), r.unit]).toEqual(["2026-11-19T13:00:00.000Z", "2026-11-20T13:00:00.000Z", "hour"]);
    expect(r.prev?.from.toISOString()).toBe("2026-11-18T13:00:00.000Z");
    const rep = buildReport(r, { days: [], links: [], dims: [], live: "ok" }, new Map(), { truncated: false, visitors: true });
    expect(rep.series).toHaveLength(24);
    expect(rep.series[23].bucket).toBe("2026-11-20T12:00:00Z");
  });
  it.each([
    ["2026-11-10", "2026-11-01"], // from after to
    ["2026-11-01", "2026-11-21"], // to in the future
    ["2025-01-01", "2026-11-20"], // over 366 days
    ["2026-02-30", "2026-03-01"], // not a real date
    ["2026-11-01", undefined], // only from
    ["2026-11-1", "2026-11-02"], // not YYYY-MM-DD
  ])("custom %s..%s is bad_range (Review Focus 5)", (from, to) => {
    expect(resolveRange({ range: "custom", from, to }, NOW)).toEqual({ error: "bad_range" });
  });
  it("custom before any data is valid and yields zero buckets", () => {
    const r = resolveRange({ range: "custom", from: "2019-01-01", to: "2019-01-31" }, NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.prev?.from.toISOString()).toBe("2018-12-01T00:00:00.000Z");
    const rep = buildReport(r, { days: [], links: [], dims: [], live: "ok" }, new Map(), { truncated: false, visitors: true });
    expect(rep.series).toHaveLength(31);
    expect(rep.series.every((s) => s.qr === 0 && s.typed === 0)).toBe(true);
    expect([rep.from, rep.to]).toEqual(["2019-01-01", "2019-01-31"]);
  });
});

describe("resolveScope", () => {
  beforeEach(async () => {
    for (const [id, role] of [["uo", "owner"], ["ua", "member"], ["ub", "member"]])
      await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, `${id}@example.com`, role);
    const dom = (id: string, host: string, type: string, owner: string) =>
      run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
    await dom("dM", "m.test", "main", "uo");
    await dom("dS", "s.test", "shared", "uo");
    await dom("dB", "b.test", "private", "ub");
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dS','ua')");
    const ln = (id: string, d: string, slug: string) =>
      run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/','uo','uo',1,1)", id, d, slug, slug);
    await ln("l1", "dM", "spring");
    await ln("l2", "dB", "spring");
    await ln("l3", "dS", "fall_100%");
  });

  it("owner, no filter: every domain (null)", async () => {
    expect(await resolveScope(env, user("uo", "owner"), null, "", null)).toEqual({ scope: { domainIds: null, linkIds: null }, truncated: false });
  });
  it("member, no filter: exactly their usable ids", async () => {
    const r = await resolveScope(env, user("ua", "member"), null, "", null);
    if ("error" in r) throw new Error(r.error);
    expect([...(r.scope.domainIds ?? [])].sort()).toEqual(["dM", "dS"]);
  });
  it("member filtering on a shared domain they lost: forbidden; unknown id: forbidden", async () => {
    expect(await resolveScope(env, user("ua", "member"), ["dS"], "", null)).toEqual({ scope: { domainIds: ["dS"], linkIds: null }, truncated: false });
    await run("DELETE FROM domain_members WHERE domain_id = 'dS' AND user_id = 'ua'");
    expect(await resolveScope(env, user("ua", "member"), ["dS"], "", null)).toEqual({ error: "forbidden" });
    expect(await resolveScope(env, user("ua", "member"), ["dM", "dB"], "", null)).toEqual({ error: "forbidden" });
    expect(await resolveScope(env, user("uo", "owner"), ["nope"], "", null)).toEqual({ error: "forbidden" });
  });
  it("q matches host/slug inside the member's domains only", async () => {
    const r = await resolveScope(env, user("ua", "member"), null, "spring", null);
    if ("error" in r) throw new Error(r.error);
    expect(r.scope.linkIds).toEqual(["l1"]);
    const o = await resolveScope(env, user("uo", "owner"), null, "spring", null);
    if ("error" in o) throw new Error(o.error);
    expect([...(o.scope.linkIds ?? [])].sort()).toEqual(["l1", "l2"]);
    expect(o.scope.domainIds).toBeNull();
  });
  it("LIKE wildcards in q are literal", async () => {
    const pct = await resolveScope(env, user("uo", "owner"), null, "%", null);
    const und = await resolveScope(env, user("uo", "owner"), null, "fall_", null);
    if ("error" in pct || "error" in und) throw new Error("forbidden");
    expect(pct.scope.linkIds).toEqual(["l3"]);
    expect(und.scope.linkIds).toEqual(["l3"]);
  });
  it("an injection attempt in q is only a LIKE bind (Review Focus 1)", async () => {
    const r = await resolveScope(env, user("uo", "owner"), null, "') OR 1=1 --", null);
    expect(r).toEqual({ scope: { domainIds: null, linkIds: [] }, truncated: false });
  });
  it("501 matches: 500 ids and truncated", async () => {
    const stmts = Array.from({ length: 501 }, (_, i) =>
      env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'dM',?,?,'https://x.com/','uo','uo',1,1)").bind(
        `m${i}`, `many${i}`, `many${i}`,
      ),
    );
    await env.DB.batch(stmts);
    const r = await resolveScope(env, user("uo", "owner"), null, "many", null);
    if ("error" in r) throw new Error(r.error);
    expect(r.scope.linkIds).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});

describe("loadRows (Review Focus 4)", () => {
  const aeRows = [
    { bucket: "2026-11-18 00:00:00", qr: 0, typed: 99, bots: 0 },
    { bucket: "2026-11-19 00:00:00", qr: 0, typed: 7, bots: 0 },
  ];
  const aeLinks = [{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 7 }];
  const seedD1 = async () => {
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-18','l1','d1','spring',0,5,0,1)");
    await run("INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks) VALUES ('2026-11-18','l1','d1','country','CA',5)");
  };
  const all = { domainIds: null, linkIds: null };
  const sum = (days: DayRow[]) => days.reduce((n, t) => n + t.qr + t.typed, 0);
  const span = (from: string, to: string, unit: "day" | "hour" = "day"): Range => ({ from: D(from), to: D(to), unit, prev: null });
  const r1820 = span("2026-11-18T00:00:00Z", "2026-11-20T00:00:00Z");

  it("days up to the watermark come from D1 only, later days from AE", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows, 200, aeLinks);
    const r = await loadRows(ae, r1820, all, NOW);
    expect(sum(r.days)).toBe(12);
    expect(r.live).toBe("ok");
    expect(r.links).toMatchObject([{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 12 }]);
    expect(r.dims).toEqual([{ dim: "country", value: "CA", clicks: 5 }]);
    expect(bodies).toHaveLength(6);
    expect(bodies.every((b) => b.params.from === "2026-11-19T00:00:00Z" && b.params.cur === "2026-11-19T00:00:00Z")).toBe(true);
  });
  it("a link that moved between the rolled days and the live ones keeps each domain's clicks apart", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    stubAe(aeRows, 200, [{ linkId: "l1", domainId: "d2", slug: "spring", clicks: 7 }]);
    const r = await loadRows(ae, r1820, all, NOW);
    expect(r.links).toEqual([{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 5, seen: "2026-11-18" }, { linkId: "l1", domainId: "d2", slug: "spring", clicks: 7, seen: "~" }]);
  });
  it("no watermark: everything in range comes from AE", async () => {
    await seedD1();
    const bodies = stubAe(aeRows);
    const r = await loadRows(ae, r1820, all, NOW);
    expect(sum(r.days)).toBe(106);
    expect(bodies[0].params.from).toBe("2026-11-18T00:00:00Z");
  });
  it("no watermark: the AE start is clamped to the today-89 floor (M6)", async () => {
    const bodies = stubAe([]);
    const r = await loadRows(ae, span("2026-07-01T00:00:00Z", "2026-11-21T00:00:00Z"), all, NOW);
    expect(r.live).toBe("ok");
    expect(bodies[0].params.from).toBe("2026-08-23T00:00:00Z");
  });
  it("watermark covers the whole range: no AE call", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-19')");
    const bodies = stubAe(aeRows);
    const r = await loadRows(ae, r1820, all, NOW);
    expect([sum(r.days), r.live, bodies.length]).toEqual([5, "ok", 0]);
  });
  it("AE failing keeps the D1 rows and says unavailable (R9)", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    stubAe(aeRows, 500);
    const r = await loadRows(ae, r1820, all, NOW);
    expect([sum(r.days), r.live]).toEqual([5, "unavailable"]);
  });
  it("a bad_sql_id from the AE layer degrades to unavailable and logs the code only (M2)", async () => {
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-18','l1','odd id!','spring',0,5,0,1)");
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadRows(ae, r1820, { domainIds: ["odd id!"], linkIds: null }, NOW);
    expect([sum(r.days), r.live, bodies.length]).toEqual([5, "unavailable", 0]);
    expect(log).toHaveBeenCalledWith("analytics live read failed", "bad_sql_id");
    expect(JSON.stringify(log.mock.calls)).not.toContain("odd id!");
  });
  it("CLICKS binding missing with a token set: off, not unavailable, no fetch (M1)", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows);
    const r = await loadRows({ ...ae, CLICKS: undefined }, r1820, all, NOW);
    expect([sum(r.days), r.live, bodies.length]).toEqual([5, "off", 0]);
  });
  it("a capped Analytics Engine answer degrades to unavailable with the D1 rows (I1)", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    stubAe(Array.from({ length: 2001 }, () => aeRows[1]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadRows(ae, r1820, all, NOW);
    expect([sum(r.days), r.live]).toEqual([5, "unavailable"]);
  });
  it("AE not configured: D1 rows and off, no fetch", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows);
    const r = await loadRows({ ...env, CF_ACCOUNT_ID: "", AE_READ_TOKEN: "" }, r1820, all, NOW);
    expect([sum(r.days), r.live, bodies.length]).toEqual([5, "off", 0]);
  });
  it("D1 rows respect the scope", async () => {
    await seedD1();
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-18','l9','d9','x',0,3,0,0)");
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-19')");
    stubAe([]);
    const s = (domainIds: string[] | null, linkIds: string[] | null) => loadRows(ae, r1820, { domainIds, linkIds }, NOW).then((r) => sum(r.days));
    expect(await s(null, null)).toBe(8);
    expect(await s(["d9"], null)).toBe(3);
    expect(await s([], null)).toBe(0);
    expect(await s(null, ["l1"])).toBe(5);
  });
  it("prev-window days feed only the day totals: links and dims are the current window", async () => {
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-16','l1','d1','spring',0,4,0,0),('2026-11-18','l1','d1','spring',0,5,0,0)");
    await run("INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks) VALUES ('2026-11-16','l1','d1','device','mobile',4),('2026-11-18','l1','d1','country','CA',5)");
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-19')");
    const range = { ...r1820, prev: { from: D("2026-11-16T00:00:00Z"), to: D("2026-11-18T00:00:00Z") } };
    const r = await loadRows({ ...env, CF_ACCOUNT_ID: "", AE_READ_TOKEN: "" }, range, all, NOW);
    expect(r.days.map((d) => [d.bucket, d.typed]).sort()).toEqual([["2026-11-16", 4], ["2026-11-18", 5]]);
    expect(r.links).toMatchObject([{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 5 }]);
    expect(r.dims).toEqual([{ dim: "country", value: "CA", clicks: 5 }]);
  });
  it("a 366-day range over many links gets aggregated rows from D1, not days x links (I1)", async () => {
    const LINKS = 25;
    // 732 days (current 366 + prev 366) x 25 links, 3 dim rows each.
    const days = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 731), k(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM k WHERE j < " + (LINKS - 1) + ")";
    await run(`${days} INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors)
      SELECT date('2024-11-20', '+' || i || ' days'), 'l' || j, 'd' || (j % 2), 's' || j, 1, j, 1, 1 FROM n, k`);
    await run(`${days}, v(dim, value) AS (VALUES ('country','CA'),('device','mobile'),('referrer',''))
      INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks) SELECT date('2024-11-20', '+' || i || ' days'), 'l' || j, 'd' || (j % 2), dim, value, 1 + j FROM n, k, v`);
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    let received = 0;
    let rowsRead = 0;
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        const res = await env.DB.batch(stmts);
        for (const x of res) { received += x.results.length; rowsRead += x.meta.rows_read ?? 0; }
        return res;
      },
    } as unknown as D1Database;
    const range = resolveRange({ range: "custom", from: "2025-11-20", to: "2026-11-20" }, NOW);
    if ("error" in range) throw new Error(range.error);
    const r = await loadRows({ ...env, DB: db, CF_ACCOUNT_ID: "", AE_READ_TOKEN: "" }, range, all, NOW);
    // Watermark 11-18: D1 covers the span 2024-11-19..2026-11-18, which holds 729 seeded days (seed starts 11-20).
    expect(received).toBeLessThanOrEqual(732 + LINKS + 3);
    expect(received).toBe(729 + LINKS + 3);
    expect(rowsRead).toBeLessThan(729 * LINKS * 5); // scans the window once per query, not a full table per row
    const rep = buildReport(range, r, new Map([["d0", "a.test"], ["d1", "b.test"]]), { truncated: false, visitors: true });
    const cur = await env.DB.prepare("SELECT SUM(qr + typed) AS n FROM clicks_daily WHERE day >= '2025-11-20' AND day <= '2026-11-18'").first<{ n: number }>();
    const prev = await env.DB.prepare("SELECT SUM(qr + typed) AS n FROM clicks_daily WHERE day >= '2024-11-19' AND day < '2025-11-20'").first<{ n: number }>();
    expect(rep.totals.clicks).toBe(cur?.n);
    expect(rep.totals.prevClicks).toBe(prev?.n);
    expect(rep.links).toHaveLength(LINKS);
    expect(rep.links[0]).toMatchObject({ linkId: "l24", slug: "s24", clicks: 364 * 25 });
    expect(rep.countries).toEqual([{ value: "CA", clicks: 364 * (LINKS * (LINKS + 1)) / 2 }]);
    console.log(`I1 seed: D1 returned ${received} rows, rows_read ${rowsRead}`);
  });
  it("hourly reads AE only", async () => {
    await seedD1();
    const bodies = stubAe([{ bucket: "2026-11-20 10:00:00", qr: 2, typed: 0, bots: 0 }], 200, [{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 2 }]);
    const r = await loadRows(ae, span("2026-11-19T13:00:00Z", "2026-11-20T13:00:00Z", "hour"), all, NOW);
    expect(r.days).toEqual([{ bucket: "2026-11-20T10:00:00Z", qr: 2, typed: 0, bots: 0, visitors: 0 }]);
    expect(r.links).toMatchObject([{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 2 }]);
    expect(bodies[0].query).toContain("toStartOfHour");
  });
});

describe("buildReport", () => {
  const range = { from: D("2026-11-18T00:00:00Z"), to: D("2026-11-21T00:00:00Z"), unit: "day" as const, prev: { from: D("2026-11-15T00:00:00Z"), to: D("2026-11-18T00:00:00Z") } };
  const day = (bucket: string, qr: number, typed: number, bots = 0, visitors = 0): DayRow => ({ bucket, qr, typed, bots, visitors });
  const link = (linkId: string, domainId: string, clicks: number) => ({ linkId, domainId, slug: `s-${linkId}`, clicks });
  const hosts = new Map([["d1", "a.test"], ["d2", "b.test"]]);
  const rows: ReportRows = {
    days: [day("2026-11-20", 1, 2, 3, 2), day("2026-11-18", 0, 5, 0, 1), day("2026-11-16", 4, 0)],
    links: [link("l1", "d1", 3), link("l2", "d2", 5)],
    dims: [
      { dim: "country", value: "CA", clicks: 1 },
      { dim: "country", value: "US", clicks: 5 },
      { dim: "country", value: "DE", clicks: 0 },
      { dim: "referrer", value: "", clicks: 2 },
    ],
    live: "ok",
  };

  it("zero-fills and sorts, totals the current window, prev from the window before", () => {
    const r = buildReport(range, rows, hosts, { truncated: true, visitors: true });
    expect(r.series).toEqual([
      { bucket: "2026-11-18", qr: 0, typed: 5 },
      { bucket: "2026-11-19", qr: 0, typed: 0 },
      { bucket: "2026-11-20", qr: 1, typed: 2 },
    ]);
    expect(r.totals).toEqual({ clicks: 8, qr: 1, typed: 7, bots: 3, visitors: 3, prevClicks: 4 });
    expect(r.links).toEqual([
      { linkId: "l2", domainId: "d2", host: "b.test", slug: "s-l2", clicks: 5 },
      { linkId: "l1", domainId: "d1", host: "a.test", slug: "s-l1", clicks: 3 },
    ]);
    expect(r.domains).toEqual([{ domainId: "d2", host: "b.test", clicks: 5 }, { domainId: "d1", host: "a.test", clicks: 3 }]);
    expect(r.countries).toEqual([{ value: "US", clicks: 5 }, { value: "CA", clicks: 1 }]);
    expect(r.referrers).toEqual([{ value: "", clicks: 2 }]);
    expect(r.devices).toEqual([]);
    expect([r.from, r.to, r.unit, r.live, r.truncated]).toEqual(["2026-11-18", "2026-11-20", "day", "ok", true]);
  });
  it("visitors null without the salt; prevClicks null for a 0 prev or no prev", () => {
    const noPrev = { ...rows, days: rows.days.slice(0, 2) };
    const r = buildReport(range, noPrev, hosts, { truncated: false, visitors: false });
    expect([r.totals.visitors, r.totals.prevClicks]).toEqual([null, null]);
    expect(buildReport({ ...range, prev: null }, rows, hosts, { truncated: false, visitors: true }).totals.prevClicks).toBeNull();
  });
  it("a moved link ranks once with all its clicks, while the domain breakdown keeps each domain's share", () => {
    const r = buildReport(range, { days: [], links: [link("l1", "d1", 3), link("l1", "d2", 5)], dims: [], live: "ok" }, hosts, { truncated: false, visitors: true });
    expect(r.links).toEqual([{ linkId: "l1", domainId: "d2", host: "b.test", slug: "s-l1", clicks: 8 }]);
    expect(r.domains).toEqual([{ domainId: "d2", host: "b.test", clicks: 5 }, { domainId: "d1", host: "a.test", clicks: 3 }]);
  });
  it("a moved link shows the address it was last seen on, whatever order the rows arrive in", () => {
    const rows = [{ ...link("l1", "d1", 3), seen: "~" }, { ...link("l1", "d2", 5), seen: "2026-11-18" }];
    const r = buildReport(range, { days: [], links: rows, dims: [], live: "ok" }, hosts, { truncated: false, visitors: true });
    expect(r.links).toEqual([{ linkId: "l1", domainId: "d1", host: "a.test", slug: "s-l1", clicks: 8 }]);
  });
  it("links keep the top 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => link(`x${i}`, "d1", i + 1));
    const r = buildReport(range, { days: [], links: many, dims: [], live: "ok" }, hosts, { truncated: false, visitors: true });
    expect(r.links).toHaveLength(50);
    expect(r.links[0]).toMatchObject({ linkId: "x59", clicks: 60 });
  });
});
