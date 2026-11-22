import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TotRow } from "../src/ae";
import { buildReport, loadRows, resolveRange, resolveScope } from "../src/analytics";
import type { Env } from "../src/env";
import type { UserRow } from "../src/types";

const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const NOW = Date.parse("2026-11-20T12:34:00Z") / 1000;
const ae: Env = { ...env, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" };
const D = (s: string) => new Date(s);

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const user = (id: string, role: "owner" | "member"): UserRow => ({ id, email: `${id}@example.com`, name: null, role, status: "active", createdAt: 1 });

function stubAe(rows: unknown[], status = 200) {
  const bodies: { query: string; params: Record<string, string> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SQL_URL) throw new Error("unexpected fetch");
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if (status !== 200) return new Response("no", { status });
    return Response.json({ data: b.query.includes("blob7 AS source") ? rows : [] });
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
  it('"7": the last 7 UTC days through tomorrow 00:00, prev the 7 before', () => {
    const r = resolveRange({ range: "7" }, NOW);
    if ("error" in r) throw new Error(r.error);
    expect([r.from.toISOString(), r.to.toISOString(), r.unit]).toEqual(["2026-11-14T00:00:00.000Z", "2026-11-21T00:00:00.000Z", "day"]);
    expect([r.prev?.from.toISOString(), r.prev?.to.toISOString()]).toEqual(["2026-11-07T00:00:00.000Z", "2026-11-14T00:00:00.000Z"]);
  });
  it('"1": 24 hourly buckets ending at the current hour\'s end', () => {
    const r = resolveRange({ range: "1" }, NOW);
    if ("error" in r) throw new Error(r.error);
    expect([r.from.toISOString(), r.to.toISOString(), r.unit]).toEqual(["2026-11-19T13:00:00.000Z", "2026-11-20T13:00:00.000Z", "hour"]);
    expect(r.prev?.from.toISOString()).toBe("2026-11-18T13:00:00.000Z");
    const rep = buildReport(r, { tot: [], dims: [], live: "ok" }, new Map(), { truncated: false, visitors: true });
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
    const rep = buildReport(r, { tot: [], dims: [], live: "ok" }, new Map(), { truncated: false, visitors: true });
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
    expect(await resolveScope(env, user("uo", "owner"), null, "")).toEqual({ scope: { domainIds: null, linkIds: null }, truncated: false });
  });
  it("member, no filter: exactly their usable ids", async () => {
    const r = await resolveScope(env, user("ua", "member"), null, "");
    if ("error" in r) throw new Error(r.error);
    expect([...(r.scope.domainIds ?? [])].sort()).toEqual(["dM", "dS"]);
  });
  it("member filtering on a shared domain they lost: forbidden; unknown id: forbidden", async () => {
    expect(await resolveScope(env, user("ua", "member"), ["dS"], "")).toEqual({ scope: { domainIds: ["dS"], linkIds: null }, truncated: false });
    await run("DELETE FROM domain_members WHERE domain_id = 'dS' AND user_id = 'ua'");
    expect(await resolveScope(env, user("ua", "member"), ["dS"], "")).toEqual({ error: "forbidden" });
    expect(await resolveScope(env, user("ua", "member"), ["dM", "dB"], "")).toEqual({ error: "forbidden" });
    expect(await resolveScope(env, user("uo", "owner"), ["nope"], "")).toEqual({ error: "forbidden" });
  });
  it("q matches host/slug inside the member's domains only", async () => {
    const r = await resolveScope(env, user("ua", "member"), null, "spring");
    if ("error" in r) throw new Error(r.error);
    expect(r.scope.linkIds).toEqual(["l1"]);
    const o = await resolveScope(env, user("uo", "owner"), null, "spring");
    if ("error" in o) throw new Error(o.error);
    expect([...(o.scope.linkIds ?? [])].sort()).toEqual(["l1", "l2"]);
    expect(o.scope.domainIds).toBeNull();
  });
  it("LIKE wildcards in q are literal", async () => {
    const pct = await resolveScope(env, user("uo", "owner"), null, "%");
    const und = await resolveScope(env, user("uo", "owner"), null, "fall_");
    if ("error" in pct || "error" in und) throw new Error("forbidden");
    expect(pct.scope.linkIds).toEqual(["l3"]);
    expect(und.scope.linkIds).toEqual(["l3"]);
  });
  it("an injection attempt in q is only a LIKE bind (Review Focus 1)", async () => {
    const r = await resolveScope(env, user("uo", "owner"), null, "') OR 1=1 --");
    expect(r).toEqual({ scope: { domainIds: null, linkIds: [] }, truncated: false });
  });
  it("501 matches: 500 ids and truncated", async () => {
    const stmts = Array.from({ length: 501 }, (_, i) =>
      env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'dM',?,?,'https://x.com/','uo','uo',1,1)").bind(
        `m${i}`, `many${i}`, `many${i}`,
      ),
    );
    await env.DB.batch(stmts);
    const r = await resolveScope(env, user("uo", "owner"), null, "many");
    if ("error" in r) throw new Error(r.error);
    expect(r.scope.linkIds).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});

describe("loadRows (Review Focus 4)", () => {
  const aeRows = [
    { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "typed", kind: "human", n: 99 },
    { bucket: "2026-11-19 00:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "typed", kind: "human", n: 7 },
  ];
  const seedD1 = async () => {
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-18','l1','d1','spring',0,5,0,1)");
    await run("INSERT INTO clicks_daily_dim (day, link_id, domain_id, dim, value, clicks) VALUES ('2026-11-18','l1','d1','country','CA',5)");
  };
  const all = { domainIds: null, linkIds: null };
  const sum = (tot: TotRow[]) => tot.reduce((n, t) => n + t.qr + t.typed, 0);

  it("days up to the watermark come from D1 only, later days from AE", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows);
    const r = await loadRows(ae, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", all, NOW);
    expect(sum(r.tot)).toBe(12);
    expect(r.live).toBe("ok");
    expect(r.dims).toEqual([{ bucket: "2026-11-18", domainId: "d1", linkId: "l1", dim: "country", value: "CA", clicks: 5 }]);
    expect(bodies).toHaveLength(5);
    expect(bodies.every((b) => b.params.from === "2026-11-19T00:00:00Z")).toBe(true);
  });
  it("no watermark: everything in range comes from AE", async () => {
    await seedD1();
    const bodies = stubAe(aeRows);
    const r = await loadRows(ae, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", all, NOW);
    expect(sum(r.tot)).toBe(106);
    expect(bodies[0].params.from).toBe("2026-11-18T00:00:00Z");
  });
  it("watermark covers the whole range: no AE call", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-19')");
    const bodies = stubAe(aeRows);
    const r = await loadRows(ae, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", all, NOW);
    expect([sum(r.tot), r.live, bodies.length]).toEqual([5, "ok", 0]);
  });
  it("AE failing keeps the D1 rows and says unavailable (R9)", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    stubAe(aeRows, 500);
    const r = await loadRows(ae, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", all, NOW);
    expect([sum(r.tot), r.live]).toEqual([5, "unavailable"]);
  });
  it("AE not configured: D1 rows and off, no fetch", async () => {
    await seedD1();
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')");
    const bodies = stubAe(aeRows);
    const r = await loadRows({ ...env, CF_ACCOUNT_ID: "", AE_READ_TOKEN: "" }, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", all, NOW);
    expect([sum(r.tot), r.live, bodies.length]).toEqual([5, "off", 0]);
  });
  it("D1 rows respect the scope", async () => {
    await seedD1();
    await run("INSERT INTO clicks_daily (day, link_id, domain_id, slug, qr, typed, bots, visitors) VALUES ('2026-11-18','l9','d9','x',0,3,0,0)");
    await run("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-19')");
    stubAe([]);
    const s = (domainIds: string[] | null, linkIds: string[] | null) =>
      loadRows(ae, D("2026-11-18T00:00:00Z"), D("2026-11-20T00:00:00Z"), "day", { domainIds, linkIds }, NOW).then((r) => sum(r.tot));
    expect(await s(null, null)).toBe(8);
    expect(await s(["d9"], null)).toBe(3);
    expect(await s([], null)).toBe(0);
    expect(await s(null, ["l1"])).toBe(5);
  });
  it("hourly reads AE only", async () => {
    await seedD1();
    const bodies = stubAe([{ bucket: "2026-11-20 10:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "qr", kind: "human", n: 2 }]);
    const r = await loadRows(ae, D("2026-11-19T13:00:00Z"), D("2026-11-20T13:00:00Z"), "hour", all, NOW);
    expect(r.tot).toEqual([{ bucket: "2026-11-20T10:00:00Z", domainId: "d1", linkId: "l1", slug: "spring", qr: 2, typed: 0, bots: 0, visitors: 0 }]);
    expect(bodies[0].query).toContain("toStartOfHour");
  });
});

describe("buildReport", () => {
  const range = { from: D("2026-11-18T00:00:00Z"), to: D("2026-11-21T00:00:00Z"), unit: "day" as const, prev: { from: D("2026-11-15T00:00:00Z"), to: D("2026-11-18T00:00:00Z") } };
  const t = (bucket: string, linkId: string, domainId: string, qr: number, typed: number, bots = 0, visitors = 0): TotRow => ({ bucket, domainId, linkId, slug: `s-${linkId}`, qr, typed, bots, visitors });
  const hosts = new Map([["d1", "a.test"], ["d2", "b.test"]]);
  const rows = {
    tot: [t("2026-11-20", "l1", "d1", 1, 2, 3, 2), t("2026-11-18", "l2", "d2", 0, 5, 0, 1), t("2026-11-16", "l1", "d1", 4, 0)],
    dims: [
      { bucket: "2026-11-20", domainId: "d1", linkId: "l1", dim: "country" as const, value: "CA", clicks: 1 },
      { bucket: "2026-11-18", domainId: "d2", linkId: "l2", dim: "country" as const, value: "US", clicks: 5 },
      { bucket: "2026-11-20", domainId: "d1", linkId: "l1", dim: "country" as const, value: "DE", clicks: 0 },
      { bucket: "2026-11-20", domainId: "d1", linkId: "l1", dim: "referrer" as const, value: "", clicks: 2 },
      { bucket: "2026-11-16", domainId: "d1", linkId: "l1", dim: "device" as const, value: "mobile", clicks: 4 },
    ],
    live: "ok" as const,
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
    expect(r.devices).toEqual([]); // the prev window's dims are left out
    expect([r.from, r.to, r.unit, r.live, r.truncated]).toEqual(["2026-11-18", "2026-11-20", "day", "ok", true]);
  });
  it("visitors null without the salt; prevClicks null for a 0 prev or no prev", () => {
    const noPrev = { ...rows, tot: rows.tot.slice(0, 2) };
    const r = buildReport(range, noPrev, hosts, { truncated: false, visitors: false });
    expect([r.totals.visitors, r.totals.prevClicks]).toEqual([null, null]);
    expect(buildReport({ ...range, prev: null }, rows, hosts, { truncated: false, visitors: true }).totals.prevClicks).toBeNull();
  });
  it("links keep the top 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => t("2026-11-19", `x${i}`, "d1", 0, i + 1));
    const r = buildReport(range, { tot: many, dims: [], live: "ok" }, hosts, { truncated: false, visitors: true });
    expect(r.links).toHaveLength(50);
    expect(r.links[0]).toMatchObject({ linkId: "x59", clicks: 60 });
  });
});
