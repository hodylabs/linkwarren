// S13 analytics: filters (f=dim:value), hourly 7 days, the print and UTM breakdowns, the detail rollup read and recent clicks.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilters } from "../src/api/analytics";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (path: string, email = "owner@example.com") =>
  dash(`/api/analytics${path}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } });
const json = async (path: string, email?: string) => (await get(path, email)).json() as Promise<any>;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const dayAt = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
type Body = { query: string; params: Record<string, string> };
const bodies = (spy: ReturnType<typeof vi.spyOn>): Body[] => spy.mock.calls.map((c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)));

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(setupAccess);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await env.DB.batch(
    ["clicks_daily", "clicks_daily_dim", "clicks_daily_detail", "qr_labels", "analytics_state", "links", "slug_locks", "domain_members", "domains", "users"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1),('ua','a@example.com','member','active',1),('ub','b@example.com','member','active',1)");
  const dom = (id: string, host: string, type: string, owner: string | null) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dM", "main.example.com", "main", "uo");
  await dom("dB", "b.example.com", "private", "ub");
  for (const [id, d] of [["lM", "dM"], ["lB", "dB"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://example.com/','uo','uo',1,1)", id, d, id, id);
  await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('q1','lM','abc123','Flyer',1),('q2','lB','bbb222','Secret print',1)");
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through', ?)", dayAt(-2));
  await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?, 'lM','dM','lM',1,2)", dayAt(-3));
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected fetch"); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function withAe<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { CLICKS: env.CLICKS, CF_ACCOUNT_ID: env.CF_ACCOUNT_ID, AE_READ_TOKEN: env.AE_READ_TOKEN };
  Object.assign(env, { CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc", AE_READ_TOKEN: "tok" });
  try {
    return await fn();
  } finally {
    Object.assign(env, prev);
  }
}

describe("parseFilters", () => {
  it("splits on the first colon; an empty value is a real one", () => {
    expect(parseFilters(["country:US", "referrer:a:b", "print:"])).toEqual([
      { dim: "country", value: "US" }, { dim: "referrer", value: "a:b" }, { dim: "print", value: "" },
    ]);
    expect(parseFilters([])).toEqual([]);
  });
  it("refuses unknown or repeated dimensions, more than 6 filters, no colon and values over 100 characters", () => {
    expect(parseFilters(["blob4:US"])).toBeNull();
    expect(parseFilters(["__proto__:x"])).toBeNull();
    expect(parseFilters(["country:US", "country:DE"])).toBeNull();
    expect(parseFilters(["country"])).toBeNull();
    expect(parseFilters([`place:${"x".repeat(101)}`])).toBeNull();
    expect(parseFilters([`place:${"x".repeat(100)}`])).toHaveLength(1);
    expect(parseFilters(["country:a", "place:b", "device:c", "os:d", "browser:e", "language:f", "source:qr"])).toBeNull();
  });
});

describe("filters on the report", () => {
  it("bad filters are 400 bad_filter on every analytics read", async () => {
    for (const path of ["?f=nope:x", "/detail?f=country:a&f=country:b", "/recent?f=country", "?link=lM&f=x:y"])
      expect([(await get(path)).status, (await json(path)).error]).toEqual([400, "bad_filter"]);
  });
  it("a filter reads Analytics Engine only, binds the value, and keeps the breakdown's extra term", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    await withAe(() => json("?range=30&f=referrer:example.com&f=print:"));
    const bs = bodies(fetchSpy);
    expect(bs.length).toBeGreaterThan(0);
    for (const b of bs) {
      expect(b.query).toContain("blob6 = $f0 AND blob7 = $typed");
      expect(b.query).toContain("blob14 = $f1 AND blob7 = $qr");
      expect(b.query).not.toContain("example.com");
      expect([b.params.f0, b.params.f1]).toEqual(["example.com", ""]);
    }
  });
  it("filtered totals come from Analytics Engine only, never the unfiltered D1 rollups", async () => {
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const q = JSON.parse(String((init as RequestInit).body)).query as string;
      return Response.json({ data: q.includes("countIf") ? [{ bucket: `${dayAt(-1)} 00:00:00`, qr: 0, typed: 4, bots: 0 }] : [] });
    });
    const r = await withAe(() => json("?range=30&f=country:US"));
    expect(r.totals.clicks).toBe(4); // the 3 rolled clicks on day -3 are unfiltered and stay out
    expect(r.filteredFrom).toBeUndefined();
  });
  it("R1: a filtered range past the Analytics Engine window covers the window only, says from when, and drops the comparison", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    const r = await withAe(() => json("?range=custom&from=2026-01-01&to=2026-11-19&f=country:US"));
    expect(r.filteredFrom).toBe(dayAt(-89));
    expect(r.totals.prevClicks).toBeNull();
    for (const b of bodies(fetchSpy)) expect(b.params.from >= `${dayAt(-89)}T00:00:00Z`).toBe(true);
  });
  it("a failing Analytics Engine under a filter shows nothing rather than unfiltered numbers", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    const r = await withAe(() => json("?range=30&f=country:US"));
    expect([r.live, r.totals.clicks]).toEqual(["unavailable", 0]);
  });
  it("R8: with Analytics Engine, 7 days are 168 hourly points; without it they stay daily from D1", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    const h = await withAe(() => json("?range=7"));
    expect([h.unit, h.series.length]).toEqual(["hour", 168]);
    const d = await json("?range=7");
    expect([d.unit, d.series.length, d.totals.clicks]).toEqual(["day", 7, 3]);
  });
  it("R8 + R9: a failed live read of the hourly 7 days falls back to the daily 7 days with the D1 totals", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await withAe(() => json("?range=7"));
    expect([r.live, r.unit, r.series.length, r.totals.clicks]).toEqual(["unavailable", "day", 7, 3]);
  });
  it("the fallback follows the range the report used, also with a repeated range parameter", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await withAe(() => json("?range=30&range=7")); // the last one wins, as in prepare
    expect([r.live, r.unit, r.series.length, r.totals.clicks]).toEqual(["unavailable", "day", 7, 3]);
  });
  it("R8: the hourly 7 days still count visitors per UTC day over the current window; the 24 hours per hour", async () => {
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const b = JSON.parse(String((init as RequestInit).body)) as Body;
      if (!b.query.includes("COUNT(DISTINCT")) return Response.json({ data: [] });
      const day = b.query.includes("toStartOfDay");
      return Response.json({ data: day ? [{ bucket: "2026-11-13 00:00:00", n: 2 }, { bucket: "2026-11-15 00:00:00", n: 5 }] : [{ bucket: "2026-11-20 11:00:00", n: 1 }] });
    });
    const e = env as unknown as Record<string, unknown>;
    const salt = e.VISITOR_SALT;
    e.VISITOR_SALT = "s";
    try {
      expect((await withAe(() => json("?range=7"))).totals.visitors).toBe(7); // 11-13 filed under the window's first hour, 13:00
      const vq = bodies(fetchSpy).find((b) => b.query.includes("COUNT(DISTINCT"))!;
      expect(vq.query).toMatch(/timestamp >= \$cur .*GROUP BY toStartOfDay\(timestamp\)/);
      fetchSpy.mockClear();
      expect((await withAe(() => json("?range=1"))).totals.visitors).toBe(1);
      expect(bodies(fetchSpy).find((b) => b.query.includes("COUNT(DISTINCT"))!.query).toContain("GROUP BY toStartOfHour(timestamp)");
    } finally {
      e.VISITOR_SALT = salt;
    }
  });
});

describe("detail: print and UTM breakdowns", () => {
  const fake = (rows: Record<string, Record<string, unknown>[]>) =>
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const q = JSON.parse(String((init as RequestInit).body)).query as string;
      if (q.includes("toStartOfHour")) return Response.json({ data: [] });
      return Response.json({ data: rows[/(blob\d+) AS value/.exec(q)![1]!] ?? [] });
    });
  it("prints are per link and QR-only, labelled by that link's own label; UTM rows skip empty values", async () => {
    fake({
      blob14: [{ linkId: "lM", value: "abc123", n: 5 }, { linkId: "lM", value: "", n: 2 }, { linkId: "lB", value: "abc123", n: 1 }, { linkId: "lB", value: "bbb222", n: 1 }],
      blob15: [{ value: "newsletter", n: 3 }],
    });
    const r = await withAe(() => json("/detail?range=7&tz=UTC"));
    expect(r.prints).toEqual([
      { dim: "print", value: "abc123", linkId: "lM", label: "Flyer", clicks: 5 },
      { dim: "print", value: "", linkId: "lM", label: null, clicks: 2 },
      // lM's code on lB is not lM's print; lB's own label shows to the owner.
      { dim: "print", value: "abc123", linkId: "lB", label: null, clicks: 1 },
      { dim: "print", value: "bbb222", linkId: "lB", label: "Secret print", clicks: 1 },
    ]);
    expect(r.utmSources).toEqual([{ dim: "utm_source", value: "newsletter", clicks: 3 }]);
    expect([r.utmMediums, r.utmCampaigns]).toEqual([[], []]);
    const bs = bodies(fetchSpy);
    expect(bs.find((b) => b.query.includes("blob14 AS value"))!.query).toMatch(/blob7 = \$qr.*GROUP BY blob2, blob14/);
    expect(bs.find((b) => b.query.includes("blob15 AS value"))!.query).toContain("blob15 != $none");
  });
  it("a label is never shown for a link outside the reader's scope", async () => {
    fake({ blob14: [{ linkId: "lB", value: "bbb222", n: 1 }] });
    const r = await withAe(() => json("/detail?range=7&tz=UTC", "a@example.com"));
    expect(r.prints).toEqual([{ dim: "print", value: "bbb222", linkId: "lB", label: null, clicks: 1 }]);
  });
  it("days before the Analytics Engine window come from the detail rollup, unfiltered only", async () => {
    await run(
      "INSERT INTO clicks_daily_detail (day,link_id,domain_id,dim,value,clicks) VALUES (?,'lM','dM','os','iOS',4),(?,'lM','dM','print','abc123',2),(?,'lM','dM','utm_campaign','(other)',6),(?,'lB','dB','os','iOS',9),(?,'lM','dM','os','iOS',100)",
      dayAt(-100), dayAt(-100), dayAt(-100), dayAt(-100), dayAt(-50),
    );
    const r = await json("/detail?range=custom&from=2026-08-01&to=2026-08-31&tz=UTC", "a@example.com"); // AE off: D1 only
    expect(r.live).toBe("off");
    expect(r.os).toEqual([{ value: "iOS", clicks: 4 }]); // lB is not the member's; day -50 is inside the window, never from D1
    expect(r.prints).toEqual([{ dim: "print", value: "abc123", linkId: "lM", label: "Flyer", clicks: 2 }]);
    expect(r.utmCampaigns).toEqual([{ dim: "utm_campaign", value: "(other)", clicks: 6 }]);
    expect((await json("/detail?range=custom&from=2026-08-01&to=2026-08-31&tz=UTC&f=os:iOS")).os).toEqual([]);
  });
});

describe("GET /api/analytics/recent", () => {
  const row = (at: string, linkId: string, domainId: string, extra: Record<string, string> = {}) => ({
    at, linkId, domainId, slug: linkId, country: "CA", place: "Toronto, CA", device: "mobile", os: "iOS", browser: "Safari", language: "en-ca",
    source: "typed", print: "", referrer: "", utmSource: "", utmMedium: "", utmCampaign: "", ...extra,
  });
  it("unauthenticated is 401; without Analytics Engine it is empty and off", async () => {
    expect((await dash("/api/analytics/recent")).status).toBe(401);
    expect(await json("/recent")).toEqual({ items: [], live: "off" });
  });
  it("the last human clicks newest first, the contract shape, labels by link, nothing identifying", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [
      row("2026-11-20 11:00:00", "lM", "dM"),
      row("2026-11-20 11:30:00", "lM", "dM", { source: "qr", print: "abc123", utmSource: "news" }),
      row("2026-11-20 10:00:00", "lB", "dB", { source: "qr", print: "abc123" }),
    ] }));
    const r = await withAe(() => json("/recent?range=90"));
    expect(r.live).toBe("ok");
    expect(r.items.map((i: any) => [i.at, i.linkId, i.printLabel])).toEqual([
      ["2026-11-20T11:30:00Z", "lM", "Flyer"], ["2026-11-20T11:00:00Z", "lM", null], ["2026-11-20T10:00:00Z", "lB", null],
    ]);
    expect(Object.keys(r.items[0]).sort()).toEqual(["at", "browser", "country", "device", "host", "language", "linkId", "os", "place", "print", "printLabel",
      "referrer", "slug", "source", "utmCampaign", "utmMedium", "utmSource"]);
    expect(r.items[0].host).toBe("main.example.com");
    const [b] = bodies(fetchSpy);
    expect(b!.query).toMatch(/blob8 = \$human .*ORDER BY timestamp DESC LIMIT 50$/);
    expect(b!.query).not.toMatch(/blob9|AS ip|user/i);
    expect([b!.params.from, b!.params.to]).toEqual(["2026-11-19T12:00:01Z", "2026-11-20T12:00:01Z"]);
  });
  it("scoped like the report: a member reads only usable domains and cannot ask for another's", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    await withAe(() => json("/recent?f=source:qr", "a@example.com"));
    const [b] = bodies(fetchSpy);
    expect(b!.query).toContain("blob1 = $d0");
    expect(Object.entries(b!.params).filter(([k]) => /^d\d+$/.test(k)).map(([, v]) => v)).toEqual(["dM"]);
    expect(b!.params.f0).toBe("qr");
    expect((await withAe(() => get("/recent?domains=dB", "a@example.com"))).status).toBe(403);
    expect((await withAe(() => get("/recent?link=lB", "a@example.com"))).status).toBe(404);
  });
  it("a failing read is unavailable, not 500", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 502 }));
    expect(await withAe(() => json("/recent"))).toEqual({ items: [], live: "unavailable" });
  });
  it("ignores the report range: an incomplete custom range is not refused", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    expect(await withAe(() => get("/recent?range=custom"))).toMatchObject({ status: 200 });
    expect((await withAe(() => get("/recent?range=nope&from=x"))).status).toBe(200);
    expect((await withAe(() => get("/recent?f=nope:x"))).status).toBe(400);
  });
  it("reads only the hosts of the domains in the answer, and none for an empty answer", async () => {
    const prep = vi.spyOn(env.DB, "prepare");
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    await withAe(() => json("/recent"));
    expect(prep.mock.calls.some(([q]) => String(q).includes("SELECT id, host FROM domains"))).toBe(false);
    fetchSpy.mockImplementation(async () => Response.json({ data: [row("2026-11-20 11:00:00", "lM", "dM")] }));
    const r = await withAe(() => json("/recent"));
    expect(r.items[0].host).toBe("main.example.com");
    const hostReads = prep.mock.calls.filter(([q]) => String(q).includes("SELECT id, host FROM domains"));
    expect(hostReads.length).toBe(1);
    expect(String(hostReads[0]![0])).toContain("WHERE id IN (SELECT value FROM json_each(?))");
  });
});
