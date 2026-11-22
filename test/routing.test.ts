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

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  ipod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1",
  crios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  windowsPhone: "Mozilla/5.0 (Mobile; Windows Phone 8.1; Android 4.0; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0; NOKIA; Lumia 635) like iPhone OS 7_0_3 Mac OS X AppleWebKit/537 (KHTML, like Gecko) Mobile Safari/537",
};

describe("routeDeviceOf", () => {
  it.each([
    [UA.iphone, ["mobile", "ios"]],
    [UA.ipad, ["tablet", "ios"]],
    [UA.ipod, ["mobile", "ios"]],
    [UA.crios, ["mobile", "ios"]],
    [UA.androidPhone, ["mobile", "android"]],
    [UA.androidTablet, ["tablet", "android"]],
    // iPadOS in desktop mode sends this same Mac UA: it counts as macOS and Desktop, never iOS.
    [UA.macSafari, ["desktop", "macos"]],
    [UA.windows, ["desktop", "windows"]],
    [UA.linux, ["desktop", "linux"]],
    // X11 alone is not Linux: FreeBSD and other Unix desktops send it too.
    ["Mozilla/5.0 (X11; FreeBSD amd64; rv:133.0) Gecko/20100101 Firefox/133.0", ["desktop"]],
    [UA.chromebook, ["desktop", "chromeos"]],
    [UA.windowsPhone, ["mobile"]],
    [null, ["desktop"]],
    ["", ["desktop"]],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ["desktop"]],
    ["curl/8.4.0", ["desktop"]],
  ])("%s -> %j", (ua, want) => expect(routeDeviceOf(ua)).toEqual(want));
  it("reads only the first UA_MAX characters", () => {
    expect(routeDeviceOf("x".repeat(600) + " Android Mobile")).toEqual(["desktop"]);
    expect(routeDeviceOf(UA.androidPhone + " ".repeat(600 - UA.androidPhone.length))).toEqual(["mobile", "android"]);
  });
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
  ] as const)("%s %s", (c, d, want) => expect(pickDestination(link, c, [d])).toBe(want));
  it("a country route never matches XX or T1 even when listed", () => {
    const l = { url: "https://m.example/", routes: [{ countries: ["XX", "T1"], devices: [], url: A }] };
    expect(pickDestination(l, "XX", ["desktop"])).toBe(l.url);
    expect(pickDestination(l, "T1", ["desktop"])).toBe(l.url);
  });
  it("phone and computer OS values: any ticked value matches, first matching route wins", () => {
    const l = {
      url: "https://main.example/",
      routes: [
        { countries: ["CA"], devices: ["ios" as const], url: "https://ca-ios.example/" },
        { countries: [], devices: ["android" as const, "tablet" as const], url: "https://droid.example/" },
        { countries: [], devices: ["windows" as const, "macos" as const, "linux" as const, "chromeos" as const], url: "https://pc.example/" },
        { countries: [], devices: ["ios" as const], url: "https://ios.example/" },
      ],
    };
    expect(pickDestination(l, "CA", routeDeviceOf(UA.iphone))).toBe("https://ca-ios.example/");
    expect(pickDestination(l, "US", routeDeviceOf(UA.iphone))).toBe("https://ios.example/");
    expect(pickDestination(l, "US", routeDeviceOf(UA.ipad))).toBe("https://droid.example/");
    expect(pickDestination(l, "CA", routeDeviceOf(UA.androidPhone))).toBe("https://droid.example/");
    expect(pickDestination(l, "US", routeDeviceOf(UA.macSafari))).toBe("https://pc.example/");
    expect(pickDestination(l, "US", routeDeviceOf(UA.chromebook))).toBe("https://pc.example/");
    expect(pickDestination(l, "US", routeDeviceOf(UA.windowsPhone))).toBe(l.url);
    expect(pickDestination(l, "US", routeDeviceOf(null))).toBe(l.url);
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
    expect(pickDestination(row, "CA", ["mobile"])).toBe("https://main.example/");
  });
});
