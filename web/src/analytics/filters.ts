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

/** A real calendar day in `YYYY-MM-DD` (rejects 2026-02-30), as the server's check. */
const realDay = (v: string): boolean => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return DAY.test(v) && !isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/**
 * Why a custom range would be refused, mirroring the server (src/analytics.ts resolveRange): real days, `from` on or
 * before `to`, `to` not after today, at most 366 days counting both ends. "order" and "bad_range" map to copy; null is fine.
 */
export function rangeProblem(from: string, to: string, today: string): "order" | "bad_range" | null {
  if (!realDay(from) || !realDay(to)) return "bad_range";
  if (from > to) return "order";
  if (to > today) return "bad_range";
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > 366 ? "bad_range" : null;
}
