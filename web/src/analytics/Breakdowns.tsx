import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
const EMPTY = "No clicks match these filters";

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

/** One list of bars: label, count, share and a thin bar (an SVG rect, so a width needs no style attribute under the CSP). */
function Bars({ rows, mono, empty }: { rows: Row[]; mono?: boolean; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (max === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="bars">
      {rows.map((r, i) => (
        <li key={i}>
          {r.to ? (
            <NavLink to={r.to} className={mono ? "hb-l mono" : "hb-l"} title={`Analytics for ${r.label}`}>{r.label}</NavLink>
          ) : (
            <span className={mono ? "hb-l mono" : "hb-l"} title={r.label}>{r.label}</span>
          )}
          <span className="hb-n">
            <span className="hb-v">{fmt(r.value)}</span>
            <small>{Math.round((100 * r.value) / total)}%</small>
          </span>
          <span className="bt" aria-hidden="true">
            <svg viewBox="0 0 100 3" preserveAspectRatio="none"><rect className="bg" width="100" height="3" rx="1.5" /><rect className="fg" width={(r.value / max) * 100} height="3" rx="1.5" /></svg>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One column of the Breakdown card, or the Top links card. */
const Column = ({ title, rows, mono, empty = EMPTY }: { title: string; rows: Row[]; mono?: boolean; empty?: string }) => (
  <section>
    <h4>{title}</h4>
    <Bars rows={rows} mono={mono} empty={empty} />
  </section>
);

const TABS = [
  { id: "places", label: "Places" },
  { id: "sources", label: "Sources" },
  { id: "devices", label: "Devices" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * The Breakdown card: three tabs (Places, Sources, Devices) of three columns each, then Top links beside `busy` (the
 * "When people click" card). A per-link page leaves out Top links and Domains. `range`: the date part of the filters, kept
 * when a top link opens its page. `detail` (Analytics Engine only, so the last 90 days at most) feeds operating systems,
 * browsers, languages and places; undefined while it loads, null when it failed.
 */
export function Breakdowns({ report: r, detail, perLink = false, range = "", note, busy }: {
  report: AnalyticsReport; detail?: DetailReport | null; perLink?: boolean; range?: string; note?: ReactNode; busy?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("places");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const none = detail === undefined ? "Loading" : detail === null || detail.live !== "ok" ? "Not available for this range" : undefined;
  const det = (xs: Count[] | undefined, name: (v: string) => string) => named(xs ?? [], name);
  const columns: Record<Tab, ReactNode> = {
    places: (
      <>
        <Column title="Countries" rows={countryRows(r.countries)} />
        <Column title="Cities and regions" rows={det(detail?.places, (v) => v || NOT_RECORDED)} empty={none} />
        <Column title="Languages" rows={det(detail?.languages, languageName)} empty={none} />
      </>
    ),
    sources: (
      <>
        <Column title="Where clicks came from" rows={referrerRows(r)} />
        <Column title="QR scans or link opens" rows={[{ label: "Link opened", value: r.totals.clicks - r.totals.qr }, { label: "QR code scanned", value: r.totals.qr }]} />
        {!perLink && <Column title="Domains" rows={desc(r.domains).map((d) => ({ label: host(d.host), value: d.clicks }))} />}
      </>
    ),
    devices: (
      <>
        <Column title="Devices" rows={deviceRows(r.devices)} />
        <Column title="Operating systems" rows={det(detail?.os, (v) => v || NOT_RECORDED)} empty={none} />
        <Column title="Browsers" rows={det(detail?.browsers, (v) => v || NOT_RECORDED)} empty={none} />
      </>
    ),
  };
  // The ARIA tab pattern: one Tab stop, the arrows, Home and End move and select.
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const keys: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
    const to = keys[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const n = (to + TABS.length) % TABS.length;
    setTab(TABS[n]!.id);
    tabRefs.current[n]?.focus();
  };
  const top = desc(r.links).slice(0, 6).map((l) => ({ label: `${host(l.host)}/${l.slug}`, value: l.clicks, to: linkPage(l.linkId, range) }));
  const lower = [!perLink && (
    <section className="card toplinks-card" key="top">
      <div className="card-h"><h3>Top links</h3></div>
      <div className="card-b"><Bars rows={top} mono empty={EMPTY} /></div>
    </section>
  ), busy].filter(Boolean);
  return (
    <>
      <section className="card" aria-labelledby="bd-h">
        <div className="card-h">
          <h3 id="bd-h">Breakdown</h3>
          <span className="sub">{note ?? "Top four of each, the rest in Other"}</span>
          <span className="end">
            <span className="tabs" role="tablist" aria-label="Breakdown" onKeyDown={onKey}>
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  ref={(el) => void (tabRefs.current[i] = el)}
                  type="button"
                  role="tab"
                  className="tab"
                  id={`bd-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`bd-panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </span>
          </span>
        </div>
        {TABS.map((t) => (
          <div key={t.id} className="bd" role="tabpanel" tabIndex={0} id={`bd-panel-${t.id}`} aria-labelledby={`bd-tab-${t.id}`} hidden={tab !== t.id}>
            {tab === t.id && columns[t.id]}
          </div>
        ))}
      </section>
      {lower.length > 0 && <div className={lower.length === 2 ? "cols2" : "cols2 one"}>{lower}</div>}
    </>
  );
}
