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

describe("checkDestination: tel and mailto", () => {
  const ok = (s: string) => { const r = checkDestination(s, []); return r.ok ? r.url.href : r.reason; };
  it.each([
    ["tel:+15551234567", "tel:+15551234567"],
    ["tel:+1-555-123.4567", "tel:+1-555-123.4567"],
    ["tel:(555)1234567", "tel:(555)1234567"],
    ["TEL:5551234", "tel:5551234"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["mailto:a@example.com,b.c+d@sub.example.org", "mailto:a@example.com,b.c+d@sub.example.org"],
    ["mailto:a@example.com?subject=Hello%20there&body=Hi%21", "mailto:a@example.com?subject=Hello%20there&body=Hi%21"],
    ["MAILTO:a@example.com?Subject=x", "mailto:a@example.com?Subject=x"],
  ])("accepts %s", (s, href) => expect(ok(s)).toBe(href));
  it.each([
    "tel:", "tel:+", "tel:abc", "tel:+1 555", "tel:+1;ext=2", "tel:+1%0a2", "tel:+1\n", " tel:+15551234", "tel:+15551234 ",
    "tel:" + "1".repeat(33), "tel://5551234", "tel:+1#2", "tel:+1?x=1",
  ])("rejects tel %j", (s) => expect(ok(s)).toBe("bad_tel"));
  it("tel: 32 after the scheme is the limit", () => expect(ok("tel:" + "1".repeat(32))).toBe("tel:" + "1".repeat(32)));
  it.each([
    "mailto:", "mailto:nobody", "mailto:a@b", "mailto:a@example.com?cc=x@example.com", "mailto:a@example.com?bcc=x@example.com",
    "mailto:a@example.com?subject=a%0D%0Abcc:x@example.com", "mailto:a@example.com?body=a%0Ab", "mailto:a@example.com?subject=%00",
    "mailto:a@example.com?subject=a b", "mailto:a@example.com?subject=a\nb", "mailto:a@example.com?subject=%zz",
    "mailto:a@example.com?subject=1&subject=2", "mailto:a@example.com?subject", "mailto:a@example.com?subject=a=b",
    "mailto:a@example.com?subject=x#frag", "mailto:a@example.com,", "mailto:a b@example.com", "mailto:a@example.com%0Abcc:x@y.com",
    "mailto:<a@example.com>", "mailto:a@example.com;b@example.com", "mailto:a@example.com?subject=%E2%80", " mailto:a@example.com",
  ])("rejects mailto %j", (s) => expect(ok(s)).toBe("bad_mailto"));
  it("mailto over 2048 is too long", () =>
    expect(ok("mailto:a@example.com?body=" + "a".repeat(2030))).toBe("too_long"));
  it("web-only callers refuse tel and mailto as a scheme", () => {
    expect(checkDestination("tel:+15551234", [], { webOnly: true })).toEqual({ ok: false, reason: "scheme" });
    expect(checkDestination("mailto:a@example.com", [], { webOnly: true })).toEqual({ ok: false, reason: "scheme" });
    expect(checkDestination("https://example.com/", [], { webOnly: true }).ok).toBe(true);
  });
  it("the loop check does not apply to mailto", () => {
    const r = checkDestination("mailto:a@go.example.com", ["go.example.com"]);
    expect(r.ok && r.url.href).toBe("mailto:a@go.example.com");
  });
  it.each(["file:///etc/passwd", "sms:+1555", "vbscript:x", "blob:https://x.com/1"])("still refuses %s", (s) => expect(ok(s)).toBe("scheme"));
});

describe("slugKey", () => {
  it("folds case unless case-sensitive", () => {
    expect(slugKey("Spring", false)).toBe("spring");
    expect(slugKey("Spring", true)).toBe("Spring");
  });
});
