export const RANGES = ["1", "7", "30", "90", "custom"] as const;
export type Range = (typeof RANGES)[number];
export type Filters = { range: Range; from: string; to: string; domains: string[]; q: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC day (`YYYY-MM-DD`) plus `n` days. */
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Today as a UTC day. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** Filters from the URL. Default 30 days; custom without both dates is the last 14 days, as the mockup. */
export function readFilters(p: URLSearchParams, today: string): Filters {
  const r = p.get("range") ?? "30";
  const range: Range = (RANGES as readonly string[]).includes(r) ? (r as Range) : "30";
  let from = "";
  let to = "";
  if (range === "custom") {
    const f = p.get("from") ?? "";
    const t = p.get("to") ?? "";
    [from, to] = DAY.test(f) && DAY.test(t) ? [f, t] : [addDays(today, -13), today];
  }
  const domains = (p.get("domains") ?? "").split(",").filter(Boolean);
  return { range, from, to, domains, q: p.get("q") ?? "" };
}

/** The query string for filters: defaults and empties left out, dates only for a custom range. */
export function filtersQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.range !== "30") p.set("range", f.range);
  if (f.range === "custom") {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.domains.length) p.set("domains", f.domains.join(","));
  if (f.q) p.set("q", f.q);
  return p.toString();
}
