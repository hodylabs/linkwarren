import type { AnalyticsReport } from "../api";

/** One CSV cell (R10): formula starters get a leading ', then RFC 4180 quoting. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const section = (head: string, rows: (string | number)[][]) => [head, ...rows.map((r) => r.map(csvCell).join(","))].join("\n");

/** The loaded report as CSV: series, links, domains, countries, devices, referrers, blank line between sections. */
export function toCsv(r: AnalyticsReport, unit: AnalyticsReport["unit"]): string {
  const counts = (xs: { value: string; clicks: number }[], blank = "") => xs.map((c) => [c.value || blank, c.clicks]);
  return [
    section(`${unit},from_qr,typed_or_clicked,total`, r.series.map((s) => [s.bucket, s.qr, s.typed, s.qr + s.typed])),
    section("link,clicks", r.links.map((l) => [`${l.host}/${l.slug}`, l.clicks])),
    section("domain,clicks", r.domains.map((d) => [d.host, d.clicks])),
    section("country,clicks", counts(r.countries)),
    section("device,clicks", counts(r.devices)),
    section("referrer,clicks", counts(r.referrers, "direct")),
  ].join("\n\n") + "\n";
}

/** Saves the CSV through a Blob URL and a temporary <a download> (CSP-safe), then revokes the URL. */
export function downloadCsv(r: AnalyticsReport): void {
  const url = URL.createObjectURL(new Blob([toCsv(r, r.unit)], { type: "text/csv;charset=utf-8" }));
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
