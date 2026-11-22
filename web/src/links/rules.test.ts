import { describe, expect, it } from "vitest";
import { countryName, parseCountries, passwordProblem, routeSummary } from "./rules";

describe("parseCountries", () => {
  it("splits on commas and spaces, uppercases and dedupes", () => {
    expect(parseCountries("ca, us  CA")).toEqual({ ok: true, list: ["CA", "US"] });
    expect(parseCountries("  ")).toEqual({ ok: true, list: [] });
  });
  it("names the first bad code", () => {
    expect(parseCountries("CAN")).toEqual({ ok: false, bad: "CAN" });
    expect(parseCountries("ca xx")).toEqual({ ok: false, bad: "XX" });
    expect(parseCountries("t1")).toEqual({ ok: false, bad: "T1" });
  });
  it("allows at most 50", () => {
    const many = Array.from({ length: 51 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))).join(",");
    expect(parseCountries(many).ok).toBe(false);
  });
});

describe("passwordProblem", () => {
  it("counts code points, 8 to 128", () => {
    expect(passwordProblem("1234567")).toBe("password_short");
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("😀".repeat(128))).toBeNull();
    expect(passwordProblem("a".repeat(129))).toBe("password_long");
  });
});

describe("routeSummary", () => {
  it("first route in words", () => {
    expect(countryName("CA")).toBe("Canada");
    expect(routeSummary([{ countries: ["CA"], devices: [], url: "https://northwind.ca/spring" }], "https://x.com")).toBe("Canada goes to northwind.ca/spring");
  });
  it("devices only", () => {
    expect(routeSummary([{ countries: [], devices: ["mobile"], url: "https://m.x.com/" }], "https://x.com")).toBe("Mobile goes to m.x.com/");
  });
  it("countries on devices, plus more", () => {
    const r = [
      { countries: ["CA", "US"], devices: ["mobile" as const, "tablet" as const], url: "https://x.ca/a" },
      { countries: ["FR"], devices: [], url: "https://x.fr/" },
    ];
    expect(routeSummary(r, "https://x.com")).toBe("Canada, United States on Mobile, Tablet goes to x.ca/a (+1 more)");
  });
  it("Off when empty", () => {
    expect(routeSummary([], "https://x.com")).toBe("Off");
  });
});
