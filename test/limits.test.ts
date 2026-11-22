import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneExpired, RUN_WRITE_BUDGET } from "../src/cron";
import { LIMITS, blocked, fits, hit, hitBy, hitCount, limitKey } from "../src/limits";
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
