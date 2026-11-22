import { sparkPoints, type StatsLive } from "./linkView";

const fmt = (n: number) => n.toLocaleString("en-US");

/** 7-day sparkline. With live off or unavailable, yesterday and today are unknown: drawn dashed, never as zero. */
export function Sparkline({ days, clicks, active, live }: { days: number[]; clicks: number; active: boolean; live: StatsLive }) {
  const known = live === "ok" ? days : days.slice(0, 5);
  const stroke = active ? "#FD8D27" : "#B9BEC5";
  return (
    <>
      <svg className="spark" viewBox="0 0 72 20" aria-hidden="true">
        <polyline points={sparkPoints(known, 7)} fill="none" stroke={stroke} strokeWidth="1.8" />
        {live !== "ok" && <line x1="50" y1="10" x2="72" y2="10" stroke="#B9BEC5" strokeWidth="1.2" strokeDasharray="2 2" />}
      </svg>
      <span className="sr-only">
        {fmt(clicks)} clicks in 7 days{live !== "ok" && ". Recent days not available"}
      </span>
    </>
  );
}
