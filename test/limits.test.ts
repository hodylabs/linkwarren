import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneExpired, RUN_WRITE_BUDGET } from "../src/cron";
import { DAY_KEYS_SQL, LIMITS, blocked, fits, hit, hitAll, hitBy, hitCount, limitKey } from "../src/limits";
import { sha256Hex } from "../src/session";

beforeEach(async () => { await env.DB.prepare("DELETE FROM auth_limits").run(); });
const rowOf = (key: string) => env.DB.prepare("SELECT * FROM auth_limits WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();

describe("hit", () => {
  it("allows n hits in a window, refuses the next, and resets after the window", async () => {
    const got: boolean[] = [];
    for (let i = 0; i < 6; i++) got.push(await hit(env, "k", LIMITS.address));
    expect(got).toEqual([true, true, true, true, true, false]);
    await env.DB.prepare("UPDATE auth_limits SET window_start = window_start - ? WHERE key = 'k'").bind(LIMITS.address.s).run();
    expect(await hit(env, "k", LIMITS.address)).toBe(true);
    expect((await rowOf("k"))!.count).toBe(1);
  });

  it("is atomic: two concurrent hits on a fresh key count 2", async () => {
    await Promise.all([hit(env, "c", LIMITS.ip), hit(env, "c", LIMITS.ip)]);
    expect((await rowOf("c"))!.count).toBe(2);
  });
});

describe("blocked", () => {
  it("is read-only and true once the window holds n hits", async () => {
    expect(await blocked(env, "f", { n: 2, s: 900 })).toBe(false);
    expect(await rowOf("f")).toBeNull();
    await hit(env, "f", { n: 2, s: 900 });
    expect(await blocked(env, "f", { n: 2, s: 900 })).toBe(false);
    await hit(env, "f", { n: 2, s: 900 });
    const before = await rowOf("f");
    expect(await blocked(env, "f", { n: 2, s: 900 })).toBe(true);
    expect(await rowOf("f")).toEqual(before);
    await env.DB.prepare("UPDATE auth_limits SET window_start = window_start - 900 WHERE key = 'f'").run();
    expect(await blocked(env, "f", { n: 2, s: 900 })).toBe(false);
  });
});

describe("limitKey", () => {
  it("builds the documented keys", async () => {
    expect(await limitKey.addr("A@Example.com")).toBe(`addr:${await sha256Hex("a@example.com")}`);
    expect(limitKey.ip("203.0.113.0/24")).toBe("ip:203.0.113.0/24");
    expect(limitKey.ip(null)).toBe("ip:none");
    expect(limitKey.fail(null)).toBe("fail:none");
    expect(limitKey.inst).toBe("inst");
  });
});

describe("DAY_KEYS_SQL", () => {
  it("keeps the daily invite budget for a day, not an hour", async () => {
    const r = await env.DB.prepare(`SELECT ${DAY_KEYS_SQL} AS d FROM (SELECT 'invite:day' AS key)`).first<{ d: number }>();
    expect(r?.d).toBe(1);
    expect(LIMITS.inviteDay).toEqual({ n: 40, s: 86400, utc: true });
    expect(limitKey.inviteDay).toBe("invite:day");
  });
});

describe("hitBy and fits", () => {
  const L = { n: 10, s: 900 };
  const rows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_limits").first<{ n: number }>())!.n;

  it("adds n in one upsert: 5 on a new key, then 5 more", async () => {
    expect(await hitBy(env, "b", L, 5)).toBe(5);
    expect(await hitBy(env, "b", L, 5)).toBe(10);
    expect(await hitCount(env, "b", L)).toBe(11);
  });

  it("restarts a window older than s at n", async () => {
    await hitBy(env, "w", L, 7);
    await env.DB.prepare("UPDATE auth_limits SET window_start = window_start - 900 WHERE key = 'w'").run();
    expect(await hitBy(env, "w", L, 3)).toBe(3);
  });

  it("throws on n outside 1..1000 or not an integer, writing nothing", async () => {
    for (const n of [0, 1001, 1.5, -1]) await expect(hitBy(env, "x", L, n)).rejects.toThrow();
    expect(await rows()).toBe(0);
  });

  it("fits is read only and false once count + n would pass the limit", async () => {
    expect(await fits(env, "f", L, 10)).toBe(true);
    expect(await fits(env, "f", L, 11)).toBe(false);
    expect(await rows()).toBe(0);
    await hitBy(env, "f", L, 6);
    const before = await rowOf("f");
    expect(await fits(env, "f", L, 4)).toBe(true);
    expect(await fits(env, "f", L, 5)).toBe(false);
    expect(await rowOf("f")).toEqual(before);
    expect(await rows()).toBe(1);
  });

  it("bulk:kv is a 500 per UTC day key", () => {
    expect(LIMITS.bulkKvDay).toEqual({ n: 500, s: 86400, utc: true });
    expect(limitKey.bulkKv).toBe("bulk:kv");
  });

  it("the hourly prune keeps bulk:kv for a day", async () => {
    const T = 1_800_000_000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('bulk:kv', ?, 3)").bind(T - 3700),
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('ip:old', ?, 1)").bind(T - 3700),
    ]);
    await pruneExpired(env, T, RUN_WRITE_BUDGET);
    expect((await rowOf("bulk:kv"))?.count).toBe(3);
    expect(await rowOf("ip:old")).toBeNull();
    await env.DB.prepare("UPDATE auth_limits SET window_start = ? WHERE key = 'bulk:kv'").bind(T - 86401).run();
    await pruneExpired(env, T, RUN_WRITE_BUDGET);
    expect(await rowOf("bulk:kv")).toBeNull();
  });
});

describe("hitAll", () => {
  const A = { n: 3, s: 900 }, B = { n: 5, s: 900 }, D = { n: 10, s: 86400, utc: true };
  const all = async () => (await env.DB.prepare("SELECT key, window_start, count FROM auth_limits ORDER BY key").all()).results;

  it("charges every key in one statement and counts to n", async () => {
    for (let i = 0; i < 2; i++) expect(await hitAll(env, [{ key: "a", limit: A }, { key: "b", limit: B, charge: 2 }])).toEqual({ ok: true });
    expect((await rowOf("a"))!.count).toBe(2);
    expect((await rowOf("b"))!.count).toBe(4);
    expect(await hitAll(env, [{ key: "a", limit: A }, { key: "b", limit: B, charge: 1 }])).toEqual({ ok: true });
    expect([(await rowOf("a"))!.count, (await rowOf("b"))!.count]).toEqual([3, 5]);
  });

  it("a check-only key with no room at all refuses even before its window has a row", async () => {
    const r = await hitAll(env, [{ key: "a", limit: A }, { key: "z", limit: { n: 0, s: 900 }, charge: 0 }]);
    expect(r).toMatchObject({ ok: false, key: "z" });
    expect(await all()).toEqual([]);
  });

  it("refuses with zero writes when any key would pass its limit, and names the first key over", async () => {
    await hitBy(env, "b", B, 4);
    const before = await all();
    const r = await hitAll(env, [{ key: "a", limit: A }, { key: "b", limit: B, charge: 2 }, { key: "d", limit: D }]);
    expect(r).toEqual({ ok: false, key: "b", counts: [0, 4, 0] });
    expect(await all()).toEqual(before);
  });

  it("refuses a charge larger than the whole limit even when the key has no row yet, with zero writes", async () => {
    const before = await all();
    const r = await hitAll(env, [{ key: "a", limit: A }, { key: "b", limit: B, charge: 6 }]);
    expect(r).toEqual({ ok: false, key: "b", counts: [0, 0] });
    expect(await all()).toEqual(before);
  });

  it("names the first key in checks order when several are over", async () => {
    await hitBy(env, "a", A, 3);
    await hitBy(env, "b", B, 5);
    expect(await hitAll(env, [{ key: "b", limit: B }, { key: "a", limit: A }])).toMatchObject({ ok: false, key: "b" });
    expect(await hitAll(env, [{ key: "a", limit: A }, { key: "b", limit: B }])).toMatchObject({ ok: false, key: "a" });
  });

  it("charge 0 only checks (refused once the window holds n) and writes nothing for that key", async () => {
    expect(await hitAll(env, [{ key: "c", limit: A, charge: 0 }, { key: "a", limit: A }])).toEqual({ ok: true });
    expect(await rowOf("c")).toBeNull();
    await hitBy(env, "c", A, 3);
    expect(await hitAll(env, [{ key: "c", limit: A, charge: 0 }, { key: "a", limit: A }])).toMatchObject({ ok: false, key: "c" });
    expect((await rowOf("a"))!.count).toBe(1);
  });

  it("restarts an expired window at the charge, and a utc window at the day boundary", async () => {
    await hitBy(env, "a", A, 3);
    await env.DB.prepare("UPDATE auth_limits SET window_start = window_start - 900 WHERE key = 'a'").run();
    expect(await hitAll(env, [{ key: "a", limit: A, charge: 2 }])).toEqual({ ok: true });
    expect((await rowOf("a"))!.count).toBe(2);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('d', ?, 10)").bind(now - (now % 86400) - 1).run();
    expect(await hitAll(env, [{ key: "d", limit: D }])).toEqual({ ok: true });
    expect((await rowOf("d"))!.count).toBe(1);
  });

  it("is atomic: two concurrent requests at the edge never both pass", async () => {
    for (let round = 0; round < 5; round++) {
      await env.DB.prepare("DELETE FROM auth_limits").run();
      await hitBy(env, "a", A, 2);
      const r = await Promise.all([hitAll(env, [{ key: "b", limit: B }, { key: "a", limit: A }]), hitAll(env, [{ key: "b", limit: B }, { key: "a", limit: A }])]);
      expect(r.filter((x) => x.ok)).toHaveLength(1);
      expect((await rowOf("a"))!.count).toBe(3);
      expect((await rowOf("b"))!.count).toBe(1);
    }
  });

  it("throws (fail closed for callers) on a D1 error, duplicate keys or no charge", async () => {
    await expect(hitAll(env, [{ key: "a", limit: A }, { key: "a", limit: A }])).rejects.toThrow();
    await expect(hitAll(env, [{ key: "a", limit: A, charge: 0 }])).rejects.toThrow();
    await expect(hitAll(env, [{ key: "a", limit: A, charge: 1.5 }])).rejects.toThrow();
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
    await expect(hitAll(broken, [{ key: "a", limit: A }])).rejects.toThrow("D1 down");
    expect(await all()).toEqual([]);
  });
});
