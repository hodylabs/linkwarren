import { describe, expect, it } from "vitest";
import { passwordRule } from "../src/password-rule";

describe("passwordRule", () => {
  it("counts code points after NFC, 8 to 128", () => {
    expect(passwordRule("1234567")).toEqual({ ok: false, reason: "password_short" });
    expect(passwordRule("12345678")).toEqual({ ok: true, value: "12345678" });
    expect(passwordRule("😀".repeat(128)).ok).toBe(true);
    expect(passwordRule("a".repeat(129))).toEqual({ ok: false, reason: "password_long" });
  });
  it("NFD input is composed first: 4 decomposed é are 4 code points, not 8", () => {
    const nfd = "é".repeat(4);
    expect(nfd.length).toBe(8);
    expect(passwordRule(nfd)).toEqual({ ok: false, reason: "password_short" });
    expect(passwordRule("é".repeat(8))).toEqual({ ok: true, value: "é".repeat(8) });
  });
});
