import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AnalyticsReport, DetailReport, PrintCount } from "../api";
import { NavLink } from "../router";
import type { Dim, DimFilter } from "./filters";
import { fmt } from "./view";

/** `mono`: this row is an address (host/slug), set in the mono face; a named top link is not. `filter`: what a click on it filters by. */
type Row = { label: string; value: number; to?: string; mono?: boolean; filter?: DimFilter };
type Count = { value: string; clicks: number };
const desc = <T extends { clicks: number }>(xs: T[]) => [...xs].sort((a, b) => b.clicks - a.clicks);
const host = (h: string) => h || "Unknown domain";
/** The per-link analytics page of a link (S10). */
export const linkPage = (linkId: string, query = "") => `/analytics/link/${encodeURIComponent(linkId)}${query ? `?${query}` : ""}`;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
export function countryName(code: string): string {
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
/** S13 R3: the rollup folds the tail of visitor-made values into this one; it reads Other and is never a filter. */
const OTHER_RAW = "(other)";
const recorded = (v: string) => v || NOT_RECORDED;
const untagged = (v: string) => v || "Not tagged";

/** A dimension's name in chips and in the "Filter by" names of rows. */
export const DIM_LABEL: Record<Dim, string> = {
  country: "Country", place: "Place", device: "Device", os: "Operating system", browser: "Browser", language: "Language",
  referrer: "Referrer", source: "Source", domain: "Domain", print: "Print", utm_source: "UTM source", utm_medium: "UTM medium",
  utm_campaign: "UTM campaign",
};
const SOURCES: Record<string, string> = { qr: "QR code scanned", typed: "Link opened" };

/** A print's name: its label, "Unlabelled print (code)" when it has none, "QR, no label" for a plain `?lw=qr` scan (R4). */
export function printName(code: string, label: string | null | undefined): string {
  if (!code) return "QR, no label";
  return label ?? `Unlabelled print (${code})`;
}

/** A filter's value as people read it, the same words as its breakdown row. `hostOf` and `prints` name domains and prints. */
export function filterText(f: DimFilter, hostOf: (id: string) => string = (id) => id, prints: PrintCount[] = []): string {
  const v = f.value;
  switch (f.dim) {
    case "country": return countryName(v);
    case "device": return DEVICES[v] ?? "Other";
    case "language": return languageName(v);
    case "referrer": return v || "Direct, typed or saved";
    case "source": return SOURCES[v] ?? v;
    case "domain": return host(hostOf(v));
    case "print": return printName(v, prints.find((p) => p.value === v)?.label);
    case "utm_source": case "utm_medium": case "utm_campaign": return untagged(v);
    default: return recorded(v);
  }
}

/** Keeps the first `n` rows and folds the rest into one `other` row when it has clicks. */
function topN(rows: Row[], n: number, other: string): Row[] {
  const rest = rows.slice(n).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...rows.slice(0, n), { label: other, value: rest }] : rows.slice(0, n);
}

/**
 * Counts to rows: labels mapped (same label merged), biggest first, top 4 then Other. With `dim`, a row backed by exactly
 * one value filters by it; a merged label (Unknown), Other and the rollup's "(other)" do not.
 */
function named(xs: Count[], name: (v: string) => string, dim?: Dim): Row[] {
  const by = new Map<string, { value: number; raw: string[] }>();
  for (const c of xs) {
    const label = c.value === OTHER_RAW ? "Other" : name(c.value);
    const e = by.get(label) ?? { value: 0, raw: [] };
    e.value += c.clicks;
    // Prints come one per link, so one code ("" for plain QR) can repeat: still one value, still a filter.
    if (!e.raw.includes(c.value)) e.raw.push(c.value);
    by.set(label, e);
  }
  const rows = [...by].map(([label, e]): Row => {
    const one = e.raw.length === 1 && e.raw[0] !== OTHER_RAW ? e.raw[0]! : null;
    return { label, value: e.value, filter: dim && one !== null ? { dim, value: one } : undefined };
  });
  return topN(rows.sort((a, b) => b.value - a.value), 4, "Other");
}

export const countryRows = (countries: AnalyticsReport["countries"]): Row[] => named(countries, countryName, "country");
export const deviceRows = (devices: Count[]): Row[] => named(devices, (v) => DEVICES[v] ?? "Other", "device");
/** Prints by code (an unlabelled print names its code, so two stay two rows); each filters by its code. */
export function printRows(prints: PrintCount[]): Row[] {
  const label = new Map(prints.map((p) => [p.value, p.label]));
  return named(prints, (v) => printName(v, label.get(v)), "print");
}

export function referrerRows(r: AnalyticsReport): Row[] {
  const hosts = desc(r.referrers.filter((x) => x.value !== "")).map((x): Row => (
    x.value === OTHER_RAW ? { label: "Other sites", value: x.clicks } : { label: x.value, value: x.clicks, filter: { dim: "referrer", value: x.value } }
  ));
  const direct = r.referrers.filter((x) => x.value === "").reduce((s, x) => s + x.clicks, 0);
  return [
    { label: "QR code (no referrer)", value: r.totals.qr, filter: { dim: "source", value: "qr" } },
    ...topN(hosts, 4, "Other sites"),
    { label: "Direct, typed or saved", value: direct, filter: { dim: "referrer", value: "" } },
  ];
}

/** What a breakdown row click does: `on` are the filters in force (a row of one reads pressed), `pick` toggles a row's filter. */
export type FilterCtl = { on: DimFilter[]; pick: (f: DimFilter) => void };
const same = (a: DimFilter, b: DimFilter) => a.dim === b.dim && a.value === b.value;

/** One list of bars: label, count, share and a thin bar (an SVG rect, so a width needs no style attribute under the CSP). */
/** `of`: the denominator of the share (Top links passes the report total: it shows only the top six). */
/** With `ctl`, a row with a filter is a toggle button named "Filter by <dimension>: <row>" (S13). */
function Bars({ rows, mono, empty, of, ctl }: { rows: Row[]; mono?: boolean; empty: string; of?: number; ctl?: FilterCtl }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const total = of || rows.reduce((s, r) => s + r.value, 0);
  if (max === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="bars">
      {rows.map((r, i) => (
        <li key={i}>
          {r.filter && ctl ? (
            <button
              type="button"
              className={(r.mono ?? mono) ? "hb-l hb-f mono" : "hb-l hb-f"}
              aria-pressed={ctl.on.some((x) => same(x, r.filter!))}
              aria-label={`Filter by ${DIM_LABEL[r.filter.dim]}: ${r.label}`}
              title={`Filter by ${r.label}`}
              onClick={() => ctl.pick(r.filter!)}
            >
              {r.label}
            </button>
          ) : r.to ? (
            <NavLink to={r.to} className={(r.mono ?? mono) ? "hb-l mono" : "hb-l"} title={`Analytics for ${r.label}`}>{r.label}</NavLink>
          ) : (
            <span className={(r.mono ?? mono) ? "hb-l mono" : "hb-l"} title={r.label}>{r.label}</span>
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
const Column = ({ title, rows, mono, empty = EMPTY, ctl }: { title: string; rows: Row[]; mono?: boolean; empty?: string; ctl?: FilterCtl }) => (
  <section>
    <h4>{title}</h4>
    <Bars rows={rows} mono={mono} empty={empty} ctl={ctl} />
  </section>
);

const TABS = [
  { id: "places", label: "Places" },
  { id: "sources", label: "Sources" },
  { id: "devices", label: "Devices" },
  { id: "campaigns", label: "Campaigns" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * The Breakdown card: three tabs (Places, Sources, Devices) of three columns each, then Top links beside `busy` (the
 * "When people click" card). A per-link page leaves out Top links and Domains. `range`: the date part of the filters, kept
 * when a top link opens its page. `detail` (Analytics Engine only, so the last 90 days at most) feeds operating systems,
 * browsers, languages, places, prints and UTM tags; undefined while it loads, null when it failed. `filters` (S13) makes
 * every row backed by one value a button that filters the page by it.
 */
export function Breakdowns({ report: r, detail, perLink = false, range = "", note, busy, filters: c }: {
  report: AnalyticsReport; detail?: DetailReport | null; perLink?: boolean; range?: string; note?: ReactNode; busy?: ReactNode; filters?: FilterCtl;
}) {
  const [tab, setTab] = useState<Tab>("places");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const none = detail === undefined ? "Loading" : detail === null || detail.live !== "ok" ? "Not available for this range" : undefined;
  // Some print or UTM lists were left out because the view was too big for one answer (S13 detail budget).
  const cutNote = detail?.cut ? "Too many to list here: pick fewer domains or a shorter range" : undefined;
  const det = (xs: Count[] | undefined, name: (v: string) => string, dim: Dim) => named(xs ?? [], name, dim);
  const columns: Record<Tab, ReactNode> = {
    places: (
      <>
        <Column title="Countries" rows={countryRows(r.countries)} ctl={c} />
        <Column title="Cities and regions" rows={det(detail?.places, recorded, "place")} empty={none} ctl={c} />
        <Column title="Languages" rows={det(detail?.languages, languageName, "language")} empty={none} ctl={c} />
      </>
    ),
    sources: (
      <>
        <Column title="Where clicks came from" rows={referrerRows(r)} ctl={c} />
        <Column
          title="QR scans or link opens"
          rows={[
            { label: SOURCES.typed!, value: r.totals.clicks - r.totals.qr, filter: { dim: "source", value: "typed" } },
            { label: SOURCES.qr!, value: r.totals.qr, filter: { dim: "source", value: "qr" } },
          ]}
          ctl={c}
        />
        {!perLink && <Column title="Domains" rows={desc(r.domains).map((d) => ({ label: host(d.host), value: d.clicks, filter: { dim: "domain" as const, value: d.domainId } }))} ctl={c} />}
      </>
    ),
    devices: (
      <>
        <Column title="Devices" rows={deviceRows(r.devices)} ctl={c} />
        <Column title="Operating systems" rows={det(detail?.os, recorded, "os")} empty={none} ctl={c} />
        <Column title="Browsers" rows={det(detail?.browsers, recorded, "browser")} empty={none} ctl={c} />
      </>
    ),
    campaigns: (
      <>
        <Column title="QR prints" rows={printRows(detail?.prints ?? [])} empty={cutNote ?? none} ctl={c} />
        <Column title="UTM source" rows={det(detail?.utmSources, untagged, "utm_source")} empty={cutNote ?? none} ctl={c} />
        <Column title="UTM medium" rows={det(detail?.utmMediums, untagged, "utm_medium")} empty={cutNote ?? none} ctl={c} />
        <Column title="UTM campaign" rows={det(detail?.utmCampaigns, untagged, "utm_campaign")} empty={cutNote ?? none} ctl={c} />
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
  // S12: a named link shows its name; an unnamed one its address (host/slug).
  const top = desc(r.links).slice(0, 6).map((l) => ({ label: l.name ?? `${host(l.host)}/${l.slug}`, mono: !l.name, value: l.clicks, to: linkPage(l.linkId, range) }));
  const lower = [!perLink && (
    <section className="card toplinks-card" key="top">
      <div className="card-h"><h3>Top links</h3></div>
      <div className="card-b"><Bars rows={top} mono empty={EMPTY} of={r.totals.clicks} /></div>
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
          <div key={t.id} className={t.id === "campaigns" ? "bd c4" : "bd"} role="tabpanel" tabIndex={0} id={`bd-panel-${t.id}`} aria-labelledby={`bd-tab-${t.id}`} hidden={tab !== t.id}>
            {tab === t.id && columns[t.id]}
          </div>
        ))}
      </section>
      {lower.length > 0 && <div className={lower.length === 2 ? "cols2" : "cols2 one"}>{lower}</div>}
    </>
  );
}
