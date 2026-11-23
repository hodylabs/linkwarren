import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localParts, parseTz, shiftOf } from "../src/analytics";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (path: string, email = "owner@example.com") =>
  dash(`/api/analytics${path}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } });
const json = async (path: string, email?: string) => (await get(path, email)).json() as Promise<any>;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const dayAt = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(setupAccess);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await env.DB.batch(
    ["clicks_daily", "clicks_daily_dim", "analytics_state", "links", "slug_locks", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1),('ua','a@example.com','member','active',1),('ub','b@example.com','member','active',1)");
  const dom = (id: string, host: string, type: string, owner: string | null) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dM", "main.test", "main", "uo");
  await dom("dB", "b.test", "private", "ub");
  for (const [id, d] of [["lM", "dM"], ["lB", "dB"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/','uo','uo',1,1)", id, d, id, id);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through', ?)", dayAt(-2));
  for (const [l, d, n] of [["lM", "dM", 2], ["lB", "dB", 5]] as const)
    await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,?,?,?,1,?)", dayAt(-3), l, d, l, n);
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

describe("GET /api/analytics?link=: one link's report", () => {
  it("totals cover that link only and name it", async () => {
    const r = await json("?range=7&link=lM");
    expect(r.totals.clicks).toBe(3);
    expect(r.link).toEqual({ linkId: "lM", host: "main.test", slug: "lM" });
    expect(r.links.map((l: any) => l.linkId)).toEqual(["lM"]);
  });
  it("a member cannot open another member's private link: 404, the same as an unknown one", async () => {
    expect((await get("?link=lB", "a@example.com")).status).toBe(404);
    expect((await get("?link=ghost", "a@example.com")).status).toBe(404);
    expect((await get("/detail?link=lB", "a@example.com")).status).toBe(404);
    expect((await json("?range=7&link=lB", "b@example.com")).totals.clicks).toBe(6); // its domain's owner can
    expect((await json("?range=7&link=lM", "a@example.com")).totals.clicks).toBe(3);
  });
  it("link with q or domains, or a malformed id, is 400", async () => {
    expect((await get("?link=lM&q=x")).status).toBe(400);
    expect((await get("?link=lM&domains=dM")).status).toBe(400);
    expect((await get("?link=a%27b")).status).toBe(400);
  });
});

describe("parseTz: an IANA name Intl knows, or an offset in range", () => {
  it("accepts", () => {
    expect(parseTz("Europe/Paris")).toEqual({ zone: "Europe/Paris" });
    expect(parseTz("UTC")).toMatchObject({ zone: expect.any(String) });
    expect(parseTz("-300")).toEqual({ offset: -300 });
    expect(parseTz("840")).toEqual({ offset: 840 });
    expect(parseTz(undefined)).toEqual({ offset: 0 });
  });
  it("refuses", () => {
    expect(parseTz("Mars/Olympus")).toBeNull();
    expect(parseTz("841")).toBeNull();
    expect(parseTz("-721")).toBeNull();
    expect(parseTz("Europe/Paris'; DROP")).toBeNull();
    expect(parseTz("../etc")).toBeNull();
  });
  it("localParts shifts into the zone, Monday first", () => {
    const t = Date.parse("2026-11-23T00:30:00Z"); // a Monday in UTC
    expect(localParts(t, { offset: 0 })).toEqual({ dow: 0, hour: 0, day: "2026-11-23" });
    expect(localParts(t, { zone: "America/New_York" })).toEqual({ dow: 6, hour: 19, day: "2026-11-22" });
    expect(localParts(t, { offset: 330 })).toEqual({ dow: 0, hour: 6, day: "2026-11-23" });
  });
});

describe("GET /api/analytics/detail", () => {
  it("a bad tz is 400 before any read", async () => {
    await withAe(async () => {
      expect((await get("/detail?tz=Nowhere/Land")).status).toBe(400);
      expect((await get("/detail?tz=9999")).status).toBe(400);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("off without Analytics Engine", async () => {
    const r = await json("/detail?range=7&tz=UTC");
    expect(r.live).toBe("off");
    expect(r.hours).toHaveLength(7);
    expect(r.hours[0]).toHaveLength(24);
  });
  it("buckets values and puts hours into the viewer's zone; reads blob10 to blob13 for the scope", async () => {
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const q = JSON.parse(String((init as RequestInit).body)).query as string;
      if (q.includes("toStartOfHour")) return Response.json({ data: [{ bucket: "2026-11-16 14:00:00", n: 4 }] }); // Monday 14:00 UTC
      const col = /SELECT (blob\d+) AS value/.exec(q)![1];
      const data = { blob10: [{ value: "iOS", n: 3 }, { value: "", n: 1 }], blob11: [{ value: "Safari", n: 4 }], blob12: [{ value: "en-us", n: 4 }], blob13: [{ value: "Toronto, CA", n: 4 }] }[col!];
      return Response.json({ data });
    });
    const r = await withAe(() => json("/detail?range=7&link=lM&tz=America/Toronto"));
    expect(r.live).toBe("ok");
    expect(r.os).toEqual([{ value: "iOS", clicks: 3 }, { value: "", clicks: 1 }]);
    expect(r.places).toEqual([{ value: "Toronto, CA", clicks: 4 }]);
    expect(r.hours[0][9]).toBe(4); // 14:00 UTC is 09:00 in Toronto in November
    const bodies = fetchSpy.mock.calls.map((c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies.every((b: any) => b.query.includes("blob2 = $l0") && b.params.l0 === "lM")).toBe(true);
  });
  it("a range wholly older than Analytics Engine keeps has no detail and no reads", async () => {
    const r = await withAe(() => json("/detail?range=custom&from=2026-01-01&to=2026-01-07&tz=UTC"));
    expect(r).toMatchObject({ live: "ok", from: "", to: "", os: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("whole-hour zones keep the plain UTC hour query", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    await withAe(() => json("/detail?range=7&tz=America/Toronto"));
    const hourQ = fetchSpy.mock.calls.map((c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body))).find((b: any) => b.query.includes("toStartOfHour"));
    expect(hourQ.query).toContain("toStartOfHour(timestamp)");
    expect(hourQ.params.shift).toBeUndefined();
  });
  it("+05:30 shifts timestamps by 30 minutes before the hour is cut, so 00:45Z files under 06:00 local", async () => {
    fetchSpy.mockImplementation(async (_u: unknown, init: unknown) => {
      const b = JSON.parse(String((init as RequestInit).body));
      if (!b.query.includes("toStartOfHour")) return Response.json({ data: [] });
      expect(b.query).toContain("toUnixTimestamp(timestamp) + toUInt32($shift)");
      expect(b.params.shift).toBe("1800");
      // A click at 2026-11-16 00:45Z, shifted by 30 min, falls in the 01:00 bucket; 01:00 - 30 min = 00:30Z = 06:00 IST, Monday.
      return Response.json({ data: [{ bucket: "2026-11-16 01:00:00", n: 3 }] });
    });
    for (const tz of ["Asia/Kolkata", "330"]) {
      const r = await withAe(() => json(`/detail?range=7&tz=${tz}`));
      expect(r.hours[0][6]).toBe(3);
      expect(r.hours[0][5]).toBe(0);
    }
  });
  it("shiftOf: the part of the offset past the whole hour", () => {
    expect(shiftOf({ zone: "Asia/Kolkata" }, NOW)).toBe(1800);
    expect(shiftOf({ zone: "Asia/Kathmandu" }, NOW)).toBe(2700);
    expect(shiftOf({ zone: "America/St_Johns" }, NOW)).toBe(1800);
    expect(shiftOf({ zone: "Europe/Paris" }, NOW)).toBe(0);
    expect(shiftOf({ offset: -210 }, NOW)).toBe(1800);
    expect(shiftOf({ offset: 0 }, NOW)).toBe(0);
  });
  it("a 90-day detail clips to Analytics Engine's retention and splits the hours", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    const r = await withAe(() => json("/detail?range=custom&from=2026-01-01&to=2026-11-20&tz=UTC"));
    expect(r.from).toBe(dayAt(-89));
    const hourQueries = fetchSpy.mock.calls.filter((c: unknown[]) => String((c[1] as RequestInit).body).includes("toStartOfHour"));
    expect(hourQueries).toHaveLength(2);
  });
});
