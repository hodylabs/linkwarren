import { describe, expect, it } from "vitest";
import { normalizeHost } from "../src/host";
import { checkDestination, checkSlug, slugKey } from "../src/validate";

describe("normalizeHost", () => {
  it.each([
    ["Go.Example.com.", "go.example.com"],
    ["go.example.com:443", "go.example.com"],
    ["GO.EXAMPLE.COM", "go.example.com"],
    ["[::1]:8787", "[::1]"],
    ["[::1]", "[::1]"],
  ])("%s", (raw, out) => expect(normalizeHost(raw)).toBe(out));
});

describe("checkSlug", () => {
  it("accepts a plain slug", () => expect(checkSlug("spring", [])).toEqual({ ok: true }));
  it("rejects empty", () => expect(checkSlug("", [])).toEqual({ ok: false, reason: "empty" }));
  it("accepts 64, rejects 65", () => {
    expect(checkSlug("a".repeat(64), [])).toEqual({ ok: true });
    expect(checkSlug("a".repeat(65), [])).toEqual({ ok: false, reason: "too_long" });
  });
  it.each(["a/b", "spr ing", "é"])("charset %s", (s) =>
    expect(checkSlug(s, [])).toEqual({ ok: false, reason: "charset" }));
  it("leading dot", () => expect(checkSlug(".env", [])).toEqual({ ok: false, reason: "leading_dot" }));
  it.each(["API", "dash", ".well-known"])("reserved %s", (s) =>
    expect(checkSlug(s, [])).toEqual({ ok: false, reason: "reserved" }));
  it("extra reserved, case-insensitive", () => {
    expect(checkSlug("promo", ["promo"])).toEqual({ ok: false, reason: "reserved" });
    expect(checkSlug("PROMO", ["promo"])).toEqual({ ok: false, reason: "reserved" });
  });
});

describe("checkDestination", () => {
  it("accepts https", () => {
    const r = checkDestination("https://example.com/x", []);
    expect(r.ok && r.url.href).toBe("https://example.com/x");
  });
  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://x"])("scheme %s", (s) =>
    expect(checkDestination(s, [])).toEqual({ ok: false, reason: "scheme" }));
  it("userinfo", () => {
    expect(checkDestination("https://u:p@x.com", [])).toEqual({ ok: false, reason: "userinfo" });
    expect(checkDestination("https://u@x.com", [])).toEqual({ ok: false, reason: "userinfo" });
  });
  it.each([" JAVASCRIPT:x", "java\nscript:x"])("parser-normalized scheme %j", (s) =>
    expect(checkDestination(s, [])).toEqual({ ok: false, reason: "scheme" }));
  it("backslash authority parses as https host evil.com", () => {
    const r = checkDestination("https:\\\\evil.com", []);
    expect(r.ok && [r.url.protocol, r.url.host]).toEqual(["https:", "evil.com"]);
    expect(checkDestination("https:\\\\evil.com", ["evil.com"])).toEqual({ ok: false, reason: "loop" });
  });
  it("empty userinfo marker is accepted", () => {
    const r = checkDestination("https://@x.com", []);
    expect(r.ok && r.url.href).toBe("https://x.com/");
  });
  it("relative", () => expect(checkDestination("/relative", [])).toEqual({ ok: false, reason: "not_url" }));
  it("too long", () =>
    expect(checkDestination("https://x.com/" + "a".repeat(2040), [])).toEqual({ ok: false, reason: "too_long" }));
  it("loop, normalized", () => {
    const hosts = ["go.example.com"];
    expect(checkDestination("https://go.example.com/spring", hosts)).toEqual({ ok: false, reason: "loop" });
    expect(checkDestination("https://GO.example.com:8443/spring", hosts)).toEqual({ ok: false, reason: "loop" });
    expect(checkDestination("https://go.example.com./spring", ["Go.Example.com"])).toEqual({ ok: false, reason: "loop" });
  });
});

describe("slugKey", () => {
  it("folds case unless case-sensitive", () => {
    expect(slugKey("Spring", false)).toBe("spring");
    expect(slugKey("Spring", true)).toBe("Spring");
  });
});
