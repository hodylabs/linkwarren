import { useEffect, useState } from "react";
import { api, type RecentClick, type RecentReport } from "../api";
import { countryName, filterText, printName } from "./Breakdowns";

/** About once a minute (S13), and only while the page is visible. */
export const POLL_MS = 60_000;
const NOTE = {
  off: "Recent clicks need live clicks, which are off on this instance.",
  unavailable: "Recent clicks could not be loaded. Trying again shortly.",
} as const;

/** "just now", "5 min ago", "3 h ago": the card only holds the last 24 hours. */
export function ago(at: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(at)) / 60_000);
  if (min < 1) return "just now";
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

const place = (c: RecentClick) => [c.place, c.country ? countryName(c.country) : ""].filter(Boolean).join(", ") || "Unknown";
const device = (c: RecentClick) => [filterText({ dim: "device", value: c.device }), c.os, c.browser].filter(Boolean).join(" · ");
const source = (c: RecentClick) => (c.source === "qr" ? printName(c.print, c.printLabel) : "Link opened");

/**
 * The Recent clicks card: GET /api/analytics/recent with the page's filters (`query`), polled every minute. One request at a
 * time (the next is scheduled when the last settles); a hidden page stops polling and a visible one loads at once.
 * `perLink` leaves out the link column.
 */
export function RecentClicks({ query, perLink = false }: { query: string; perLink?: boolean }) {
  // The answer with the query it answers, so a change of filters never shows the old rows as the new ones.
  const [data, setData] = useState<{ query: string; r: RecentReport | null } | null>(null);

  useEffect(() => {
    let ac: AbortController | null = null;
    let t: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const hidden = () => document.visibilityState === "hidden";
    const load = () => {
      clearTimeout(t);
      t = undefined;
      if (ac || hidden()) return;
      const mine = (ac = new AbortController());
      api<RecentReport>("GET", `/api/analytics/recent${query ? `?${query}` : ""}`, undefined, mine.signal)
        .then(
          (r) => setData({ query, r }),
          () => {
            if (!mine.signal.aborted) setData({ query, r: null });
          },
        )
        .finally(() => {
          if (ac === mine) ac = null;
          if (!stopped && !hidden()) t = setTimeout(load, POLL_MS);
        });
    };
    const onVis = () => {
      if (!hidden()) return load();
      clearTimeout(t);
      t = undefined;
    };
    document.addEventListener("visibilitychange", onVis);
    load();
    return () => {
      stopped = true;
      clearTimeout(t);
      ac?.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [query]);

  const cur = data?.query === query ? data : null;
  const r = cur?.r;
  let body;
  if (!cur) body = <p className="empty">Loading</p>;
  else if (!r || r.live !== "ok") body = <p className="note" role="status">{NOTE[r?.live === "off" ? "off" : "unavailable"]}</p>;
  else if (!r.items.length) body = <p className="empty">No clicks in the last 24 hours match these filters</p>;
  else {
    const now = Date.now();
    body = (
      <div className="rwrap">
        <table className="ttable rtable">
          <thead>
            <tr>
              <th>When</th>
              {!perLink && <th>Link</th>}
              <th>Place</th>
              <th>Device</th>
              <th>Source</th>
              <th>Referrer</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((c, i) => (
              <tr key={`${c.at}-${i}`}>
                <td><time dateTime={c.at} title={new Date(c.at).toLocaleString()}>{ago(c.at, now)}</time></td>
                {!perLink && <td className="mono">{c.host}/{c.slug}</td>}
                <td>{place(c)}</td>
                <td>{device(c)}</td>
                <td>{source(c)}</td>
                <td>{c.referrer || "Direct"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className="card recent" aria-labelledby="rc-h">
      <div className="card-h">
        <h3 id="rc-h">Recent clicks</h3>
        <span className="sub">Last 50 in the last 24 hours, updated every minute</span>
      </div>
      <div className="card-b">{body}</div>
    </section>
  );
}
