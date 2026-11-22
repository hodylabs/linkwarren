import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_WRITE_BUDGET, MAX_DAYS, PRUNE_MAX, pruneExpired, PURGE_MAX, purgeAudit, rolledThrough, rollup, RUN_WRITE_BUDGET, watermarkStmt } from "../src/cron";
import type { Env } from "../src/env";
import worker from "../src/index";

const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const NOW = Date.parse("2026-11-20T12:00:00Z") / 1000;
const NOW2 = Date.parse("2026-11-21T12:00:00Z") / 1000; // rolls through 11-19
const CUTOFF = NOW - 1096 * 86400;
const ae: Env = { ...env, CLICKS: { writeDataPoint() {} } as unknown as AnalyticsEngineDataset, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" };

describe("rollup keys", () => {
  it("one day may hold a link twice, once per domain it was clicked on", async () => {
    await env.DB.prepare("DELETE FROM clicks_daily").run();
    await env.DB.prepare("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES ('2026-11-18','l1','d1','s',1,0),('2026-11-18','l1','d2','s',0,1)").run();
    await env.DB.prepare("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES ('2026-11-18','l1','d1','country','CA',1),('2026-11-18','l1','d2','country','CA',1)").run();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM clicks_daily WHERE link_id = 'l1'").first<{ n: number }>())!.n).toBe(2);
    await env.DB.batch(["clicks_daily", "clicks_daily_dim"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });
});

/** Canned AE rows (aeDay shapes, one query per day): 11-18 has link l1 (3 qr, 2 typed, 4 bots, 2 visitors), 11-19 link l2 (1 typed). */
function reply(q: string, from: string): unknown[] {
  const day = from.slice(0, 10);
  if (q.includes("argMax(blob3")) {
    if (day === "2026-11-18") return [{ linkId: "l1", domainId: "d1", slug: "spring", qr: 3, typed: 2, bots: 4 }];
    if (day === "2026-11-19") return [{ linkId: "l2", domainId: "d1", slug: "fall", qr: 0, typed: 1, bots: 0 }];
    return [];
  }
  if (day !== "2026-11-18") return [];
  if (q.includes("COUNT(DISTINCT")) return [{ linkId: "l1", domainId: "d1", n: 2 }];
  if (q.includes("blob4 AS value"))
    return [
      { linkId: "l1", domainId: "d1", value: "CA", n: 4 },
      { linkId: "l1", domainId: "d1", value: "US", n: 1 },
    ];
  if (q.includes("blob5 AS value")) return [{ linkId: "l1", domainId: "d1", value: "mobile", n: 5 }];
  return [];
}
function stubAe(status = 200) {
  const bodies: { query: string; params: Record<string, string> }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== SQL_URL) throw new Error("unexpected fetch");
    bodies.push(JSON.parse(String(init?.body)));
    if (status !== 200) return new Response("no", { status });
    const b = bodies[bodies.length - 1];
    return Response.json({ data: reply(b.query, b.params.from) });
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
  it("no state: starts at today - 88, at most 3 days, one AE round (5 queries) per day", async () => {
    const f = stubAe();
    const days = await rollup(ae, NOW);
    expect(MAX_DAYS).toBe(3);
    expect(days).toEqual(["2026-08-24", "2026-08-25", "2026-08-26"]);
    expect(await rolledThrough(ae)).toBe("2026-08-26");
    expect(f.bodies).toHaveLength(15);
    expect(new Set(f.bodies.map((b) => `${b.params.from}..${b.params.to}`))).toEqual(
      new Set(["2026-08-24T00:00:00Z..2026-08-25T00:00:00Z", "2026-08-25T00:00:00Z..2026-08-26T00:00:00Z", "2026-08-26T00:00:00Z..2026-08-27T00:00:00Z"]),
    );
  });

  it("a 90-day backlog of busy days: at most 3 days per run, writes within the run budget, the next run continues (I1, I2)", async () => {
    const LINKS = 300; // 300 tot rows + 900 dim rows a day = 3,604 counted writes
    const busy = (q: string) => {
      const links = Array.from({ length: LINKS }, (_, i) => `k${i}`);
      if (q.includes("argMax(blob3")) return links.map((linkId) => ({ linkId, domainId: "d1", slug: linkId, qr: 1, typed: 1, bots: 0 }));
      if (q.includes("COUNT(DISTINCT")) return links.map((linkId) => ({ linkId, n: 1 }));
      return links.map((linkId) => ({ linkId, domainId: "d1", value: "x", n: 1 }));
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => Response.json({ data: busy(JSON.parse(String(init?.body)).query) }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let written = 0;
    const db = env.DB;
    const counting = {
      ...ae,
      DB: {
        prepare: (q: string) => db.prepare(q),
        batch: async (st: D1PreparedStatement[]) => {
          const r = await db.batch(st);
          written += r.reduce((n, x) => n + (x.meta.rows_written ?? 0), 0);
          return r;
        },
      },
    } as unknown as Env;
    const first = await rollup(counting, NOW);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(first).toEqual(["2026-08-24", "2026-08-25"]); // a third day would pass RUN_WRITE_BUDGET
    expect(written).toBeLessThanOrEqual(RUN_WRITE_BUDGET);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^analytics rollup paused day=2026-08-26 /));
    expect(await rollup(counting, NOW + 3600)).toEqual(["2026-08-26", "2026-08-27"]);
    expect(await rolledThrough(ae)).toBe("2026-08-27");
    console.info(`I2 seed: 4 busy days wrote ${written} D1 rows (2 runs)`);
  });

  it("the daily write budget stops hourly runs before the account's D1 write cap", async () => {
    stubAe();
    await setMark("2026-11-17");
    const today = "2026-11-21";
    await env.DB.prepare("INSERT INTO analytics_state (k, v) VALUES ('rollup_writes', ?)").bind(`${today}|${DAY_WRITE_BUDGET - 5}`).run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await rollup(ae, NOW2)).toEqual([]);
    expect(await rolledThrough(ae)).toBe("2026-11-17");
    // A new UTC day starts a fresh count.
    await env.DB.prepare("UPDATE analytics_state SET v = ? WHERE k = 'rollup_writes'").bind(`2026-11-20|${DAY_WRITE_BUDGET}`).run();
    expect(await rollup(ae, NOW2)).toEqual(["2026-11-18", "2026-11-19"]);
  });

  it("a capped Analytics Engine answer writes nothing for that day (never a partial day)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      const q = JSON.parse(String(init?.body)).query as string;
      const rows = q.includes("blob4 AS value") ? Array.from({ length: 2001 }, (_, i) => ({ linkId: `k${i}`, domainId: "d1", value: "CA", n: 1 })) : [];
      return Response.json({ data: rows, rows: rows.length });
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await setMark("2026-11-17");
    await expect(rollup(ae, NOW2)).rejects.toThrow("ae_truncated");
    expect(err).toHaveBeenCalledWith("analytics rollup failed day=2026-11-18", "ae_truncated");
    expect(await rolledThrough(ae)).toBe("2026-11-17");
    expect(await daily()).toEqual([]);
    expect(await dims()).toEqual([]);
  });

  it("writes the days after the watermark with the AE rows; a re-run gives identical rows", async () => {
    stubAe();
    await setMark("2026-11-17");
    expect(await rollup(ae, NOW2)).toEqual(["2026-11-18", "2026-11-19"]);
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
    await rollup(ae, NOW2);
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
    expect(await rollup(ae, Date.parse("2026-11-22T12:00:00Z") / 1000)).toEqual(["2026-11-19", "2026-11-20"]);
    expect(await rolledThrough(ae)).toBe("2026-11-20");
    expect((await daily()).map((r) => r.day)).toEqual(["2026-11-19"]);
  });

  it("nothing to do when the watermark is today-2", async () => {
    const f = stubAe();
    await setMark("2026-11-18");
    expect(await rollup(ae, NOW)).toEqual([]);
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("a run at 00:15 on day D rolls through D-2, not D-1", async () => {
    stubAe();
    await setMark("2026-11-16");
    expect(await rollup(ae, Date.parse("2026-11-20T00:15:00Z") / 1000)).toEqual(["2026-11-17", "2026-11-18"]);
    expect(await rolledThrough(ae)).toBe("2026-11-18");
  });

  it("a failing rollup logs the failing day and the safe ae code, never the token", async () => {
    stubAe(500);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await setMark("2026-11-17");
    await expect(rollup(ae, NOW2)).rejects.toThrow("ae_500");
    expect(err).toHaveBeenCalledWith("analytics rollup failed day=2026-11-18", "ae_500");
    expect(JSON.stringify(err.mock.calls)).not.toContain("tok");
  });

  it("no CLICKS binding: skipped like an unconfigured read", async () => {
    const f = stubAe();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setMark("2026-11-17");
    expect(await rollup({ ...ae, CLICKS: undefined }, NOW2)).toEqual([]);
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
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(rollup(e, NOW2)).rejects.toThrow("d1 down");
    expect(err).toHaveBeenCalledWith("analytics rollup failed day=2026-11-19", "Error");
    expect(await rolledThrough(ae)).toBe("2026-11-18");
    expect((await daily()).map((r) => r.day)).toEqual(["2026-11-18"]);
  });

  it("many links per day are chunked under the bound-parameter limit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      const q = JSON.parse(String(init?.body)).query as string;
      const rows = Array.from({ length: 30 }, (_, i) => ({ domainId: "d1", linkId: `k${i}`, slug: `s${i}`, qr: 0, typed: 1, bots: 0, value: "CA", n: 1 }));
      return Response.json({ data: q.includes("argMax(blob3") || q.includes("blob4 AS value") ? rows : [] });
    });
    await setMark("2026-11-18");
    await rollup(ae, NOW2);
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

  it("deletes at most PURGE_MAX oldest rows per run; the next run continues; deleted is the real count", async () => {
    const n = PURGE_MAX + 3;
    await env.DB.prepare(
      "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?) INSERT INTO audit_log (at, actor_id, action, target_type, target_id, detail) SELECT ?, 'u1', 'link.create', 'link', 'x', '{}' FROM s",
    ).bind(n, CUTOFF - 1).run();
    expect(await purgeAudit(env, NOW)).toBe(PURGE_MAX);
    const left = (await all("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'link.create'")) as { n: number }[];
    expect(left[0].n).toBe(3);
    expect(await purgeAudit(env, NOW)).toBe(3);
    const d = (await all("SELECT detail FROM audit_log WHERE action = 'audit.purge' ORDER BY id")) as { detail: string }[];
    expect(d.map((r) => JSON.parse(r.detail).deleted)).toEqual([PURGE_MAX, 3]);
  });

  it("nothing old: no delete, no audit row", async () => {
    await add(CUTOFF + 1);
    expect(await purgeAudit(env, NOW)).toBe(0);
    expect(await all("SELECT id FROM audit_log WHERE action = 'audit.purge'")).toHaveLength(0);
  });
});

describe("pruneExpired", () => {
  const T = NOW;
  async function fill(expired: number, live: number) {
    await env.DB.batch(["auth_limits", "login_tokens", "auth_challenges", "sessions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)").run();
    const rows = (n: number, old: boolean) => Array.from({ length: n }, (_, i) => `${old ? "o" : "l"}${i}`);
    const stmts: D1PreparedStatement[] = [];
    for (const [old, n] of [[true, expired], [false, live]] as const)
      for (const k of rows(n, old)) {
        const exp = old ? T - 10 : T + 3600;
        stmts.push(
          env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, 1)").bind(`unlock:${k}`, old ? T - 3700 : T - 60),
          env.DB.prepare("INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, 'o@x.com', 1, ?)").bind(k, exp),
          env.DB.prepare("INSERT INTO auth_challenges (challenge, purpose, expires_at) VALUES (?, 'login', ?)").bind(k, exp),
          env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, method, created_at, last_seen_at, expires_at) VALUES (?, ?, 'u1', 'email', 1, 1, ?)").bind(k, `h${k}`, exp),
        );
      }
    for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  }
  const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

  it("deletes expired limiter rows, link tokens, challenges and sessions; keeps live ones; counts 3 writes per row", async () => {
    await fill(3, 2);
    expect(await pruneExpired(env, T, RUN_WRITE_BUDGET)).toBe(4 * 3 * 3);
    for (const t of ["auth_limits", "login_tokens", "auth_challenges", "sessions"]) expect([t, await count(t)]).toEqual([t, 2]);
  });

  it("stays inside the budget it is given and at most PRUNE_MAX rows per table; the next run continues", async () => {
    await fill(5, 0);
    expect(await pruneExpired(env, T, 3 * 7)).toBe(21); // 5 limiter rows, then 2 link tokens, then out of budget
    expect([await count("auth_limits"), await count("login_tokens"), await count("auth_challenges")]).toEqual([0, 3, 5]);
    expect(await pruneExpired(env, T, 0)).toBe(0);
    expect(PRUNE_MAX).toBe(2000);
  });

  it("runs every hour from scheduled, with what the rollup left of the run budget", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await fill(2, 1);
    await worker.scheduled({ cron: "15 * * * *", scheduledTime: Date.parse("2026-11-20T12:15:00Z"), noRetry() {} } as ScheduledController, env, {} as ExecutionContext);
    expect([await count("auth_limits"), await count("sessions")]).toEqual([1, 1]);
  });

  it("counts pruning in the daily write budget and prunes nothing once the day is spent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctl = { cron: "15 * * * *", scheduledTime: Date.parse("2026-11-20T12:15:00Z"), noRetry() {} } as ScheduledController;
    const mark = async () => (await env.DB.prepare("SELECT v FROM analytics_state WHERE k = 'rollup_writes'").first<{ v: string }>())?.v;
    await fill(2, 1);
    await env.DB.prepare("INSERT OR REPLACE INTO analytics_state (k, v) VALUES ('rollup_writes', ?)").bind(`2026-11-20|${DAY_WRITE_BUDGET}`).run();
    await worker.scheduled(ctl, env, {} as ExecutionContext);
    expect([await count("auth_limits"), await count("sessions")]).toEqual([3, 3]);
    await env.DB.prepare("INSERT OR REPLACE INTO analytics_state (k, v) VALUES ('rollup_writes', '2026-11-20|100')").run();
    await worker.scheduled(ctl, env, {} as ExecutionContext);
    expect(await mark()).toBe(`2026-11-20|${100 + 4 * (2 * 3 + 2)}`); // 4 tables x (2 rows x 3 writes + 2 for the counter)
  });

  it("reserves the counter write inside the budget and rolls a deletion back when its charge fails", async () => {
    await fill(3, 0);
    await env.DB.prepare("DELETE FROM analytics_state WHERE k = 'rollup_writes'").run();
    expect(await pruneExpired(env, T, 3 + 2, { writes: 0 }, "2026-11-20")).toBe(5); // one row and its counter charge, nothing more
    expect(await count("auth_limits")).toBe(2);
    expect((await env.DB.prepare("SELECT v FROM analytics_state WHERE k = 'rollup_writes'").first<{ v: string }>())?.v).toBe("2026-11-20|5");
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => (q.includes("INSERT OR REPLACE INTO analytics_state") ? real("SELECT no_such_fn()") : real(q)));
    await expect(pruneExpired(env, T, RUN_WRITE_BUDGET, { writes: 0 }, "2026-11-20")).rejects.toThrow();
    spy.mockRestore();
    expect(await count("auth_limits")).toBe(2); // the failed charge took its deletion back with it
  });

  it("reports writes from tables pruned before a later table fails", async () => {
    await fill(2, 0);
    const spent = { writes: 0 };
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      if (q.includes("FROM auth_challenges")) throw new Error("boom");
      return real(q);
    });
    await expect(pruneExpired(env, T, RUN_WRITE_BUDGET, spent)).rejects.toThrow("boom");
    spy.mockRestore();
    expect(spent.writes).toBe(2 * 2 * 3); // auth_limits and login_tokens done, 3 writes per row
  });
});

describe("scheduled", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const at = (iso: string) => ({ cron: "15 * * * *", scheduledTime: Date.parse(iso), noRetry() {} }) as ScheduledController;
  const ctl = at("2026-11-21T00:15:00Z");

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

  it("only the 00:15 UTC run purges; every hourly run rolls up", async () => {
    stubAe();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setMark("2026-11-16");
    await env.DB.prepare("INSERT INTO audit_log (at, actor_id, action, target_type, target_id, detail) VALUES (?, 'u1', 'x', 'x', 'x', '{}')").bind(CUTOFF - 5).run();
    await worker.scheduled(at("2026-11-20T13:15:00Z"), ae, ctx);
    expect(await all("SELECT id FROM audit_log WHERE action = 'audit.purge'")).toHaveLength(0);
    expect(await rolledThrough(ae)).toBe("2026-11-18");
    await worker.scheduled(at("2026-11-21T00:15:00Z"), ae, ctx);
    expect(await all("SELECT id FROM audit_log WHERE action = 'audit.purge'")).toHaveLength(1);
  });

  it("the default export still serves fetch", async () => {
    const res = await exports.default.fetch("https://dash.test/healthz");
    expect(await res.json()).toEqual({ ok: true });
  });
});
