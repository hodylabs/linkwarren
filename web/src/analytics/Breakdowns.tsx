import type { AnalyticsReport, DetailReport } from "../api";
import { NavLink } from "../router";
import { fmt } from "./view";

type Row = { label: string; value: number; to?: string };
type Count = { value: string; clicks: number };
const desc = <T extends { clicks: number }>(xs: T[]) => [...xs].sort((a, b) => b.clicks - a.clicks);
const host = (h: string) => h || "Unknown domain";
/** The per-link analytics page of a link (S10). */
export const linkPage = (linkId: string, query = "") => `/analytics/link/${encodeURIComponent(linkId)}${query ? `?${query}` : ""}`;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX") return "Unknown";
  try {
    return regions.of(code) ?? "Unknown";
  } catch {
    return "Unknown";
  }
}
const languages = new Intl.DisplayNames(["en"], { type: "language" });
/** "en-us" reads "American English"; a tag Intl cannot name stays as sent. */
export function languageName(tag: string): string {
  if (!tag) return NOT_RECORDED;
  try {
    return languages.of(tag) ?? tag;
  } catch {
    return tag;
  }
}
const NOT_RECORDED = "Not recorded";
const DEVICES: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Computer", other: "Other" };

/** Keeps the first `n` rows and folds the rest into one `other` row when it has clicks. */
function topN(rows: Row[], n: number, other: string): Row[] {
  const rest = rows.slice(n).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...rows.slice(0, n), { label: other, value: rest }] : rows.slice(0, n);
}

/** Counts to rows: labels mapped (same label merged), biggest first, top 4 then Other. */
function named(xs: Count[], name: (v: string) => string): Row[] {
  const by = new Map<string, number>();
  for (const c of xs) by.set(name(c.value), (by.get(name(c.value)) ?? 0) + c.clicks);
  return topN([...by].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), 4, "Other");
}

export const countryRows = (countries: AnalyticsReport["countries"]): Row[] => named(countries, countryName);
export const deviceRows = (devices: Count[]): Row[] => named(devices, (v) => DEVICES[v] ?? "Other");

export function referrerRows(r: AnalyticsReport): Row[] {
  const hosts = desc(r.referrers.filter((x) => x.value !== "")).map((x) => ({ label: x.value, value: x.clicks }));
  const direct = r.referrers.filter((x) => x.value === "").reduce((s, x) => s + x.clicks, 0);
  return [{ label: "QR code (no referrer)", value: r.totals.qr }, ...topN(hosts, 4, "Other sites"), { label: "Direct, typed or saved", value: direct }];
}

function Card({ title, rows, mono = false, empty = "No clicks match these filters" }: { title: string; rows: Row[]; mono?: boolean; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <section className="card2">
      <div className="card2-h"><h3>{title}</h3></div>
      {max === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        rows.map((r, i) => (
          <div className="hb" key={i}>
            {r.to ? (
              <NavLink to={r.to} className={mono ? "hb-l mono" : "hb-l"} title={`Analytics for ${r.label}`}>{r.label}</NavLink>
            ) : (
              <span className={mono ? "hb-l mono" : "hb-l"} title={r.label}>{r.label}</span>
            )}
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

/**
 * The breakdown cards. `range`: the date part of the filters, kept when a top link opens its page. The overview adds Top links (each opens its own page) and Domains; a per-link page leaves them out.
 * `detail` (Analytics Engine only, so the last 90 days at most) adds operating system, browser, language and place.
 */
export function Breakdowns({ report: r, detail, perLink = false, range = "" }: { report: AnalyticsReport; detail?: DetailReport | null; perLink?: boolean; range?: string }) {
  const none = detail === null || (detail && detail.live !== "ok") ? "Not available for this range" : undefined;
  return (
    <div className="grid4">
      {!perLink && (
        <Card title="Top links" mono rows={desc(r.links).slice(0, 6).map((l) => ({ label: `${host(l.host)}/${l.slug}`, value: l.clicks, to: linkPage(l.linkId, range) }))} />
      )}
      {!perLink && <Card title="Domains" rows={desc(r.domains).map((d) => ({ label: host(d.host), value: d.clicks }))} />}
      <Card title="Countries" rows={countryRows(r.countries)} />
      <Card title="Where clicks came from" rows={referrerRows(r)} />
      <Card title="Devices" rows={deviceRows(r.devices)} />
      {detail !== undefined && (
        <>
          <Card title="Operating systems" rows={named(detail?.os ?? [], (v) => v || NOT_RECORDED)} empty={none} />
          <Card title="Browsers" rows={named(detail?.browsers ?? [], (v) => v || NOT_RECORDED)} empty={none} />
          <Card title="Languages" rows={named(detail?.languages ?? [], languageName)} empty={none} />
          <Card title="Cities and regions" rows={named(detail?.places ?? [], (v) => v || NOT_RECORDED)} empty={none} />
        </>
      )}
    </div>
  );
}
