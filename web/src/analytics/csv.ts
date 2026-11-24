import type { AnalyticsReport, DetailReport } from "../api";
import type { DimFilter } from "./filters";

/** One CSV cell (R10): formula starters (= + - @ tab CR) get a leading ', then RFC 4180 quoting. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const section = (head: string, rows: (string | number)[][]) => [head, ...rows.map((r) => r.map(csvCell).join(","))].join("\n");

/**
 * The loaded report as CSV: the breakdown filters it answers (S13, when any), series, links, domains, countries, devices,
 * referrers, then the detail when loaded (S10) with prints and UTM tags when the server sent them, blank line between sections.
 */
export function toCsv(r: AnalyticsReport, unit: AnalyticsReport["unit"], d: DetailReport | null = null, filters: DimFilter[] = []): string {
  const counts = (xs: { value: string; clicks: number }[], blank = "") => xs.map((c) => [c.value || blank, c.clicks]);
  const opt = (head: string, xs: { value: string; clicks: number }[] | undefined, blank: string) => (xs?.length ? [section(head, counts(xs, blank))] : []);
  return [
    ...(filters.length ? [section("filter,value", filters.map((x) => [x.dim, x.value]))] : []),
    section(`${unit},from_qr,typed_or_clicked,total`, r.series.map((s) => [s.bucket, s.qr, s.typed, s.qr + s.typed])),
    section("link,clicks", r.links.map((l) => [`${l.host}/${l.slug}`, l.clicks])),
    section("domain,clicks", r.domains.map((d) => [d.host, d.clicks])),
    section("country,clicks", counts(r.countries)),
    section("device,clicks", counts(r.devices)),
    section("referrer,clicks", counts(r.referrers, "direct")),
    ...(d
      ? [
          section("os,clicks", counts(d.os, "not recorded")),
          section("browser,clicks", counts(d.browsers, "not recorded")),
          section("language,clicks", counts(d.languages, "not recorded")),
          section("place,clicks", counts(d.places, "not recorded")),
          ...(d.prints?.length ? [section("print,label,clicks", d.prints.map((p) => [p.value || "plain qr", p.label ?? "", p.clicks]))] : []),
          ...opt("utm_source,clicks", d.utmSources, "not tagged"),
          ...opt("utm_medium,clicks", d.utmMediums, "not tagged"),
          ...opt("utm_campaign,clicks", d.utmCampaigns, "not tagged"),
          section("weekday,hour,clicks", d.hours.flatMap((row, w) => row.map((n, h) => [WEEK[w]!, h, n]))),
        ]
      : []),
  ].join("\n\n") + "\n";
}

/** Saves the CSV through a Blob URL and a temporary <a download> (CSP-safe), then revokes the URL. */
export function downloadCsv(r: AnalyticsReport, d: DetailReport | null = null, filters: DimFilter[] = []): void {
  // The BOM makes Excel read the file as UTF-8, so IDN hosts and non-ASCII slugs survive.
  const url = URL.createObjectURL(new Blob(["\uFEFF", toCsv(r, r.unit, d, filters)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  // Hour reports carry ISO hour keys; the file name keeps the day part only.
  a.download = `linkwarren-analytics-${r.from.slice(0, 10)}-to-${r.to.slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  // A short delay lets every browser start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
