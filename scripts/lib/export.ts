// Pure helpers shared by the import and audit scripts (and unit-tested from vitest). No Node or Worker APIs.
export type ExportDomain = { host: string; customIndexUrl: string | null; customNotFoundUrl: string | null };
export type ExportLink = {
  host: string | null; slug: string; destination: string; enabled: boolean; startDate: string | null; endDate: string | null;
};
export type Export = { mainHost: string; domains: ExportDomain[]; links: ExportLink[] };

/** Same rule as the Worker's normalizeHost: no port, no trailing dot, lowercase. */
export const normHost = (raw: string): string => raw.trim().replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();

const bad = (m: string): never => { throw new Error(`invalid export: ${m}`); };
const str = (v: unknown, what: string): string => typeof v === "string" ? v : bad(`${what} must be a string`);
const optStr = (v: unknown, what: string): string | null => v === undefined || v === null ? null : str(v, what);

export function parseExport(raw: unknown): Export {
  if (typeof raw !== "object" || raw === null) return bad("not an object");
  const o = raw as Record<string, unknown>;
  const mainHost = normHost(str(o.mainHost, "mainHost"));
  if (!mainHost) bad("mainHost is empty");
  if (!Array.isArray(o.domains)) bad("domains must be an array");
  if (!Array.isArray(o.links)) bad("links must be an array");
  const domains = (o.domains as unknown[]).map((d, i): ExportDomain => {
    const r = (d ?? {}) as Record<string, unknown>;
    return { host: normHost(str(r.host, `domains[${i}].host`)), customIndexUrl: optStr(r.customIndexUrl, `domains[${i}].customIndexUrl`),
      customNotFoundUrl: optStr(r.customNotFoundUrl, `domains[${i}].customNotFoundUrl`) };
  });
  const links = (o.links as unknown[]).map((l, i): ExportLink => {
    const r = (l ?? {}) as Record<string, unknown>;
    if (typeof r.enabled !== "boolean") bad(`links[${i}].enabled must be a boolean`);
    return { host: r.host === null || r.host === undefined ? null : normHost(str(r.host, `links[${i}].host`)),
      slug: str(r.slug, `links[${i}].slug`), destination: str(r.destination, `links[${i}].destination`), enabled: r.enabled as boolean,
      startDate: optStr(r.startDate, `links[${i}].startDate`), endDate: optStr(r.endDate, `links[${i}].endDate`) };
  });
  return { mainHost, domains, links };
}

const hostList = (hosts: string[]): Set<string> => {
  const s = new Set(hosts.map(normHost).filter(Boolean));
  if (s.size === 0) throw new Error("hosts: a non-empty host list is required");
  return s;
};
const linkHost = (e: Export, l: ExportLink) => l.host ?? e.mainHost;

/** Keeps only the listed hosts; links with host null belong to mainHost. */
export function filterHosts(e: Export, hosts: string[]): Export {
  const keep = hostList(hosts);
  return { mainHost: e.mainHost, domains: e.domains.filter((d) => keep.has(d.host)), links: e.links.filter((l) => keep.has(linkHost(e, l))) };
}

/** Every link filterHosts would drop, with its host resolved, for the keep-or-drop audit. */
export function excludedRows(e: Export, hosts: string[]) {
  const keep = hostList(hosts);
  return e.links.filter((l) => !keep.has(linkHost(e, l)))
    .map((l) => ({ host: linkHost(e, l), slug: l.slug, destination: l.destination, enabled: l.enabled, startDate: l.startDate, endDate: l.endDate }));
}

/** RFC 4180 CSV (CRLF). Text cells starting with = + - @ get a leading quote so spreadsheets do not evaluate them. */
export function toCsv(rows: Record<string, string | number | boolean | null>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: string | number | boolean | null): string => {
    let s = v === null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c] ?? null)).join(","))].join("\r\n") + "\r\n";
}

/**
 * Splits links into request-sized chunks. The server decides a new domain's case sensitivity per request, so the first
 * chunk touching a host must hold every case-twin group of that host: those links sort first and may overflow the chunk
 * size. Throws when that forces a chunk above maxChunk (the server cap). Exact duplicate rows are collapsed first: the
 * server skips a repeat only within one request, so a pair split across requests would count twice in a dry run.
 */
export function chunkLinks(e: Export, size: number, maxChunk = 1000): ExportLink[][] {
  const seen = new Set<string>();
  const links = e.links.filter((l) => {
    const k = JSON.stringify([linkHost(e, l), l.slug, l.destination, l.enabled, l.startDate, l.endDate]);
    return !seen.has(k) && !!seen.add(k);
  });
  const groups = new Map<string, Set<string>>();
  for (const l of links) {
    const k = `${linkHost(e, l)}\0${l.slug.toLowerCase()}`;
    groups.set(k, (groups.get(k) ?? new Set()).add(l.slug));
  }
  const twin = (l: ExportLink) => groups.get(`${linkHost(e, l)}\0${l.slug.toLowerCase()}`)!.size > 1;
  const key = (l: ExportLink) => `${linkHost(e, l)}\0${twin(l) ? 0 : 1}\0${l.slug.toLowerCase()}`;
  const sorted = links.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const chunks: ExportLink[][] = [];
  let cur: ExportLink[] = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  for (let i = 0; i < sorted.length;) {
    const host = linkHost(e, sorted[i]!);
    let j = i;
    while (j < sorted.length && linkHost(e, sorted[j]!) === host && twin(sorted[j]!)) j++;
    const twins = sorted.slice(i, j);
    if (twins.length) {
      if (cur.length + twins.length > size) flush();
      cur.push(...twins);
      if (cur.length > maxChunk) throw new Error(`host ${host} has too many case-twin links (${cur.length}) for one request (max ${maxChunk})`);
    }
    i = j;
    for (; i < sorted.length && linkHost(e, sorted[i]!) === host; i++) {
      if (cur.length >= size) flush();
      cur.push(sorted[i]!);
    }
  }
  flush();
  return chunks;
}

/**
 * Request bodies for an import. The server creates a request's domains with the case mode of that request's twins,
 * so each request carries only the domains of its own links (chunkLinks keeps a host's twins in its first chunk,
 * where the domain is then created). Domains without any link follow in one domains-only request.
 */
export function importRequests(e: Export, size: number, maxChunk = 1000): Export[] {
  const reqs = chunkLinks(e, size, maxChunk).map((links): Export => {
    const hosts = new Set(links.map((l) => linkHost(e, l)));
    return { mainHost: e.mainHost, domains: e.domains.filter((d) => hosts.has(d.host)), links };
  });
  const linked = new Set(e.links.map((l) => linkHost(e, l)));
  const bare = e.domains.filter((d) => !linked.has(d.host));
  if (bare.length) reqs.push({ mainHost: e.mainHost, domains: bare, links: [] });
  return reqs;
}
