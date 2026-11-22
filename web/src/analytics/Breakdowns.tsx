import type { AnalyticsReport } from "../api";
import { fmt } from "./view";

type Row = { label: string; value: number };
const desc = <T extends { clicks: number }>(xs: T[]) => [...xs].sort((a, b) => b.clicks - a.clicks);
const host = (h: string) => h || "Unknown domain";

const regions = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX") return "Unknown";
  try {
    return regions.of(code) ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

/** Keeps the first `n` rows and folds the rest into one `other` row when it has clicks. */
function topN(rows: Row[], n: number, other: string): Row[] {
  const rest = rows.slice(n).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...rows.slice(0, n), { label: other, value: rest }] : rows.slice(0, n);
}

export function countryRows(countries: AnalyticsReport["countries"]): Row[] {
  const by = new Map<string, number>();
  for (const c of countries) by.set(countryName(c.value), (by.get(countryName(c.value)) ?? 0) + c.clicks);
  const rows = [...by].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return topN(rows, 4, "Other");
}

export function referrerRows(r: AnalyticsReport): Row[] {
  const hosts = desc(r.referrers.filter((x) => x.value !== "")).map((x) => ({ label: x.value, value: x.clicks }));
  const direct = r.referrers.filter((x) => x.value === "").reduce((s, x) => s + x.clicks, 0);
  return [{ label: "QR code (no referrer)", value: r.totals.qr }, ...topN(hosts, 4, "Other sites"), { label: "Direct, typed or saved", value: direct }];
}

function Card({ title, rows, mono = false }: { title: string; rows: Row[]; mono?: boolean }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <section className="card2">
      <div className="card2-h"><h3>{title}</h3></div>
      {max === 0 ? (
        <div className="empty">No clicks match these filters</div>
      ) : (
        rows.map((r, i) => (
          <div className="hb" key={i}>
            <span className={mono ? "hb-l mono" : "hb-l"} title={r.label}>{r.label}</span>
            {/* The bar is an SVG rect: a width needs no style attribute under the CSP. */}
            <span className="hb-t" aria-hidden="true">
              <svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect width={(r.value / max) * 100} height="8" fill="#E07418" /></svg>
            </span>
            <span className="hb-v">{fmt(r.value)}</span>
          </div>
        ))
      )}
    </section>
  );
}

/** The four breakdown cards. Devices are in the CSV only (R7). */
export function Breakdowns({ report: r }: { report: AnalyticsReport }) {
  return (
    <div className="grid4">
      <Card title="Top links" mono rows={desc(r.links).slice(0, 6).map((l) => ({ label: `${host(l.host)}/${l.slug}`, value: l.clicks }))} />
      <Card title="Domains" rows={desc(r.domains).map((d) => ({ label: host(d.host), value: d.clicks }))} />
      <Card title="Countries" rows={countryRows(r.countries)} />
      <Card title="Where clicks came from" rows={referrerRows(r)} />
    </div>
  );
}
