import { describe, expect, it } from "vitest";
import { countryOf, pickDestination, routeDeviceOf, withQuery } from "../src/routing";
import { rowToLink } from "../src/types";

const A = "https://a.example/";
const B = "https://b.example/";
const link = {
  url: "https://main.example/",
  routes: [
    { countries: ["CA"], devices: [], url: A },
    { countries: [], devices: ["mobile" as const], url: B },
  ],
};

describe("routeDeviceOf", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", "mobile"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36", "mobile"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", "tablet"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", "desktop"],
    [null, "desktop"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "desktop"],
    ["curl/8.4.0", "desktop"],
  ])("%s -> %s", (ua, want) => expect(routeDeviceOf(ua)).toBe(want));
});

describe("countryOf", () => {
  const req = (cf?: object) => ({ cf }) as unknown as Request;
  it("upper-cases", () => expect(countryOf(req({ country: "ca" }))).toBe("CA"));
  it("null without cf or a string", () => {
    expect(countryOf(req())).toBeNull();
    expect(countryOf(req({ country: 5 }))).toBeNull();
    expect(countryOf(req({ country: "" }))).toBeNull();
  });
});

describe("pickDestination", () => {
  it.each([
    ["CA", "desktop", A],
    ["CA", "mobile", A],
    ["US", "mobile", B],
    ["US", "desktop", link.url],
    [null, "mobile", B],
    [null, "desktop", link.url],
    ["T1", "desktop", link.url],
    ["XX", "desktop", link.url],
  ] as const)("%s %s", (c, d, want) => expect(pickDestination(link, c, d)).toBe(want));
  it("a country route never matches XX or T1 even when listed", () => {
    const l = { url: "https://m.example/", routes: [{ countries: ["XX", "T1"], devices: [], url: A }] };
    expect(pickDestination(l, "XX", "desktop")).toBe(l.url);
    expect(pickDestination(l, "T1", "desktop")).toBe(l.url);
  });
});

describe("withQuery", () => {
  it("off returns dest untouched", () => expect(withQuery("https://x.example/p?z=1", false, "?a=1")).toBe("https://x.example/p?z=1"));
  it("empty search returns dest", () => expect(withQuery("https://x.example/p", true, "")).toBe("https://x.example/p"));
  it("dest without a query", () => expect(withQuery("https://x.example/p", true, "?a=1")).toBe("https://x.example/p?a=1"));
  it("dest with a query", () => expect(withQuery("https://x.example/p?z=1", true, "?a=1")).toBe("https://x.example/p?z=1&a=1"));
  it("raw bytes kept", () => expect(withQuery("https://x.example/p", true, "?a=%20b&c=1")).toBe("https://x.example/p?a=%20b&c=1"));
});

describe("stored data never throws", () => {
  it("pickDestination on a row whose routes JSON holds junk elements falls back to the main url", () => {
    const row = rowToLink({ id: "i", url: "https://main.example/", routes: '[null, {"url":1}, 3, {"countries":"CA","devices":[],"url":"x"}]' });
    expect(row.routes).toEqual([]);
    expect(pickDestination(row, "CA", "mobile")).toBe("https://main.example/");
  });
});
