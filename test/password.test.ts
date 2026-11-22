import { describe, expect, it } from "vitest";
import {
  PASSWORD_DEFAULT_ITERATIONS, PASSWORD_MAX_ITERATIONS, checkPassword, hashPassword, iterationsOf, verifyPassword,
} from "../src/password";

const shape = (n: number) => new RegExp(`^pbkdf2-sha256\\$${n}\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$`);

describe("hashPassword / verifyPassword", () => {
  it("round trips and refuses a wrong password", async () => {
    const h = await hashPassword("correct horse", 1000);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("correct hors", h)).toBe(false);
  });

  it("salts: two hashes of one password differ and both verify", async () => {
    const [a, b] = await Promise.all([hashPassword("same-pass", 1000), hashPassword("same-pass", 1000)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-pass", a)).toBe(true);
    expect(await verifyPassword("same-pass", b)).toBe(true);
  });

  it("stores the format with the iterations passed in", async () => {
    expect(await hashPassword("pw-12345", 1000)).toMatch(shape(1000));
    expect(await hashPassword("pw-12345", PASSWORD_DEFAULT_ITERATIONS)).toMatch(shape(PASSWORD_DEFAULT_ITERATIONS));
  });

  it("verify uses the stored count, not the current default", async () => {
    const h = await hashPassword("old-link-pw", 5000);
    expect(h).toMatch(shape(5000));
    expect(PASSWORD_DEFAULT_ITERATIONS).not.toBe(5000);
    expect(await verifyPassword("old-link-pw", h)).toBe(true);
  });

  it("NFC-normalizes: an NFD typed password verifies against the NFC-set value", async () => {
    const nfc = "paśsword"; // s with acute, precomposed
    const nfd = "paśsword"; // s + combining acute
    expect(nfd).not.toBe(nfc);
    const set = checkPassword(nfc);
    if (!set.ok) throw new Error("expected ok");
    const h = await hashPassword(set.value, 1000);
    expect(await verifyPassword(nfd, h)).toBe(true);
  });

  it("does not trim: a trailing space is significant", async () => {
    const h = await hashPassword("secret-pw", 1000);
    expect(await verifyPassword("secret-pw ", h)).toBe(false);
    const h2 = await hashPassword("secret-pw ", 1000);
    expect(await verifyPassword("secret-pw", h2)).toBe(false);
    expect(await verifyPassword("secret-pw ", h2)).toBe(true);
  });

  it("fails closed on malformed or hostile stored strings, without throwing", async () => {
    const good = await hashPassword("pw-123456", 1000);
    const [, , salt, hash] = good.split("$");
    const bad = [
      "", "md5$x", "pbkdf2-sha256$999999$a$b", "pbkdf2-sha256",
      `pbkdf2-sha256$${PASSWORD_MAX_ITERATIONS + 1}$${salt}$${hash}`, // above the clamp: DoS guard
      `pbkdf2-sha256$0$${salt}$${hash}`,
      `pbkdf2-sha256$-1$${salt}$${hash}`,
      `pbkdf2-sha256$1e3$${salt}$${hash}`,
      `pbkdf2-sha256$01000$${salt}$${hash}`,
      `pbkdf2-sha256$1000$${salt}$${hash}$extra`,
      `pbkdf2-sha256$1000$${salt}=$${hash}`,
      `pbkdf2-sha256$1000$${salt}$${hash.slice(0, -1)}`, // short hash
      `pbkdf2-sha256$1000$${salt.slice(0, -2)}$${hash}`, // short salt
      `pbkdf2-sha256$1000$${salt.replace(/./, "+")}$${hash}`, // not base64url
      `pbkdf2-sha512$1000$${salt}$${hash}`,
      `PBKDF2-SHA256$1000$${salt}$${hash}`,
    ];
    for (const s of bad) expect(await verifyPassword("pw-123456", s), s).toBe(false);
    expect(await verifyPassword("pw-123456", good)).toBe(true);
  });

  it("refuses an oversized typed password before any work, and accepts a 128 code point one", async () => {
    const long = "\u{1F600}".repeat(128);
    const h = await hashPassword(long, 1000);
    expect(await verifyPassword(long, h)).toBe(true);
    expect(await verifyPassword("a".repeat(5000), h)).toBe(false);
  });

  it("refuses a hash tampered in one character", async () => {
    const good = await hashPassword("pw-123456", 1000);
    const flip = good.slice(0, -2) + (good.at(-2) === "A" ? "B" : "A") + good.at(-1);
    expect(await verifyPassword("pw-123456", flip)).toBe(false);
  });
});

describe("iterationsOf", () => {
  it.each([
    [undefined, PASSWORD_DEFAULT_ITERATIONS],
    ["", PASSWORD_DEFAULT_ITERATIONS],
    ["   ", PASSWORD_DEFAULT_ITERATIONS],
    ["abc", PASSWORD_DEFAULT_ITERATIONS],
    ["500", 1000],
    ["999999", PASSWORD_MAX_ITERATIONS],
    [" 20000 ", 20000],
    ["25000.5", PASSWORD_DEFAULT_ITERATIONS],
    ["1e5", PASSWORD_DEFAULT_ITERATIONS],
  ])("%j gives %i", (v, want) => {
    expect(iterationsOf({ PASSWORD_HASH_ITERATIONS: v })).toBe(want);
  });

  it("has the planned constants", () => {
    expect(PASSWORD_DEFAULT_ITERATIONS).toBe(25000);
    expect(PASSWORD_MAX_ITERATIONS).toBe(100000);
  });
});

describe("checkPassword", () => {
  it("counts code points, 8 to 128, no trim, returns the NFC value", () => {
    expect(checkPassword("1234567")).toEqual({ ok: false, reason: "password_short" });
    expect(checkPassword("12345678")).toEqual({ ok: true, value: "12345678" });
    expect(checkPassword("a".repeat(129))).toEqual({ ok: false, reason: "password_long" });
    expect(checkPassword("a".repeat(128)).ok).toBe(true);
    const emoji = "\u{1F600}".repeat(128); // 256 UTF-16 units, 128 code points
    expect(checkPassword(emoji)).toEqual({ ok: true, value: emoji });
    expect(checkPassword("\u{1F600}".repeat(129))).toEqual({ ok: false, reason: "password_long" });
    expect(checkPassword("       ")).toEqual({ ok: false, reason: "password_short" });
    expect(checkPassword(" 1234567")).toEqual({ ok: true, value: " 1234567" });
    expect(checkPassword("paśsword")).toEqual({ ok: true, value: "paśsword" });
  });
});
