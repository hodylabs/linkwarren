import { normHost, parseExport, type Export, type ExportLink } from "../../../src/importFormat";

/** The POST /api/import body (src/importFormat.ts), shared with the server and any external importer. */
export type ImportLink = ExportLink;
export type ImportBody = Export;
/** `line` counts the header as 1; 0 is the whole file. */
export type LineError = { line: number; reason: string };
export type Parsed = { body: ImportBody | null; errors: LineError[] };

export const NOT_AN_EXPORT = "This JSON is not a linkwarren import file";

/** RFC 4180: quoted fields may hold commas, line breaks and "" for a quote. CRLF or LF; a leading BOM is dropped; blank lines are skipped. */
export const parseCsv = (text: string): string[][] => parseCsvLines(text).rows;

/** parseCsv plus each row's first line in the file (1-based), counting blank lines and line breaks inside quotes. */
export function parseCsvLines(text: string): { rows: string[][]; lines: number[] } {
  const s = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1, start = 1;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
      lines.push(start);
    }
    row = [];
    field = "";
  };
  const newline = () => {
    endRow();
    start = ++line;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === "\n") line++;
      if (ch !== '"') field += ch;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") newline();
    else if (ch === "\r") { if (s[i + 1] !== "\n") newline(); }
    else field += ch;
  }
  if (field !== "" || row.length) endRow();
  return { rows, lines };
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
export function linksFromCsv(rows: string[][], mainHost: string, lines?: number[]): { body: ImportBody; errors: LineError[] } {
  const body: ImportBody = { mainHost: normHost(mainHost), domains: [], links: [] };
  const errors: LineError[] = [];
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const at = { slug: col("slug"), dest: col("destination", "url"), host: col("host"), enabled: col("enabled"), start: col("start_date"), end: col("end_date"), kind: col("kind") };
  if (at.slug < 0 || at.dest < 0) {
    errors.push({ line: lines?.[0] ?? 1, reason: "The first row must name the columns, with at least slug and destination (or url)" });
    return { body, errors };
  }
  rows.slice(1).forEach((r, i) => {
    const line = lines?.[i + 1] ?? i + 2;
    const cell = (k: number) => (k < 0 ? "" : (r[k] ?? "").trim());
    const slug = cell(at.slug), destination = cell(at.dest), host = cell(at.host), enabled = cell(at.enabled).toLowerCase();
    const start = cell(at.start), end = cell(at.end);
    if (!slug) return errors.push({ line, reason: "slug is empty" });
    // A CSV row has no card fields: a contact card comes back only through a JSON import with its vcard.
    if (cell(at.kind).toLowerCase() === "vcard") return errors.push({ line, reason: "contact cards cannot be imported from CSV; use a JSON import with the card's vcard fields" });
    if (!destination) return errors.push({ line, reason: "destination is empty" });
    if (enabled && !Object.hasOwn(BOOL, enabled)) return errors.push({ line, reason: "enabled must be true, false, 1, 0, yes or no" });
    for (const [name, v] of [["start_date", start], ["end_date", end]] as const)
      if (v && !validDate(v)) return errors.push({ line, reason: `${name} must be YYYY-MM-DD HH:MM:SS (UTC)` });
    body.links.push({ host: host ? normHost(host) : null, slug, destination, enabled: enabled ? BOOL[enabled]! : true, startDate: start || null, endDate: end || null });
  });
  return { body, errors };
}

/** A chosen file to an import body. JSON keeps its own mainHost (the source's main host); CSV uses this instance's. */
export function parseLinksFile(name: string, text: string, mainHost: string): Parsed {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "csv") {
    const { rows, lines } = parseCsvLines(text);
    return linksFromCsv(rows, mainHost, lines);
  }
  if (ext !== "json") return { body: null, errors: [{ line: 0, reason: "Choose a .csv or .json file" }] };
  // The shared format parser: the same checks, hosts normalized, only known fields kept (protected included).
  try {
    return { body: parseExport(JSON.parse(text.replace(/^\uFEFF/, ""))), errors: [] };
  } catch {
    return { body: null, errors: [{ line: 0, reason: NOT_AN_EXPORT }] };
  }
}
