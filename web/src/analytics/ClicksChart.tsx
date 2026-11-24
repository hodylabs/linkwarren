import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { AnalyticsReport } from "../api";
import { PHONE, useMedia } from "../shell/narrow";
import { bucketLabel, chartGeometry, dayTicks, DESK, hourDayLabel, PHONE_BOX } from "./chart";
import { fmt } from "./view";

/** Keys on the focused chart (handled by its onKeyDown) and their text on the shortcuts sheet. */
export const CHART_KEYS = {
  arrowleft: "Previous bar of the focused chart",
  arrowright: "Next bar of the focused chart",
  home: "First bar",
  end: "Last bar",
  escape: "Hide the bar details",
} as const;

const EMPTY = "No clicks match these filters. Try a longer range or another domain.";

type Props = {
  series: AnalyticsReport["series"]; unit: AnalyticsReport["unit"]; table: boolean; onToggle: () => void;
  /** Replaces the no-clicks line, for example when hourly data needs the live read. */
  empty?: string;
};
type Active = { i: number; x: number; y: number } | null;

/** Stacked bar chart of clicks per bucket (QR bottom, typed top) with a hover and keyboard tooltip, or the same data as a table. */
export function ClicksChart({ series, unit, table, onToggle, empty = EMPTY }: Props) {
  const phone = useMedia(PHONE);
  // S13 R8: the 7 day view is hourly too. Its points name the day as well as the hour, and the axis labels the days.
  const days = unit === "hour" && series.length > 48;
  const ticks = days ? dayTicks(series.map((s) => s.bucket), phone ? 2 : 1) : [];
  const rows = series.map((s, i) => ({ label: days ? hourDayLabel(s.bucket) : bucketLabel(s.bucket, unit), qr: s.qr, typed: s.typed, tick: ticks[i] }));
  const total = rows.reduce((n, r) => n + r.qr + r.typed, 0);
  const g = chartGeometry(rows, phone ? PHONE_BOX : DESK);
  const { W, H } = g.box;
  const [active, setActive] = useState<Active>(null);
  const cardRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusIn = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const bar = active ? g.bars[active.i] : undefined;

  // Switching view unmounts the focused chart (or table): keep focus in the card on the toggle, never on <body>.
  useLayoutEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (focusIn.current && lost) toggleRef.current?.focus();
  }, [table]);

  // The tip is placed through the CSSOM (allowed by the style-src CSP), never a style attribute.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!active || !tip) return;
    // Keep the centred tip inside the card on narrow screens.
    const half = tip.offsetWidth / 2, room = wrapRef.current?.clientWidth ?? 0;
    tip.style.left = `${room > 2 * half ? Math.min(Math.max(active.x, half), room - half) : active.x}px`;
    tip.style.top = `${active.y}px`;
  }, [active]);

  const title = unit === "hour" ? `Clicks per hour, last ${days ? "7 days" : "24 hours"}` : `Clicks per day, ${rows[0]?.label ?? ""} to ${rows.at(-1)?.label ?? ""}`;

  // Keyboard: put the tip over the top of bar i (viewBox units scaled to the drawn size).
  const atBar = (i: number): Active => {
    const b = g.bars[i]!;
    const s = svgRef.current?.getBoundingClientRect();
    const w = wrapRef.current?.getBoundingClientRect();
    const sx = s ? s.width / W : 0, sy = s ? s.height / H : 0;
    const ox = s && w ? s.left - w.left : 0, oy = s && w ? s.top - w.top : 0;
    return { i, x: ox + b.cx * sx, y: oy + b.yTop * sy };
  };
  const onKey = (e: KeyboardEvent) => {
    const last = g.bars.length - 1;
    const cur = Math.min(active?.i ?? 0, last); // the series may have shrunk under the tip
    const k = e.key.toLowerCase();
    if (!(k in CHART_KEYS) || e.altKey || e.ctrlKey || e.metaKey) return;
    const moves: Record<Exclude<keyof typeof CHART_KEYS, "escape">, number> = { arrowright: Math.min(last, cur + 1), arrowleft: Math.max(0, cur - 1), home: 0, end: last };
    const next = k === "escape" ? undefined : moves[k as keyof typeof moves];
    if (next !== undefined) {
      e.preventDefault();
      setActive(atBar(next));
    } else if (active) {
      e.stopPropagation();
      setActive(null);
    }
  };
  const onMove = (i: number) => (e: MouseEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    setActive({ i, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  let body;
  if (table) {
    body = (
      <table className="ttable">
        <thead>
          <tr><th>{unit === "hour" ? "Hour" : "Day"}</th><th className="num">From QR</th><th className="num">Typed or clicked</th><th className="num">Total</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td>{r.label}</td><td className="num">{fmt(r.qr)}</td><td className="num">{fmt(r.typed)}</td><td className="num">{fmt(r.qr + r.typed)}</td></tr>
          ))}
        </tbody>
      </table>
    );
  } else if (!total) {
    body = <div className="empty">{empty}</div>;
  } else {
    body = (
      <div
        className="chart-wrap"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label="Clicks chart. Use the arrow keys, Home and End to read each bar."
        onKeyDown={onKey}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !active) setActive(atBar(0));
        }}
        onBlur={() => setActive(null)}
      >
        <svg ref={svgRef} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Clicks over time, with the share from QR scans">
          {g.grid.map((l, k) => (
            <g key={k}>
              <line className="grid" x1={g.gridX.x1} x2={g.gridX.x2} y1={l.y} y2={l.y} />
              <text x={g.gridX.label} y={l.y + 4} textAnchor="end">{l.label}</text>
            </g>
          ))}
          <path className="l-area" d={g.lines.area} />
          <path className="l-all" d={g.lines.all} />
          <path className="l-qr" d={g.lines.qr} />
          {g.bars.map((b, i) => (
            <g key={i} className={active?.i === i ? "bar on" : "bar"} onMouseMove={onMove(i)} onMouseLeave={() => setActive(null)}>
              <rect x={b.hx} y={g.plot.top} width={b.hw} height={g.plot.height} fill="transparent" />
              {(active?.i === i || g.bars.length === 1) && ( // one day has no line to draw: show its points
                <>
                  <line className="l-guide" x1={b.cx} x2={b.cx} y1={g.plot.top} y2={g.plot.top + g.plot.height} />
                  <circle className="d-qr" cx={b.cx} cy={b.yQr} r={3} />
                  <circle className="d-all" cx={b.cx} cy={b.yAll} r={3.5} />
                </>
              )}
            </g>
          ))}
          {g.ticks.map((t) => (
            <text key={t.x} x={t.x} y={g.tickY} textAnchor="middle">{t.label}</text>
          ))}
        </svg>
        <div className={bar ? "tip on" : "tip"} ref={tipRef} aria-hidden="true">{bar?.tip ?? ""}</div>
        {/* Always in the tree (visually hidden), so the first change on focus is announced. */}
        <div className="sr-only" role="status">{bar?.tip ?? ""}</div>
      </div>
    );
  }

  return (
    <section
      className="chart-sec"
      ref={cardRef}
      onFocus={() => (focusIn.current = true)}
      // A blur with no new target (the focused node was removed) keeps the flag, so the effect above can restore focus.
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusIn.current = false;
      }}
    >
      <div className="card2-h">
        <h3>{title}</h3>
        <div className="legend">
          <span><i className="lg-ty" />All clicks</span>
          <span><i className="lg-qr" />From QR codes</span>
        </div>
        <button type="button" className="btn sm tv" ref={toggleRef} onClick={onToggle} aria-keyshortcuts="V">
          {table ? "Chart view" : "Table view"}<span className="k2">V</span>
        </button>
      </div>
      {body}
    </section>
  );
}
