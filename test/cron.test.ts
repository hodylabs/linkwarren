import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeAudit, rolledThrough, rollup, watermarkStmt } from "../src/cron";
import type { Env } from "../src/env";
import worker from "../src/index";

const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const NOW = Date.parse("2026-11-20T12:00:00Z") / 1000;
const CUTOFF = NOW - 1096 * 86400;
const ae: Env = { ...env, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" };

/** Canned AE rows for 11-18 (link l1: 3 qr, 2 typed, 4 bots, 2 visitors) and 11-19 (link l2: 1 typed). */
function reply(q: string): unknown[] {
  if (q.includes("blob7 AS source"))
    return [
      { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "qr", kind: "human", n: 3 },
      { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "typed", kind: "human", n: 2 },
      { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", slug: "spring", source: "typed", kind: "bot", n: 4 },
      { bucket: "2026-11-19 00:00:00", domainId: "d1", linkId: "l2", slug: "fall", source: "typed", kind: "human", n: 1 },
    ];
  if (q.includes("COUNT(DISTINCT")) return [{ bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", n: 2 }];
  if (q.includes("blob4 AS value"))
    return [
      { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", value: "CA", n: 4 },
      { bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", value: "US", n: 1 },
    ];
  if (q.includes("blob5 AS value")) return [{ bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "l1", value: "mobile", n: 5 }];
  return [];
}
function stubAe(status = 200) {
  const bodies: { query: string; params: Record<string, string> }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SQL_URL) throw new Error("unexpected fetch");
    bodies.push(JSON.parse(String(init?.body)));
    if (status !== 200) return new Response("no", { status });
    return Response.json({ data: reply(bodies[bodies.length - 1].query) });
  });
  return { bodies, spy };
}

const all = (sql: string) => env.DB.prepare(sql).all().then((r) => r.results);
const setMark = (v: string) => env.DB.prepare("INSERT OR REPLACE INTO analytics_state (k, v) VALUES ('rolled_through', ?)").bind(v).run();
const daily = () => all("SELECT day, link_id, domain_id, slug, qr, typed, bots, visitors FROM clicks_daily ORDER BY day, link_id");
const dims = () => all("SELECT day, link_id, domain_id, dim, value, clicks FROM clicks_daily_dim ORDER BY day, link_id, dim, value");

beforeEach(async () => {
  await env.DB.batch(["clicks_daily", "clicks_daily_dim", "analytics_state", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => vi.restoreAllMocks());

describe("rollup", () => {
  it("no state: starts at today - 89, at most 31 days, one AE round", async () => {
    const f = stubAe();
    const days = await rollup(ae, NOW);
    expect(days).toHaveLength(31);
    expect(days[0]).toBe("2026-08-23");
    expect(days[30]).toBe("2026-09-22");
    expect(await rolledThrough(ae)).toBe("2026-09-22");
    expect(f.bodies).toHaveLength(5);
    expect(f.bodies[0].params.from).toBe("2026-08-23T00:00:00Z");
    expect(f.bodies[0].params.to).toBe("2026-09-23T00:00:00Z");
  });

  it("writes the days after the watermark with the AE rows; a re-run gives identical rows", async () => {
    stubAe();
    await setMark("2026-11-17");
    expect(await rollup(ae, NOW)).toEqual(["2026-11-18", "2026-11-19"]);
    expect(await rolledThrough(ae)).toBe("2026-11-19");
    const want = [
      { day: "2026-11-18", link_id: "l1", domain_id: "d1", slug: "spring", qr: 3, typed: 2, bots: 4, visitors: 2 },
      { day: "2026-11-19", link_id: "l2", domain_id: "d1", slug: "fall", qr: 0, typed: 1, bots: 0, visitors: 0 },
    ];
    const wantDims = [
      { day: "2026-11-18", link_id: "l1", domain_id: "d1", dim: "country", value: "CA", clicks: 4 },
      { day: "2026-11-18", link_id: "l1", domain_id: "d1", dim: "country", value: "US", clicks: 1 },
      { day: "2026-11-18", link_id: "l1", domain_id: "d1", dim: "device", value: "mobile", clicks: 5 },
    ];
    expect(await daily()).toEqual(want);
    expect(await dims()).toEqual(wantDims);
    // Review Focus 4: rolling the same days again replaces, never adds.
    await setMark("2026-11-17");
    await rollup(ae, NOW);
    expect(await daily()).toEqual(want);
    expect(await dims()).toEqual(wantDims);
  });

  it("the watermark never moves back", async () => {
    await setMark("2026-11-19");
    await env.DB.batch([watermarkStmt(ae, "2026-11-10")]);
    expect(await rolledThrough(ae)).toBe("2026-11-19");
  });

  it("a day with zero clicks advances the watermark and holds no rows", async () => {
    stubAe();
    await setMark("2026-11-18");
    expect(await rollup(ae, Date.parse("2026-11-21T12:00:00Z") / 1000)).toEqual(["2026-11-19", "2026-11-20"]);
    expect(await rolledThrough(ae)).toBe("2026-11-20");
    expect((await daily()).map((r) => r.day)).toEqual(["2026-11-19"]);
  });

  it("nothing to do when the watermark is yesterday", async () => {
    const f = stubAe();
    await setMark("2026-11-19");
    expect(await rollup(ae, NOW)).toEqual([]);
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("AE not configured: nothing written, no fetch", async () => {
    const f = stubAe();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await setMark("2026-11-17");
    expect(await rollup(env, NOW)).toEqual([]);
    expect(f.spy).not.toHaveBeenCalled();
    expect(await rolledThrough(env)).toBe("2026-11-17");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("a failing batch stops the loop: watermark at the last good day", async () => {
    stubAe();
    await setMark("2026-11-17");
    let calls = 0;
    const db = env.DB;
    const e = {
      ...ae,
      DB: {
        prepare: (s: string) => db.prepare(s),
        batch: (s: D1PreparedStatement[]) => (++calls === 2 ? Promise.reject(new Error("d1 down")) : db.batch(s)),
      },
    } as unknown as Env;
    await expect(rollup(e, NOW)).rejects.toThrow("d1 down");
    expect(await rolledThrough(ae)).toBe("2026-11-18");
    expect((await daily()).map((r) => r.day)).toEqual(["2026-11-18"]);
  });

  it("many links per day are chunked under the bound-parameter limit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      const q = JSON.parse(String(init?.body)).query as string;
      const rows = Array.from({ length: 30 }, (_, i) => ({ bucket: "2026-11-19 00:00:00", domainId: "d1", linkId: `k${i}`, slug: `s${i}`, source: "typed", kind: "human", value: "CA", n: 1 }));
      return Response.json({ data: q.includes("blob7 AS source") || q.includes("blob4 AS value") ? rows : [] });
    });
    await setMark("2026-11-18");
    await rollup(ae, NOW);
    expect(await daily()).toHaveLength(30);
    expect(await dims()).toHaveLength(30);
  });
});

describe("purgeAudit", () => {
  const add = (at: number) =>
    env.DB.prepare("INSERT INTO audit_log (at, actor_id, action, target_type, target_id, detail) VALUES (?, 'u1', 'link.create', 'link', 'x', '{}')").bind(at).run();

  it("deletes only rows older than 3 years and audits it as system", async () => {
    await add(CUTOFF - 1);
    await add(CUTOFF + 1);
    expect(await purgeAudit(env, NOW)).toBe(1);
    const rows = (await all("SELECT at, actor_id, action, target_type, target_id, detail FROM audit_log ORDER BY id")) as Record<string, unknown>[];
    expect(rows.map((r) => r.at)).toContain(CUTOFF + 1);
    expect(rows.map((r) => r.at)).not.toContain(CUTOFF - 1);
    const p = rows.filter((r) => r.action === "audit.purge");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ actor_id: "system", target_type: "audit", target_id: "audit_log" });
    expect(JSON.parse(String(p[0].detail))).toEqual({ deleted: 1, before: CUTOFF });
  });

  it("nothing old: no delete, no audit row", async () => {
    await add(CUTOFF + 1);
    expect(await purgeAudit(env, NOW)).toBe(0);
    expect(await all("SELECT id FROM audit_log WHERE action = 'audit.purge'")).toHaveLength(0);
  });
});

describe("scheduled", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const ctl = { cron: "15 0 * * *", scheduledTime: NOW * 1000, noRetry() {} } as ScheduledController;

  it("purges even when the rollup throws", async () => {
    stubAe(500);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setMark("2026-11-17");
    await env.DB.prepare("INSERT INTO audit_log (at, actor_id, action, target_type, target_id, detail) VALUES (?, 'u1', 'x', 'x', 'x', '{}')").bind(CUTOFF - 5).run();
    await worker.scheduled(ctl, ae, ctx);
    expect(err).toHaveBeenCalledWith("analytics rollup failed", "AeError");
    expect(await all("SELECT id FROM audit_log WHERE action = 'audit.purge'")).toHaveLength(1);
    expect(await rolledThrough(ae)).toBe("2026-11-17");
  });

  it("the default export still serves fetch", async () => {
    const res = await exports.default.fetch("https://dash.test/healthz");
    expect(await res.json()).toEqual({ ok: true });
  });
});
