import { describe, expect, it, vi } from "vitest";
import { goNext, isSafeNext, nav } from "./next";

// Mirrors the server's safeNext table (test/session.test.ts): a "/" there is false here.
describe("isSafeNext", () => {
  it.each([
    ["/links?q=a", true], ["/", true], ["/a/b#c", true], ["/" + "a".repeat(2047), true],
    ["//evil.example", false], ["/\\evil.example", false], ["https://evil.example", false], ["javascript:alert(1)", false],
    [" /x", false], ["/a\tb", false], ["/a\nb", false], ["/a\u007fb", false], ["/" + "a".repeat(2048), false], [42, false], [null, false], ["", false],
    ["/.//evil.example", false], ["/..//evil.example", false], ["/./\\evil.example", false],
  ])("%j -> %j", (raw, want) => {
    expect(isSafeNext(raw)).toBe(want);
  });
});

describe("goNext", () => {
  it("assigns a safe path and / for anything else", () => {
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => {});
    goNext("/domains?sel=d1");
    goNext("//evil.example");
    goNext(undefined);
    expect(assign.mock.calls).toEqual([["/domains?sel=d1"], ["/"], ["/"]]);
  });
});
