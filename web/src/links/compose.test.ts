import { describe, expect, it } from "vitest";
import { readUtm, suggestSlugs, withUtm } from "./compose";

describe("suggestSlugs", () => {
  it("builds base, joined and year-short candidates", () => {
    expect(suggestSlugs("https://northwind.io/campaigns/spring-2027")).toEqual(["spring-2027", "spring27", "sp27"]);
  });
  it("strips the extension and lowercases", () => {
    expect(suggestSlugs("https://x.com/Menu.PDF")).toEqual(["menu"]);
  });
  it("is empty without a path or a URL", () => {
    expect(suggestSlugs("https://x.com/")).toEqual([]);
    expect(suggestSlugs("not a url")).toEqual([]);
  });
  it("keeps a bad escape raw and never exceeds 3 valid slugs", () => {
    const s = suggestSlugs("https://x.com/a%zz-b-c-2026");
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("withUtm / readUtm", () => {
  it("adds tags after existing params and skips empty values", () => {
    expect(withUtm("https://x.com/a?b=1", { source: "flyer", medium: "", campaign: "spring" })).toBe("https://x.com/a?b=1&utm_source=flyer&utm_campaign=spring");
  });
  it("clearing a tag removes only that key", () => {
    const u = "https://x.com/a?b=1&utm_source=flyer&utm_campaign=spring";
    expect(withUtm(u, { source: "", medium: "", campaign: "spring" })).toBe("https://x.com/a?b=1&utm_campaign=spring");
    expect(readUtm(u)).toEqual({ source: "flyer", medium: "", campaign: "spring" });
  });
  it("rewrites a repeated tag to one and removes every copy when cleared", () => {
    const u = "https://x.com/a?utm_source=a&b=1&utm_source=c";
    expect(withUtm(u, { source: "z", medium: "", campaign: "" })).toBe("https://x.com/a?utm_source=z&b=1");
    expect(withUtm(u, { source: "", medium: "", campaign: "" })).toBe("https://x.com/a?b=1");
  });
  it("leaves an invalid URL and an untouched URL as they were", () => {
    expect(withUtm("nope", { source: "a", medium: "", campaign: "" })).toBe("nope");
    expect(withUtm("https://x.com", { source: "", medium: "", campaign: "" })).toBe("https://x.com");
    expect(readUtm("nope")).toEqual({ source: "", medium: "", campaign: "" });
  });
});
