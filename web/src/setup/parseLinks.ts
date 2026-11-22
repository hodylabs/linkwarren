/** The POST /api/import body (src/api/import.ts). `host` null = the export's main host. */
export type ImportLink = { host: string | null; slug: string; destination: string; enabled: boolean; startDate?: string | null; endDate?: string | null };
export type ImportBody = {
  mainHost: string;
  domains: { host: string; customIndexUrl?: string | null; customNotFoundUrl?: string | null }[];
  links: ImportLink[];
};
/** `line` counts the header as 1; 0 is the whole file. */
export type LineError = { line: number; reason: string };
export type Parsed = { body: ImportBody | null; errors: LineError[] };

export const NOT_AN_EXPORT = "This JSON is not a linkwarren or legacy export";

/** RFC 4180: quoted fields may hold commas, line breaks and "" for a quote. CRLF or LF; a leading BOM is dropped; blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (s[i + 1] !== "\n") endRow(); }
    else field += ch;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

const BOOL: Record<string, boolean> = { true: true, "1": true, yes: true, false: false, "0": false, no: false };
const DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** Same rule as the server: a real UTC date and time, written exactly YYYY-MM-DD HH:MM:SS. */
function validDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
}

/** CSV rows (header first) to an import body. Empty host = the main domain. Any error leaves the body empty of that row. */
export function linksFromCsv(rows: string[][], mainHost: string): { body: ImportBody; errors: LineError[] } {
  const body: ImportBody = { mainHost, domains: [], links: [] };
  const errors: LineError[] = [];
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const at = { slug: col("slug"), dest: col("destination", "url"), host: col("host"), enabled: col("enabled"), start: col("start_date"), end: col("end_date") };
  if (at.slug < 0 || at.dest < 0) {
    errors.push({ line: 1, reason: "The first row must name the columns, with at least slug and destination (or url)" });
    return { body, errors };
  }
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const cell = (k: number) => (k < 0 ? "" : (r[k] ?? "").trim());
    const slug = cell(at.slug), destination = cell(at.dest), host = cell(at.host), enabled = cell(at.enabled).toLowerCase();
    const start = cell(at.start), end = cell(at.end);
    if (!slug) return errors.push({ line, reason: "slug is empty" });
    if (!destination) return errors.push({ line, reason: "destination is empty" });
    if (enabled && !Object.hasOwn(BOOL, enabled)) return errors.push({ line, reason: "enabled must be true, false, 1, 0, yes or no" });
    for (const [name, v] of [["start_date", start], ["end_date", end]] as const)
      if (v && !validDate(v)) return errors.push({ line, reason: `${name} must be YYYY-MM-DD HH:MM:SS (UTC)` });
    body.links.push({ host: host || null, slug, destination, enabled: enabled ? BOOL[enabled]! : true, startDate: start || null, endDate: end || null });
  });
  return { body, errors };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
/** The import shape, checked deeply enough that the server's own check is the only thing left to fail. */
function isImportBody(v: unknown): v is ImportBody {
  if (!isObj(v) || typeof v.mainHost !== "string" || !v.mainHost || !Array.isArray(v.domains) || !Array.isArray(v.links)) return false;
  return (
    v.domains.every((d) => isObj(d) && typeof d.host === "string" && optStr(d.customIndexUrl) && optStr(d.customNotFoundUrl)) &&
    v.links.every((l) => isObj(l) && (l.host === null || typeof l.host === "string") && typeof l.slug === "string" && typeof l.destination === "string" &&
      typeof l.enabled === "boolean" && optStr(l.startDate) && optStr(l.endDate))
  );
}

/** A chosen file to an import body. JSON keeps its own mainHost (the legacy main host); CSV uses this instance's. */
export function parseLinksFile(name: string, text: string, mainHost: string): Parsed {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "csv") return linksFromCsv(parseCsv(text), mainHost);
  if (ext !== "json") return { body: null, errors: [{ line: 0, reason: "Choose a .csv or .json file" }] };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { body: null, errors: [{ line: 0, reason: NOT_AN_EXPORT }] };
  }
  if (!isImportBody(data)) return { body: null, errors: [{ line: 0, reason: NOT_AN_EXPORT }] };
  // Only the known fields go on: nothing else from the file reaches the request.
  return {
    body: {
      mainHost: data.mainHost,
      domains: data.domains.map((d) => ({ host: d.host, customIndexUrl: d.customIndexUrl ?? null, customNotFoundUrl: d.customNotFoundUrl ?? null })),
      links: data.links.map((l) => ({ host: l.host, slug: l.slug, destination: l.destination, enabled: l.enabled, startDate: l.startDate ?? null, endDate: l.endDate ?? null })),
    },
    errors: [],
  };
}
