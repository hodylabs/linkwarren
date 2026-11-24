// S13 fix round: aeDetail stays inside one request's Analytics Engine budget without refusing scopes that worked before S13,
// and a print answer over ROW_CAP never hides the other breakdowns.
import { afterEach, describe, expect, it, vi } from "vitest";
import { aeDetail, ROW_CAP } from "../src/ae";
import type { Env } from "../src/env";

const env = { DB: {}, CACHE: {}, CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" } as unknown as Env;
const to = new Date("2026-11-20T00:00:00Z");
const DAY = 86_400_000;

function fake(reply: (q: string) => Response | unknown[] = () => []) {
  const queries: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
    const q = JSON.parse(String(init?.body)).query as string;
    queries.push(q);
    const r = reply(q);
    return r instanceof Response ? r : Response.json({ data: r });
  });
  return queries;
}
afterEach(() => vi.restoreAllMocks());

describe("aeDetail budget", () => {
  it("one chunk over 90 days: all 8 dims and 2 hour queries (10), nothing cut", async () => {
    const qs = fake();
    const r = await aeDetail(env, new Date(to.getTime() - 89 * DAY), to, { domainIds: null, linkIds: null });
    expect([qs.length, r.cut, r.printByCode]).toEqual([10, [], false]);
  });
  it("a 5-chunk scope that worked before S13 still answers: the S10 detail and hours (30 queries), print and UTM cut", async () => {
    const qs = fake((q) => (q.includes("blob10 AS value") ? [{ value: "iOS", n: 2 }] : []));
    const ids = Array.from({ length: 1900 }, (_, i) => `dom${i}`);
    const r = await aeDetail(env, new Date(to.getTime() - 89 * DAY), to, { domainIds: ids, linkIds: null });
    expect(r.cut).toEqual(["print", "utm_source", "utm_medium", "utm_campaign"]);
    expect(qs.length).toBe(30); // 5 chunks x (4 dims + 2 hour spans)
    expect(qs.some((q) => /blob1[4-7] AS value/.test(q))).toBe(false);
    expect(r.dims).toEqual([{ dim: "os", value: "iOS", clicks: 10 }]);
  });
  it("a print answer over ROW_CAP falls back to codes over all links (no label), the other dims stay", async () => {
    const qs = fake((q) => {
      if (q.includes("blob2 AS linkId, blob14")) return Response.json({ data: [], rows_before_limit_at_least: ROW_CAP + 5 });
      if (q.includes("blob14 AS value")) return [{ value: "abc123", n: 7 }];
      return q.includes("blob11 AS value") ? [{ value: "Safari", n: 1 }] : [];
    });
    const r = await aeDetail(env, new Date(to.getTime() - 6 * DAY), to, { domainIds: null, linkIds: null });
    expect(r.dims).toEqual(expect.arrayContaining([{ dim: "browser", value: "Safari", clicks: 1 }, { dim: "print", value: "abc123", clicks: 7, linkId: "" }]));
    expect(qs.find((q) => q.includes("blob14 AS value") && !q.includes("blob2 AS linkId"))).toMatch(/blob7 = \$qr GROUP BY blob14/);
  });
  it("a fallback still over ROW_CAP cuts print alone; the other dims and the hours stay", async () => {
    fake((q) => {
      if (q.includes("blob14 AS value")) return Response.json({ data: [], rows_before_limit_at_least: ROW_CAP + 5 });
      if (q.includes("toStartOfHour")) return [{ bucket: "2026-11-19 10:00:00", n: 3 }];
      return q.includes("blob15 AS value") ? [{ value: "news", n: 2 }] : [];
    });
    const r = await aeDetail(env, new Date(to.getTime() - DAY), to, { domainIds: null, linkIds: null });
    expect([r.cut, r.dims, r.hours]).toEqual([["print"], [{ dim: "utm_source", value: "news", clicks: 2 }], [{ bucket: "2026-11-19T10:00:00Z", clicks: 3 }]]);
  });
  it("one chunk falling back makes every print row per code, so a code is one row across chunks", async () => {
    let n = 0;
    fake((q) => {
      if (q.includes("blob2 AS linkId, blob14")) return ++n === 1 ? Response.json({ data: [], rows_before_limit_at_least: ROW_CAP + 5 }) : [{ linkId: "l9", value: "abc123", n: 4 }];
      return q.includes("blob14 AS value") ? [{ value: "abc123", n: 6 }] : [];
    });
    const ids = Array.from({ length: 700 }, (_, i) => `dom${i}`); // 2 chunks
    const r = await aeDetail(env, new Date(to.getTime() - DAY), to, { domainIds: ids, linkIds: null });
    expect(r.printByCode).toBe(true);
    expect(r.dims).toEqual([{ dim: "print", value: "abc123", clicks: 10, linkId: "" }]);
  });
  it("a domain list too big even for the S10 detail is refused before any query", async () => {
    const qs = fake();
    const ids = Array.from({ length: 3600 }, (_, i) => `dom${i}`); // 9 chunks x (4 + 2) = 54 queries
    await expect(aeDetail(env, new Date(to.getTime() - 89 * DAY), to, { domainIds: ids, linkIds: null })).rejects.toMatchObject({ message: "ae_scope_too_big" });
    expect(qs).toEqual([]);
  });
  it("any other print failure still fails the read", async () => {
    fake((q) => (q.includes("blob14") ? new Response("no", { status: 502 }) : []));
    await expect(aeDetail(env, new Date(to.getTime() - DAY), to, { domainIds: null, linkIds: null })).rejects.toMatchObject({ message: "ae_502" });
  });
});
