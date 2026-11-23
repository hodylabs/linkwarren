import { fmt } from "./view";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Shade step 0..4 of a cell (a class, not a style: the CSP allows no style attributes). The number in the cell is the real value. */
export const level = (n: number, max: number): number => (n <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4)));

/** The busiest weekday and hour, or null when there are no clicks. */
export function busiest(hours: number[][]): { day: number; hour: number; clicks: number } | null {
  let best: { day: number; hour: number; clicks: number } | null = null;
  hours.forEach((row, day) => row.forEach((clicks, hour) => {
    if (clicks > 0 && (!best || clicks > best.clicks)) best = { day, hour, clicks };
  }));
  return best;
}

/**
 * When people click: a 7 x 24 table (weekday rows, hour columns) in the viewer's zone. Every cell holds its count as text;
 * the shade only repeats it. On a phone the table scrolls sideways inside its own focusable box.
 */
export function BusyTimes({ hours, zone }: { hours: number[][]; zone: string }) {
  const max = Math.max(0, ...hours.flat());
  const top = busiest(hours);
  return (
    <section className="card2 busy" aria-labelledby="busy-h">
      <div className="card2-h"><h3 id="busy-h">When people click</h3></div>
      {top ? (
        <p className="muted">
          Busiest: {DAYS[top.day]} {hh(top.hour)} to {hh((top.hour + 1) % 24)}, {fmt(top.clicks)} clicks. Times are in {zone}.
        </p>
      ) : (
        <div className="empty">No clicks match these filters</div>
      )}
      {top && (
        <div className="busy-wrap" tabIndex={0} role="region" aria-label="Clicks by weekday and hour, scrolls sideways">
          <table className="busy-t">
            <caption className="sr-only">Clicks by weekday (rows) and hour of the day (columns), times in {zone}</caption>
            <thead>
              <tr>
                <td />
                {Array.from({ length: 24 }, (_, h) => <th key={h} scope="col" abbr={hh(h)}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {hours.map((row, d) => (
                <tr key={d}>
                  <th scope="row" abbr={DAYS[d]}>{DAYS[d]!.slice(0, 3)}</th>
                  {row.map((n, h) => <td key={h} className={`lv${level(n, max)}`}>{n}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
