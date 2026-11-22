import { api, ApiError } from "../api";
import { csvCell } from "../analytics/csv";
import { importRequests } from "../../../src/importFormat";
import type { ImportBody } from "./parseLinks";

/** POST /api/import's report (src/api/import.ts). `protected`: password links imported locked, to recreate with a new password. */
export type ImportReport = {
  created: number;
  skipped: number;
  conflicts: { host: string; slug: string; reason: string }[];
  caseSensitiveDomains: string[];
  domainsCreated: string[];
  ignored: { host: string; field: string }[];
  protected: { host: string; slug: string }[];
};
export type ImportRun = { report: ImportReport; failedAt: number | null; error?: string };

/**
 * Request bodies of at most `size` links, the split of src/importFormat.ts: sorted by host and lowercased slug, so
 * slugs that differ only by case share a request; each request carries only its own links' domains (a new domain takes the case
 * mode of that request's twins), and domains without links follow in one last request. Exact duplicate rows are sent once.
 * Throws when one host has more case twins than one request takes.
 */
export const chunkImport = (body: ImportBody, size = 1000): ImportBody[] => importRequests(body, size);

const uniq = <T>(xs: T[], key: (x: T) => string = String) => [...new Map(xs.map((x) => [key(x), x])).values()];
export const emptyReport = (): ImportReport => ({ created: 0, skipped: 0, conflicts: [], caseSensitiveDomains: [], domainsCreated: [], ignored: [], protected: [] });

/**
 * One chunk after another; the first failure stops the run and keeps what the earlier chunks reported. `from` and `report` resume a
 * stopped run at its failed chunk (the server skips what an earlier try already wrote). `onPart` gets 1-based progress.
 */
export async function runImport(chunks: ImportBody[], dry: boolean, opts: { from?: number; report?: ImportReport; onPart?: (part: number, total: number) => void } = {}): Promise<ImportRun> {
  const p = opts.report ?? emptyReport();
  const report: ImportReport = { ...p, conflicts: [...p.conflicts], protected: [...p.protected] };
  for (let i = opts.from ?? 0; i < chunks.length; i++) {
    opts.onPart?.(i + 1, chunks.length);
    let r: ImportReport;
    try {
      r = await api<ImportReport>("POST", dry ? "/api/import?dryRun=1" : "/api/import", chunks[i]);
    } catch (e) {
      return { report, failedAt: i, error: e instanceof ApiError ? e.code : "internal" };
    }
    report.created += r.created;
    report.skipped += r.skipped;
    report.conflicts.push(...r.conflicts);
    report.protected = uniq([...report.protected, ...(r.protected ?? [])], (x) => `${x.host} ${x.slug}`);
    // A dry run creates nothing, so every chunk can name the same new domains again.
    report.caseSensitiveDomains = uniq([...report.caseSensitiveDomains, ...r.caseSensitiveDomains]);
    report.domainsCreated = uniq([...report.domainsCreated, ...r.domainsCreated]);
    report.ignored = uniq([...report.ignored, ...r.ignored], (x) => `${x.host} ${x.field}`);
  }
  return { report, failedAt: null };
}

const csv = (rows: string[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** Every row of a report as CSV (formula cells quoted), for the Download results button. */
export const resultsCsv = (r: ImportReport): string =>
  csv([
    ["host", "slug", "result", "reason"],
    ...r.conflicts.map((c) => [c.host, c.slug, "conflict", c.reason]),
    ...r.protected.map((x) => [x.host, x.slug, "protected", "password"]),
    ...r.ignored.map((x) => [x.host, "", "ignored", x.field]),
  ]);

/** The file's line errors as CSV. */
export const errorsCsv = (errors: { line: number; reason: string }[]): string => csv([["line", "reason"], ...errors.map((e) => [String(e.line), e.reason])]);
