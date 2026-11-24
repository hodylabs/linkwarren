import { sparkPoints, type StatsLive } from "./linkView";

const fmt = (n: number) => n.toLocaleString("en-US");

/** 7-day sparkline, colored by class (accent when the link is active, grey otherwise) so both themes work. With live off or unavailable, yesterday and today are unknown: drawn dashed, never as zero. */
export function Sparkline({ days, clicks, active, live }: { days: number[]; clicks: number; active: boolean; live: StatsLive }) {
  const known = live === "ok" ? days : days.slice(0, 5);
  const pts = sparkPoints(known, 7);
  const lastY = pts.split(" ").at(-1)!.split(",")[1];
  return (
    <>
      <svg className="spark" viewBox="0 0 72 20" aria-hidden="true">
        <polyline points={pts} className={active ? "ln" : "ln off"} />
        {live !== "ok" && <line x1="48" y1={lastY} x2="72" y2={lastY} className="gap" />}
      </svg>
      <span className="sr-only">
        {fmt(clicks)} clicks in 7 days{live !== "ok" && ". Recent days not available"}
      </span>
    </>
  );
}
