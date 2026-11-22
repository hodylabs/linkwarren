import type { AnalyticsReport } from "../api";
import { fmt } from "./view";

/** Mockup chart box (viewBox units). */
export const W = 1100, H = 260;
const pl = 44, pb = 26, pt = 10;

export type Bar = { x: number; w: number; qrY: number; qrH: number; typedPath: string | null; tip: string; hx: number; hw: number; yTop: number };
export type Geometry = { top: number; grid: { y: number; label: string }[]; bars: Bar[]; ticks: { x: number; label: string }[] };

/** "Nov 20" for a UTC day bucket, local "14:00" for an hour bucket. */
export function bucketLabel(bucket: string, unit: AnalyticsReport["unit"]): string {
  return unit === "day"
    ? new Date(`${bucket}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : new Date(bucket).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Stacked bars as the mockup draws them: QR at the bottom, typed on top with a rounded end. */
export function chartGeometry(series: { label: string; qr: number; typed: number }[]): Geometry {
  const N = series.length;
  const mx = Math.max(0, ...series.map((s) => s.qr + s.typed));
  const step = 10 ** Math.floor(Math.log10(mx || 1));
  const top = Math.ceil(mx / step) * step || 1;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const grid = [0, 1, 2, 3, 4].map((k) => ({ y: y((top * k) / 4), label: fmt(Math.round((top * k) / 4)) }));
  const bw = (W - pl - 10) / N;
  const gap = N > 60 ? 1 : 2;
  const y0 = y(0);
  const bars = series.map(({ label, qr: q, typed: t }, i) => {
    const x = pl + i * bw + gap, w = Math.max(1, bw - gap * 2);
    const ya = y(q), yb = y(q + t), th = ya - yb;
    let typedPath: string | null = null;
    if (th > 0.5) {
      const sep = q && th > 3 ? 2 : 0;
      const r = Math.min(3, w / 2, th - sep);
      typedPath = `M${x} ${ya - sep} V${yb + r} q0 -${r} ${r} -${r} h${w - 2 * r} q${r} 0 ${r} ${r} V${ya - sep} Z`;
    }
    const tip = `${label}: ${fmt(q + t)} clicks, ${fmt(q)} from QR, ${fmt(t)} typed or clicked`;
    return { x, w, qrY: ya, qrH: y0 - ya, typedPath, tip, hx: pl + i * bw, hw: bw, yTop: yb };
  });
  const ticks = N ? [...new Set([0, Math.floor(N / 3), Math.floor((2 * N) / 3), N - 1])].map((i) => ({ x: pl + i * bw + bw / 2, label: series[i]!.label })) : [];
  return { top, grid, bars, ticks };
}

export const TICK_Y = H - 6;
export const GRID_X = { x1: pl, x2: W - 6, label: pl - 8 };
export const PLOT = { top: pt, height: H - pt - pb };
