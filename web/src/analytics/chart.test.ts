import { afterEach, describe, expect, it } from "vitest";
import { bucketLabel, chartGeometry, dayTicks, hourDayLabel, PHONE_BOX } from "./chart";

const s = (n: number, f: (i: number) => [number, number] = () => [1, 1]) =>
  Array.from({ length: n }, (_, i) => ({ label: `d${i}`, qr: f(i)[0], typed: f(i)[1] }));

describe("chartGeometry", () => {
  it("rounds the top up to its leading power of ten with five gridlines", () => {
    const g = chartGeometry([{ label: "a", qr: 284, typed: 1000 }, { label: "b", qr: 1, typed: 1 }]);
    expect(g.top).toBe(2000);
    expect(g.grid.map((x) => x.label)).toEqual(["0", "500", "1,000", "1,500", "2,000"]);
    expect(g.grid[0]!.y).toBe(164); // the baseline: H - pb
    expect(g.grid[4]!.y).toBe(10); // pt
  });

  it("an empty series has top 1 and no bars or ticks", () => {
    const g = chartGeometry([]);
    expect(g.top).toBe(1);
    expect(g.bars).toEqual([]);
    expect(g.ticks).toEqual([]);
  });

  it("each point sits mid-column and the hover columns tile the plot", () => {
    const bw = (1100 - 44 - 10) / 30;
    const g = chartGeometry(s(30));
    expect(g.bars[0]!.cx).toBeCloseTo(44 + bw / 2);
    expect(g.bars[29]!.hx + g.bars[29]!.hw).toBeCloseTo(1090);
  });

  it("the lines: all clicks over QR, the area closes on the baseline, QR 0 sits on the baseline", () => {
    const g = chartGeometry([{ label: "a", qr: 0, typed: 5 }, { label: "b", qr: 5, typed: 3 }]);
    expect(g.bars[0]!.yQr).toBe(164); // no QR: on the baseline
    expect(g.bars[1]!.yAll).toBeLessThan(g.bars[1]!.yQr); // the total is above its QR part
    expect(g.lines.all).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(g.lines.qr.split("L")).toHaveLength(2);
    expect(g.lines.area).toMatch(/ L[\d.]+ 164 L[\d.]+ 164 Z$/);
  });

  it("an empty series draws no lines", () => {
    expect(chartGeometry([]).lines).toEqual({ all: "", qr: "", area: "" });
  });

  it("tip text is exact", () => {
    expect(chartGeometry([{ label: "Nov 20", qr: 1200, typed: 84 }]).bars[0]!.tip).toBe(
      "Nov 20: 1,284 clicks, 1,200 from QR, 84 typed or clicked",
    );
  });

  it("small maxima get whole, distinct axis labels", () => {
    const labels = (mx: number) => chartGeometry([{ label: "a", qr: 0, typed: mx }]).grid.map((x) => x.label);
    expect(labels(1)).toEqual(["0", "1", "2", "3", "4"]);
    expect(labels(5)).toEqual(["0", "2", "4", "6", "8"]);
    expect(labels(9)).toEqual(["0", "3", "6", "9", "12"]);
    for (let mx = 1; mx <= 120; mx++) expect(new Set(labels(mx)).size).toBe(5);
  });

  it("the phone box keeps the scale and lays bars out in its own units", () => {
    const desk = chartGeometry(s(30, () => [3, 5]));
    const g = chartGeometry(s(30, () => [3, 5]), PHONE_BOX);
    expect(g.top).toBe(desk.top);
    expect(g.grid.map((x) => x.label)).toEqual(desk.grid.map((x) => x.label));
    expect(g.grid[0]!.y).toBe(198); // 220 - 22
    expect(g.grid[4]!.y).toBe(8);
    const bw = (360 - 34 - 10) / 30;
    expect(g.bars[0]!.cx).toBeCloseTo(34 + bw / 2);
    expect(g.bars[29]!.hx + g.bars[29]!.hw).toBeCloseTo(350);
    expect(g.tickY).toBe(214);
    expect(g.gridX).toEqual({ x1: 34, x2: 354, label: 26 });
  });

  it("ticks sit at 0, N/3, 2N/3 and N-1", () => {
    expect(chartGeometry(s(30)).ticks.map((t) => t.label)).toEqual(["d0", "d10", "d20", "d29"]);
  });
});

describe("bucketLabel", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });
  it("formats a day in UTC whatever the local zone", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(bucketLabel("2026-11-20", "day")).toBe("Nov 20");
  });
  it("formats an hour in local time", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(bucketLabel("2026-11-20T22:00:00Z", "hour")).toBe("14:00");
  });
});

describe("hourly 7 days (S13 R8)", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });
  // 168 hours from a local midnight in UTC, so 7 midnights land on indexes 0, 24, ..., 144.
  const week = Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2026, 10, 14, i)).toISOString().slice(0, 13) + ":00:00Z");

  it("hourDayLabel names the local day and hour", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(hourDayLabel("2026-11-20T22:00:00Z")).toBe("Nov 20, 14:00");
  });

  it("dayTicks labels each local midnight, or every nth", () => {
    process.env.TZ = "UTC";
    const t = dayTicks(week);
    expect(t.flatMap((x, i) => (x ? [[i, x]] : []))).toEqual([[0, "Nov 14"], [24, "Nov 15"], [48, "Nov 16"], [72, "Nov 17"], [96, "Nov 18"], [120, "Nov 19"], [144, "Nov 20"]]);
    expect(dayTicks(week, 2).filter(Boolean)).toEqual(["Nov 14", "Nov 16", "Nov 18", "Nov 20"]);
  });

  it("a series with ticks puts the axis labels at exactly those points", () => {
    process.env.TZ = "UTC";
    const ticks = dayTicks(week);
    const g = chartGeometry(week.map((b, i) => ({ label: b, qr: 0, typed: 1, tick: ticks[i] })));
    expect(g.ticks.map((x) => x.label)).toEqual(["Nov 14", "Nov 15", "Nov 16", "Nov 17", "Nov 18", "Nov 19", "Nov 20"]);
  });

  it("on the phone box, every other day keeps labels about 90 units apart, wider than a label at 11 px", () => {
    process.env.TZ = "UTC";
    const ticks = dayTicks(week, 2);
    const g = chartGeometry(week.map((b, i) => ({ label: b, qr: 0, typed: 1, tick: ticks[i] })), PHONE_BOX);
    const gaps = g.ticks.slice(1).map((t, i) => t.x - g.ticks[i]!.x);
    // "Nov 20" at 11 px is about 36 px wide; viewBox units are about CSS pixels on the phone box.
    expect(Math.min(...gaps)).toBeGreaterThan(80);
  });
});
