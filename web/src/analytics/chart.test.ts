import { afterEach, describe, expect, it } from "vitest";
import { bucketLabel, chartGeometry } from "./chart";

const s = (n: number, f: (i: number) => [number, number] = () => [1, 1]) =>
  Array.from({ length: n }, (_, i) => ({ label: `d${i}`, qr: f(i)[0], typed: f(i)[1] }));

describe("chartGeometry", () => {
  it("rounds the top up to its leading power of ten with five gridlines", () => {
    const g = chartGeometry([{ label: "a", qr: 284, typed: 1000 }, { label: "b", qr: 1, typed: 1 }]);
    expect(g.top).toBe(2000);
    expect(g.grid.map((x) => x.label)).toEqual(["0", "500", "1,000", "1,500", "2,000"]);
    expect(g.grid[0]!.y).toBe(234); // the baseline: H - pb
    expect(g.grid[4]!.y).toBe(10); // pt
  });

  it("an empty series has top 1 and no bars or ticks", () => {
    const g = chartGeometry([]);
    expect(g.top).toBe(1);
    expect(g.bars).toEqual([]);
    expect(g.ticks).toEqual([]);
  });

  it("gap is 1 above 60 buckets and 2 otherwise", () => {
    const bw90 = (1100 - 44 - 10) / 90;
    expect(chartGeometry(s(90)).bars[0]!.x).toBeCloseTo(44 + 1);
    expect(chartGeometry(s(90)).bars[0]!.w).toBeCloseTo(bw90 - 2);
    expect(chartGeometry(s(30)).bars[0]!.x).toBeCloseTo(44 + 2);
  });

  it("qr 0 and typed 5 gives no QR height and a typed path; typed 0 gives no path", () => {
    const g = chartGeometry([{ label: "a", qr: 0, typed: 5 }, { label: "b", qr: 5, typed: 0 }]);
    expect(g.bars[0]!.qrH).toBe(0);
    expect(g.bars[0]!.typedPath).toMatch(/^M/);
    expect(g.bars[1]!.typedPath).toBeNull();
    expect(g.bars[1]!.qrH).toBeGreaterThan(0);
  });

  it("tip text is exact", () => {
    expect(chartGeometry([{ label: "Nov 20", qr: 1200, typed: 84 }]).bars[0]!.tip).toBe(
      "Nov 20: 1,284 clicks, 1,200 from QR, 84 typed or clicked",
    );
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
