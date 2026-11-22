import { describe, expect, it } from "vitest";
import type { AnalyticsReport } from "../api";
import { tiles } from "./view";

const report = (t: Partial<AnalyticsReport["totals"]>): AnalyticsReport => ({
  from: "2026-10-22", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
  totals: { clicks: 1200, qr: 300, typed: 900, bots: 45, visitors: 800, prevClicks: 1000, ...t },
  series: [], links: [], domains: [], countries: [], devices: [], referrers: [],
});

describe("tiles", () => {
  it("copy for a normal report", () => {
    expect(tiles(report({}))).toEqual([
      { label: "Clicks", value: "1,200", note: "+20% on the period before", up: true },
      { label: "Unique visitors", value: "800", note: "about 1.5 clicks each", up: false },
      { label: "From QR codes", value: "25%", note: "300 scans", up: false },
      { label: "Left out as bots", value: "45", note: "crawlers and chat-app previews", up: false },
    ]);
  });

  it("down on the period before", () => {
    expect(tiles(report({ clicks: 750, prevClicks: 1000 }))[0]).toMatchObject({ note: "-25% on the period before", up: false });
  });

  it("no period before keeps the line (a non-breaking space, as the mockup)", () => {
    expect(tiles(report({ prevClicks: null }))[0]).toMatchObject({ note: " ", up: false });
  });

  it("visitor counting off, and no visitors", () => {
    expect(tiles(report({ visitors: null }))[1]).toEqual({ label: "Unique visitors", value: "Off", note: "visitor counting is not set up", up: false });
    expect(tiles(report({ visitors: 0, clicks: 0 }))[1]).toMatchObject({ value: "0", note: "" });
  });

  it("no clicks is 0% from QR", () => {
    expect(tiles(report({ clicks: 0, qr: 0, typed: 0 }))[2]).toMatchObject({ value: "0%", note: "0 scans" });
  });
});
