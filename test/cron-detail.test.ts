// S13 detail rollup (R2, R3): its own watermark, 1 day per run from today-89, top 20 per link, domain, dim and day plus "(other)".
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capDetail, DAY_WRITE_BUDGET, DETAIL_TOP, detailRolledThrough, rollupDetail, RUN_WRITE_BUDGET } from "../src/cron";
import type { Env } from "../src/env";
import worker from "../src/index";

const NOW = Date.parse("2026-11-20T12:00:00Z") / 1000;
const ae: Env = { ...env, CLICKS: { writeDataPoint() {} } as unknown as AnalyticsEngineDataset, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" };
type Body = { query: string; params: Record<string, string> };

function stubAe(reply: (q: string) => Record<string, unknown>[] | Response = () => []) {
  const bodies: Body[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    bodies.push(b);
    const r = reply(b.query);
    return r instanceof Response ? r : Response.json({ data: r });
  });
  return bodies;
}
const rows = () => env.DB.prepare("SELECT day, link_id, domain_id, dim, value, clicks FROM clicks_daily_detail ORDER BY dim, clicks DESC, value").all().then((r) => r.results);
const state = (k: string) => env.DB.prepare("SELECT v FROM analytics_state WHERE k = ?").bind(k).first<{ v: string }>().then((r) => r?.v);

beforeEach(async () => {
  await env.DB.batch(["clicks_daily", "clicks_daily_dim", "clicks_daily_detail", "analytics_state"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => vi.restoreAllMocks());

describe("capDetail", () => {
  it("keeps the top 20 per link, domain and dim, sums the rest into (other), ties broken by value", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ linkId: "l", domainId: "d", dim: "place", value: `p${String(i).padStart(2, "0")}`, clicks: i < 3 ? 10 : 1 }));
    const out = capDetail([...many, { linkId: "l", domainId: "d", dim: "os", value: "iOS", clicks: 2 }, { linkId: "l", domainId: "d", dim: "os", value: "x", clicks: 0 }]);
    const place = out.filter((r) => r.dim === "place");
    expect(place).toHaveLength(DETAIL_TOP + 1);
    expect(place.slice(0, 4).map((r) => r.value)).toEqual(["p00", "p01", "p02", "p03"]);
    expect(place.at(-1)).toMatchObject({ value: "(other)", clicks: 5 }); // p20..p24, one click each
    expect(out.filter((r) => r.dim === "os")).toEqual([{ linkId: "l", domainId: "d", dim: "os", value: "iOS", clicks: 2 }]);
  });
  it("a visitor's own '(other)' value is folded into the rest, so the key stays unique", () => {
    const out = capDetail([{ linkId: "l", domainId: "d", dim: "utm_source", value: "(other)", clicks: 4 }, { linkId: "l", domainId: "d", dim: "utm_source", value: "a", clicks: 1 }]);
    expect(out).toEqual([{ linkId: "l", domainId: "d", dim: "utm_source", value: "a", clicks: 1 }, { linkId: "l", domainId: "d", dim: "utm_source", value: "(other)", clicks: 4 }]);
  });
});

describe("rollupDetail", () => {
  it("no state: rolls today-89 alone, 8 queries, human clicks only, QR-only prints and non-empty UTM", async () => {
    const bodies = stubAe((q) => (q.includes("blob10 AS value") ? [{ linkId: "l1", domainId: "d1", value: "iOS", n: 3 }] : []));
    expect(await rollupDetail(ae, NOW)).toBe("2026-08-23");
    expect(await detailRolledThrough(ae)).toBe("2026-08-23");
    expect(bodies).toHaveLength(8);
    expect(bodies.every((b) => b.query.includes("blob8 = $human") && b.params.from === "2026-08-23T00:00:00Z")).toBe(true);
    expect(bodies.find((b) => b.query.includes("blob14 AS value"))!.query).toContain("blob7 = $qr");
    expect(bodies.find((b) => b.query.includes("blob17 AS value"))!.query).toContain("blob17 != $none");
    expect(await rows()).toEqual([{ day: "2026-08-23", link_id: "l1", domain_id: "d1", dim: "os", value: "iOS", clicks: 3 }]);
    expect(await state("rollup_writes")).toBe(`2026-11-20|${1 * 3 + 4}`);
  });
  it("one day per run, after its own watermark, never past today-2; a re-run replaces the day", async () => {
    stubAe((q) => (q.includes("blob11 AS value") ? [{ linkId: "l1", domainId: "d1", value: "Safari", n: 1 }] : []));
    await env.DB.prepare("INSERT INTO analytics_state (k, v) VALUES ('detail_rolled_through', '2026-11-17')").run();
    expect(await rollupDetail(ae, NOW)).toBe("2026-11-18");
    expect(await rollupDetail(ae, NOW)).toBeNull(); // 11-18 is today-2
    await env.DB.prepare("UPDATE analytics_state SET v = '2026-11-17' WHERE k = 'detail_rolled_through'").run();
    expect(await rollupDetail(ae, NOW)).toBe("2026-11-18");
    expect(await rows()).toHaveLength(1);
  });
  it("never touches the main rollup's rows or watermark", async () => {
    stubAe();
    await env.DB.prepare("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES ('2026-08-23','l1','d1','country','US',2)").run();
    await env.DB.prepare("INSERT INTO analytics_state (k, v) VALUES ('rolled_through', '2026-11-18')").run();
    await rollupDetail(ae, NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM clicks_daily_dim").first<{ n: number }>())!.n).toBe(1);
    expect(await state("rolled_through")).toBe("2026-11-18");
  });
  it("stays inside the shared write budgets: over the run's or the day's left, nothing is written", async () => {
    stubAe((q) => (q.includes("blob10 AS value") ? [{ linkId: "l1", domainId: "d1", value: "iOS", n: 3 }] : []));
    expect(await rollupDetail(ae, NOW, { writes: RUN_WRITE_BUDGET - 6 })).toBeNull();
    await env.DB.prepare("INSERT INTO analytics_state (k, v) VALUES ('rollup_writes', ?)").bind(`2026-11-20|${DAY_WRITE_BUDGET - 6}`).run();
    expect(await rollupDetail(ae, NOW)).toBeNull();
    expect(await rows()).toEqual([]);
    expect(await detailRolledThrough(ae)).toBeNull();
    const spent = { writes: 100 };
    await env.DB.prepare("DELETE FROM analytics_state").run();
    expect(await rollupDetail(ae, NOW, spent)).toBe("2026-08-23");
    expect(spent.writes).toBe(107);
  });
  it("a dim over ROW_CAP is left out for that day alone: the other dims are kept and the watermark moves on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAe((q) => {
      if (q.includes("blob13 AS value")) return Response.json({ data: [], rows_before_limit_at_least: 99999 });
      return q.includes("blob10 AS value") ? [{ linkId: "l1", domainId: "d1", value: "iOS", n: 3 }] : [];
    });
    expect(await rollupDetail(ae, NOW)).toBe("2026-08-23");
    expect(warn).toHaveBeenCalledWith("analytics detail rollup day=2026-08-23 left out: place (too many rows)");
    expect(await rows()).toEqual([{ day: "2026-08-23", link_id: "l1", domain_id: "d1", dim: "os", value: "iOS", clicks: 3 }]);
  });
  it("any other failure writes nothing and throws, the watermark stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubAe(() => new Response("no", { status: 500 }));
    await expect(rollupDetail(ae, NOW)).rejects.toMatchObject({ message: "ae_500" });
    expect(await detailRolledThrough(ae)).toBeNull();
    expect(await rows()).toEqual([]);
  });
  it("a day whose rows alone could never fit one run's budget drops its biggest dims until it fits, keeping the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const links = (n: number) => Array.from({ length: n }, (_, i) => ({ linkId: `k${i}`, domainId: "d1", value: "x", n: 1 }));
    // (1800 + 1600 + 5) rows x 3 > 10,000; without os (the biggest) it is 1605 rows.
    stubAe((q) => (q.includes("blob10 AS value") ? links(1800) : q.includes("blob11 AS value") ? links(1600) : q.includes("blob12 AS value") ? links(5) : []));
    expect(await rollupDetail(ae, NOW)).toBe("2026-08-23");
    expect(warn).toHaveBeenCalledWith("analytics detail rollup day=2026-08-23 left out: os (too many rows)");
    const n = await env.DB.prepare("SELECT dim, COUNT(*) n FROM clicks_daily_detail GROUP BY dim ORDER BY dim").all();
    expect(n.results).toEqual([{ dim: "browser", n: 1600 }, { dim: "language", n: 5 }]);
  });
  it("not configured: nothing read or written", async () => {
    const bodies = stubAe();
    expect(await rollupDetail(env, NOW)).toBeNull();
    expect(bodies).toEqual([]);
  });
  it("a failing detail rollup never stops the hourly run's other steps", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    stubAe((q) => (q.includes("blob10 AS value") ? new Response("no", { status: 500 }) : []));
    const e = env as unknown as Record<string, unknown>;
    const prev = { CLICKS: e.CLICKS, CF_ACCOUNT_ID: e.CF_ACCOUNT_ID, AE_READ_TOKEN: e.AE_READ_TOKEN };
    Object.assign(e, { CLICKS: ae.CLICKS, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" });
    try {
      await worker.scheduled({ cron: "15 * * * *", scheduledTime: NOW * 1000 + 900_000, noRetry() {} } as ScheduledController, env, {} as ExecutionContext);
    } finally {
      Object.assign(e, prev);
    }
    expect(err).toHaveBeenCalledWith("analytics detail rollup failed", "AeError");
    expect(await state("rolled_through")).toBe("2026-08-26"); // the main rollup ran its 3 days
  });
});
