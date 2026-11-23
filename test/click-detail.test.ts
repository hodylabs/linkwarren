import { describe, expect, it } from "vitest";
import { browserOf, languageOf, osOf, placeOf } from "../src/clicks";
import { harness, seed, visit } from "./helpers/redirect";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 OPR/105.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 15633.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

describe("osOf and browserOf: a small known set plus Other", () => {
  it("buckets operating systems", () => {
    expect(osOf(UA.iphone)).toBe("iOS");
    expect(osOf(UA.ipad)).toBe("iOS");
    expect(osOf(UA.android)).toBe("Android");
    expect(osOf(UA.edge)).toBe("Windows");
    expect(osOf(UA.macSafari)).toBe("macOS");
    expect(osOf(UA.firefox)).toBe("Linux");
    expect(osOf(UA.chromeos)).toBe("ChromeOS");
    expect(osOf("curl/8.5.0")).toBe("Other");
    expect(osOf("")).toBe("Other");
  });
  it("buckets browsers, the specific engines before Chrome and Safari", () => {
    expect(browserOf(UA.iphone)).toBe("Safari");
    expect(browserOf(UA.macSafari)).toBe("Safari");
    expect(browserOf(UA.iosChrome)).toBe("Chrome");
    expect(browserOf(UA.android)).toBe("Chrome");
    expect(browserOf(UA.samsung)).toBe("Samsung Internet");
    expect(browserOf(UA.edge)).toBe("Edge");
    expect(browserOf(UA.opera)).toBe("Opera");
    expect(browserOf(UA.firefox)).toBe("Firefox");
    expect(browserOf("curl/8.5.0")).toBe("Other");
  });
});

describe("languageOf: the first Accept-Language tag, lowercased, at most 2 parts", () => {
  it("parses", () => {
    expect(languageOf("en-US,en;q=0.9")).toBe("en-us");
    expect(languageOf("fr;q=0.8, en")).toBe("fr");
    expect(languageOf("zh-Hant-TW,zh;q=0.9")).toBe("zh-hant");
    expect(languageOf(" DE-at ")).toBe("de-at");
  });
  it("anything else is empty", () => {
    expect(languageOf(null)).toBe("");
    expect(languageOf("")).toBe("");
    expect(languageOf("*")).toBe("");
    expect(languageOf("<script>")).toBe("");
    expect(languageOf("x".repeat(200))).toBe("");
  });
});

describe("placeOf: city (or region) with the country, nothing finer", () => {
  it("uses cf city first, then region", () => {
    expect(placeOf({ city: "Toronto", region: "Ontario" }, "CA")).toBe("Toronto, CA");
    expect(placeOf({ region: "Ontario" }, "CA")).toBe("Ontario, CA");
    expect(placeOf({}, "CA")).toBe("");
    expect(placeOf(undefined, "XX")).toBe("");
  });
  it("strips control characters and caps the length", () => {
    expect(placeOf({ city: "A\u0000B‮" }, "US")).toBe("AB, US");
    expect(placeOf({ city: "y".repeat(200) }, "US").length).toBeLessThanOrEqual(68);
  });
});

describe("click recording appends the detail blobs after the old ones", () => {
  it("blobs 10 to 13: os, browser, language, place; no raw agent", async () => {
    const d = await seed();
    const h = harness();
    await h.go(d.host, "/spring", { ...visit({ "accept-language": "pt-BR,pt;q=0.9" }), cf: { country: "br", city: "Recife", region: "Pernambuco" } });
    const b = h.points[0].blobs!;
    expect(b).toHaveLength(13);
    expect(b.slice(3, 8)).toEqual(["BR", "mobile", "instagram.com", "typed", "human"]);
    expect(b.slice(9)).toEqual(["iOS", "Safari", "pt-br", "Recife, BR"]);
    expect(JSON.stringify(b)).not.toMatch(/Mozilla|203\.0\.113/);
  });
});
