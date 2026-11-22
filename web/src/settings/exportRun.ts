import type { Method } from "../api";

type Api = <T>(method: Method, path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export type ExportStart = {
  format: "linkwarren-export"; version: 1; exportedAt: number; run: string; includeAnalytics: boolean; estimatedReads: number;
  tables: { name: string; columns: string[]; rows: number }[]; logo: { type: string; data: string } | null;
};
type Page = { rows: object[]; next: number | null };

/** Workers Free D1 reads per day for the whole account; each exported row is one read. */
export const DAILY_READS = 5_000_000;
/** Above this many estimated reads the UI asks the owner to confirm before paging. */
export const CONFIRM_ABOVE = 1_000_000;

/** Step 1 (audited): the run id, the table list and the row estimate to show before any page is read. */
export const startExport = (api: Api, o: { includeAnalytics: boolean }, signal?: AbortSignal) =>
  api<ExportStart>("POST", "/api/export/start", { includeAnalytics: o.includeAnalytics }, signal);

/** `share` of the daily read budget (0..1+); `confirm` when the UI must ask first. */
export const exportEstimate = (s: Pick<ExportStart, "estimatedReads">) =>
  ({ reads: s.estimatedReads, share: s.estimatedReads / DAILY_READS, confirm: s.estimatedReads > CONFIRM_ABOVE });

/**
 * Step 2 (R11): each table of the run page by page (one request each, inside the Workers Free query limit). Any failed
 * request rejects the whole run. `complete: true` is the last key, so a cut-off file is never valid.
 */
export async function runExport(api: Api, s: ExportStart, onProgress: (p: { table: string; rows: number }) => void, signal?: AbortSignal): Promise<Blob> {
  const tables: Record<string, object[]> = {};
  for (const { name } of s.tables) {
    const rows: object[] = (tables[name] = []);
    let after: number | null = null;
    do {
      const p: Page = await api<Page>("POST", "/api/export/page", { run: s.run, table: name, after }, signal);
      rows.push(...p.rows);
      onProgress({ table: name, rows: rows.length });
      after = p.next;
    } while (after !== null);
  }
  const file = { format: s.format, version: s.version, exportedAt: s.exportedAt, includeAnalytics: s.includeAnalytics, logo: s.logo, tables, complete: true };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

/** `linkwarren-export-<YYYY-MM-DD>.json` (UTC date): fixed characters only. */
export const exportFileName = (d: Date) => `linkwarren-export-${d.toISOString().slice(0, 10)}.json`;

/** Downloads through an object URL (strict CSP: no data: URLs), revoked shortly after the click (an instant revoke can cancel it in some browsers). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
