import { api, ApiError } from "../api";
import type { ImportBody } from "./parseLinks";

/** POST /api/import's report (src/api/import.ts). */
export type ImportReport = {
  created: number;
  skipped: number;
  conflicts: { host: string; slug: string; reason: string }[];
  caseSensitiveDomains: string[];
  domainsCreated: string[];
  ignored: { host: string; field: string }[];
};
export type ImportRun = { report: ImportReport; failedAt: number | null; error?: string };

/**
 * The server takes at most 1,000 links a request. Every chunk carries all domains, so each one is created (or reused) whichever chunk comes first.
 * shortcut: slugs that differ only by case can land in different chunks, so a new domain is made case sensitive only when its twins share a chunk;
 * the CLI importer keeps twins together if that ever matters.
 */
export function chunkImport(body: ImportBody, size = 1000): ImportBody[] {
  if (body.links.length === 0) return [body];
  const out: ImportBody[] = [];
  for (let i = 0; i < body.links.length; i += size) out.push({ mainHost: body.mainHost, domains: body.domains, links: body.links.slice(i, i + size) });
  return out;
}

const uniq = <T>(xs: T[], key: (x: T) => string = String) => [...new Map(xs.map((x) => [key(x), x])).values()];

/** One chunk after another; the first failure stops the run and keeps what the earlier chunks reported. */
export async function runImport(chunks: ImportBody[], dry: boolean): Promise<ImportRun> {
  const report: ImportReport = { created: 0, skipped: 0, conflicts: [], caseSensitiveDomains: [], domainsCreated: [], ignored: [] };
  for (const [i, chunk] of chunks.entries()) {
    let r: ImportReport;
    try {
      r = await api<ImportReport>("POST", dry ? "/api/import?dryRun=1" : "/api/import", chunk);
    } catch (e) {
      return { report, failedAt: i, error: e instanceof ApiError ? e.code : "internal" };
    }
    report.created += r.created;
    report.skipped += r.skipped;
    report.conflicts.push(...r.conflicts);
    // A dry run creates nothing, so every chunk names the same new domains again.
    report.caseSensitiveDomains = uniq([...report.caseSensitiveDomains, ...r.caseSensitiveDomains]);
    report.domainsCreated = uniq([...report.domainsCreated, ...r.domainsCreated]);
    report.ignored = uniq([...report.ignored, ...r.ignored], (x) => `${x.host} ${x.field}`);
  }
  return { report, failedAt: null };
}
