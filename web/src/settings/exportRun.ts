import type { Method } from "../api";

type Api = <T>(method: Method, path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type Start = { format: "linkwarren-export"; version: 1; exportedAt: number; tables: { name: string; columns: string[] }[]; logo: { type: string; data: string } | null };
type Page = { rows: object[]; next: number | null };

/**
 * The full export (R11): one audited start, then each table page by page (one request each, inside the Workers Free query
 * limit). Any failed request rejects the whole run. `complete: true` is the last key, so a cut-off file is never valid.
 */
export async function runExport(api: Api, onProgress: (p: { table: string; rows: number }) => void, signal?: AbortSignal): Promise<Blob> {
  const s = await api<Start>("POST", "/api/export/start", {}, signal);
  const tables: Record<string, object[]> = {};
  for (const { name } of s.tables) {
    const rows: object[] = (tables[name] = []);
    let after: number | null = null;
    do {
      const p: Page = await api<Page>("POST", "/api/export/page", { table: name, after }, signal);
      rows.push(...p.rows);
      onProgress({ table: name, rows: rows.length });
      after = p.next;
    } while (after !== null);
  }
  const file = { format: s.format, version: s.version, exportedAt: s.exportedAt, logo: s.logo, tables, complete: true };
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
