import type { AnalyticsReport } from "../api";

export const fmt = (n: number): string => n.toLocaleString("en-US");

export type Tile = { label: string; value: string; note: string; up: boolean };

/** The four summary tiles, copy as the mockup. */
export function tiles(r: AnalyticsReport): Tile[] {
  const t = r.totals;
  const delta = t.prevClicks ? Math.round(((t.clicks - t.prevClicks) / t.prevClicks) * 100) : null;
  return [
    {
      label: "Clicks",
      value: fmt(t.clicks),
      // A non-breaking space keeps the line (and the tile height) when there is no period before.
      note: delta === null ? " " : `${delta >= 0 ? "+" : ""}${delta}% on the period before`,
      up: delta !== null && delta > 0,
    },
    t.visitors === null
      ? { label: "Unique visitors", value: "Off", note: "visitor counting is not set up", up: false }
      : { label: "Unique visitors", value: fmt(t.visitors), note: t.visitors ? `about ${(t.clicks / t.visitors).toFixed(1)} clicks each` : "", up: false },
    { label: "From QR codes", value: `${t.clicks ? Math.round((t.qr / t.clicks) * 100) : 0}%`, note: `${fmt(t.qr)} scans`, up: false },
    { label: "Left out as bots", value: fmt(t.bots), note: "crawlers and chat-app previews", up: false },
  ];
}
