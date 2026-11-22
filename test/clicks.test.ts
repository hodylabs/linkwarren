import { describe, expect, it } from "vitest";
import { classifyAgent, referrerHost, splitQrMarker, utcDay, visitorHash } from "../src/clicks";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("classifyAgent", () => {
  it("classifies devices for humans", () => {
    expect(classifyAgent(IPHONE)).toEqual({ kind: "human", device: "mobile" });
    expect(classifyAgent(IPAD)).toEqual({ kind: "human", device: "tablet" });
    expect(classifyAgent(ANDROID_PHONE)).toEqual({ kind: "human", device: "mobile" });
    expect(classifyAgent(ANDROID_TABLET)).toEqual({ kind: "human", device: "tablet" });
    expect(classifyAgent(WIN)).toEqual({ kind: "human", device: "desktop" });
  });
  it("marks link previews", () => {
    expect(classifyAgent("Slackbot-LinkExpanding 1.0").kind).toBe("preview");
    expect(classifyAgent("facebookexternalhit/1.1").kind).toBe("preview");
    expect(classifyAgent("WhatsApp/2.23").kind).toBe("preview");
  });
  it("marks bots", () => {
    expect(classifyAgent("curl/8.5.0").kind).toBe("bot");
    expect(classifyAgent("Googlebot/2.1").kind).toBe("bot");
    expect(classifyAgent("python-requests/2.31").kind).toBe("bot");
    expect(classifyAgent(WIN, "Search Engine Crawler")).toEqual({ kind: "bot", device: "desktop" });
  });
  it("treats an empty or missing agent as a bot", () => {
    expect(classifyAgent("")).toEqual({ kind: "bot", device: "other" });
    expect(classifyAgent(null)).toEqual({ kind: "bot", device: "other" });
  });
});

describe("referrerHost", () => {
  it("keeps only a lowercased host without www", () => {
    expect(referrerHost("https://www.Instagram.com/p/x?y=1")).toBe("instagram.com");
  });
  it("drops non-http and invalid values", () => {
    expect(referrerHost("android-app://com.slack")).toBe("");
    expect(referrerHost("not a url")).toBe("");
    expect(referrerHost(null)).toBe("");
  });
  it("cuts to 100 chars", () => {
    expect(referrerHost(`https://${"a".repeat(120)}.com/`)).toHaveLength(100);
  });
});

describe("splitQrMarker", () => {
  it("strips exact lw=qr pairs without re-encoding", () => {
    expect(splitQrMarker("?a=%20&lw=qr&b=1")).toEqual({ qr: true, search: "?a=%20&b=1" });
    expect(splitQrMarker("?lw=qr")).toEqual({ qr: true, search: "" });
    expect(splitQrMarker("?lw=qr&lw=qr")).toEqual({ qr: true, search: "" });
  });
  it("leaves everything else untouched", () => {
    expect(splitQrMarker("?lw=qrx")).toEqual({ qr: false, search: "?lw=qrx" });
    expect(splitQrMarker("?LW=QR")).toEqual({ qr: false, search: "?LW=QR" });
    expect(splitQrMarker("")).toEqual({ qr: false, search: "" });
  });
});

describe("visitorHash", () => {
  it("is 16 hex chars, stable, and day-scoped", async () => {
    const a = await visitorHash("s", "2026-11-20", "1.2.3.4", "ua");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorHash("s", "2026-11-20", "1.2.3.4", "ua")).toBe(a);
    expect(await visitorHash("s", "2026-11-21", "1.2.3.4", "ua")).not.toBe(a);
  });
  it("is empty without a salt", async () => {
    expect(await visitorHash(undefined, "2026-11-20", "1.2.3.4", "ua")).toBe("");
    expect(await visitorHash("", "2026-11-20", "1.2.3.4", "ua")).toBe("");
  });
});

describe("utcDay", () => {
  it("formats a UTC day", () => {
    expect(utcDay(1763596800)).toBe("2025-11-20");
  });
});
