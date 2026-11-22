import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, blocked, hit, limitKey } from "../src/limits";
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
