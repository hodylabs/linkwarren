import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { AnalyticsReport } from "../api";
import { bucketLabel, chartGeometry, GRID_X, H, PLOT, TICK_Y, W } from "./chart";
import { fmt } from "./view";

type Props = { series: AnalyticsReport["series"]; unit: AnalyticsReport["unit"]; table: boolean; onToggle: () => void };
type Active = { i: number; x: number; y: number } | null;

/** Stacked bar chart of clicks per bucket (QR bottom, typed top) with a hover and keyboard tooltip, or the same data as a table. */
export function ClicksChart({ series, unit, table, onToggle }: Props) {
  const rows = series.map((s) => ({ label: bucketLabel(s.bucket, unit), qr: s.qr, typed: s.typed }));
  const total = rows.reduce((n, r) => n + r.qr + r.typed, 0);
  const g = chartGeometry(rows);
  const [active, setActive] = useState<Active>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const bar = active ? g.bars[active.i] : undefined;

  // The tip is placed through the CSSOM (allowed by the style-src CSP), never a style attribute.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!active || !tip) return;
    // Keep the centred tip inside the card on narrow screens.
    const half = tip.offsetWidth / 2, room = wrapRef.current?.clientWidth ?? 0;
    tip.style.left = `${room > 2 * half ? Math.min(Math.max(active.x, half), room - half) : active.x}px`;
    tip.style.top = `${active.y}px`;
  }, [active]);

  const title = unit === "hour" ? "Clicks per hour, last 24 hours" : `Clicks per day, ${rows[0]?.label ?? ""} to ${rows.at(-1)?.label ?? ""}`;

  // Keyboard: put the tip over the top of bar i (viewBox units scaled to the drawn size).
  const atBar = (i: number): Active => {
    const b = g.bars[i]!;
    const s = svgRef.current?.getBoundingClientRect();
    const w = wrapRef.current?.getBoundingClientRect();
    const sx = s ? s.width / W : 0, sy = s ? s.height / H : 0;
    const ox = s && w ? s.left - w.left : 0, oy = s && w ? s.top - w.top : 0;
    return { i, x: ox + (b.x + b.w / 2) * sx, y: oy + b.yTop * sy };
  };
  const onKey = (e: KeyboardEvent) => {
    const last = g.bars.length - 1;
    const cur = active?.i ?? 0;
    const next = { ArrowRight: Math.min(last, cur + 1), ArrowLeft: Math.max(0, cur - 1), Home: 0, End: last }[e.key];
    if (next !== undefined) {
      e.preventDefault();
      setActive(atBar(next));
    } else if (e.key === "Escape" && active) {
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
    body = <div className="empty">No clicks match these filters. Try a longer range or another domain.</div>;
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
        <svg ref={svgRef} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Clicks over time split into QR scans and typed or clicked visits">
          {g.grid.map((l, k) => (
            <g key={k}>
              <line x1={GRID_X.x1} x2={GRID_X.x2} y1={l.y} y2={l.y} stroke="#EEEFEB" />
              <text x={GRID_X.label} y={l.y + 4} textAnchor="end">{l.label}</text>
            </g>
          ))}
          {g.bars.map((b, i) => (
            <g key={i} className={active?.i === i ? "bar on" : "bar"} onMouseMove={onMove(i)} onMouseLeave={() => setActive(null)}>
              <rect x={b.hx} y={PLOT.top} width={b.hw} height={PLOT.height} fill="transparent" />
              {b.qrH > 0 && <rect x={b.x} y={b.qrY} width={b.w} height={b.qrH} fill="#E07418" />}
              {b.typedPath && <path d={b.typedPath} fill="#3F6FB5" />}
            </g>
          ))}
          {g.ticks.map((t) => (
            <text key={t.x} x={t.x} y={TICK_Y} textAnchor="middle">{t.label}</text>
          ))}
        </svg>
        <div className={bar ? "tip on" : "tip"} ref={tipRef} role="status">{bar?.tip ?? ""}</div>
      </div>
    );
  }

  return (
    <section className="card2">
      <div className="card2-h">
        <h3>{title}</h3>
        <div className="legend">
          <span><i className="lg-qr" />From QR codes</span>
          <span><i className="lg-ty" />Typed or clicked</span>
        </div>
        <button type="button" className="btn ghost tv" onClick={onToggle} aria-keyshortcuts="V">
          {table ? "Chart view" : "Table view"}<span className="k2">V</span>
        </button>
      </div>
      {body}
    </section>
  );
}
