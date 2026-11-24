import type { AnalyticsReport } from "../api";
import { fmt } from "./view";

/** Chart box in viewBox units: width, height and the left, bottom and top padding. */
export type Box = { W: number; H: number; pl: number; pb: number; pt: number };
/** The mockup box. */
export const DESK: Box = { W: 1100, H: 190, pl: 44, pb: 26, pt: 10 };
/** Phones: about the drawn width, so viewBox units are close to CSS pixels and 11 px axis text stays 11 px. */
export const PHONE_BOX: Box = { W: 360, H: 220, pl: 34, pb: 22, pt: 8 };

/** One day (or hour): its point on each line and its hover column. */
export type Bar = { cx: number; yAll: number; yQr: number; tip: string; hx: number; hw: number; yTop: number };
export type Geometry = {
  box: Box; top: number; grid: { y: number; label: string }[]; bars: Bar[]; lines: { all: string; area: string; qr: string }; ticks: { x: number; label: string }[];
  tickY: number; gridX: { x1: number; x2: number; label: number }; plot: { top: number; height: number };
};

/** "Nov 20" for a UTC day bucket, local "14:00" for an hour bucket. */
export function bucketLabel(bucket: string, unit: AnalyticsReport["unit"]): string {
  return unit === "day"
    ? new Date(`${bucket}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : new Date(bucket).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** All clicks as a line over a soft fill, QR scans as a second line (Hody's pick, option D). */
export function chartGeometry(series: { label: string; qr: number; typed: number }[], box: Box = DESK): Geometry {
  const { W, H, pl, pb, pt } = box;
  const N = series.length;
  const mx = Math.max(0, ...series.map((s) => s.qr + s.typed));
  const step = 10 ** Math.floor(Math.log10(mx || 1));
  // Under 10 the top is a multiple of 4, so the quarter lines are whole numbers and no two labels repeat.
  const top = mx > 0 && mx < 10 ? Math.max(4, Math.ceil(mx / 4) * 4) : Math.ceil(mx / step) * step || 1;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const grid = [0, 1, 2, 3, 4].map((k) => ({ y: y((top * k) / 4), label: fmt(Math.round((top * k) / 4)) }));
  const bw = (W - pl - 10) / N;
  const y0 = y(0);
  const bars = series.map(({ label, qr: q, typed: t }, i) => {
    const tip = `${label}: ${fmt(q + t)} clicks, ${fmt(q)} from QR, ${fmt(t)} typed or clicked`;
    return { cx: pl + i * bw + bw / 2, yAll: y(q + t), yQr: y(q), tip, hx: pl + i * bw, hw: bw, yTop: y(q + t) };
  });
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const path = (k: "yAll" | "yQr") => bars.map((b, i) => `${i ? "L" : "M"}${r1(b.cx)} ${r1(b[k])}`).join(" ");
  const all = path("yAll");
  const lines = { all, qr: path("yQr"), area: N ? `${all} L${r1(bars[N - 1]!.cx)} ${r1(y0)} L${r1(bars[0]!.cx)} ${r1(y0)} Z` : "" };
  const ticks = N ? [...new Set([0, Math.floor(N / 3), Math.floor((2 * N) / 3), N - 1])].map((i) => ({ x: pl + i * bw + bw / 2, label: series[i]!.label })) : [];
  return { box, top, grid, bars, lines, ticks, tickY: H - 6, gridX: { x1: pl, x2: W - 6, label: pl - 8 }, plot: { top: pt, height: H - pt - pb } };
}
