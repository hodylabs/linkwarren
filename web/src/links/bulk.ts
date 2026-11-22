import { api, ApiError, type BulkOp, type BulkResponse, type Link } from "../api";
import { shortUrl } from "./linkView";

/** Ids per request: the server's cap (BULK_MAX). */
export const CHUNK = 50;

/**
 * `whole`: failed ids that carry a whole-request code (an error answer for the request, or `not_run`) rather than their own
 * reason, so the sheet shows that code once. `stop`: the code that ended the run, or the last whole-request code, else null.
 */
type Run = { ok: Map<string, Link | null>; failed: Map<string, string>; whole: Set<string>; stop: string | null };

/**
 * Sends `ids` in sequential requests of up to CHUNK. A password set comes back with `pending` ids (one hash per request) and
 * is sent again until none are left, or until a request makes no progress (the rest then fail `pending`). A whole-request
 * error marks that request's ids with its code; only `conflict` goes on with the next chunk. Abort stops after the request in
 * flight. Ids never sent fail `not_run`, so every id ends in `ok` or `failed`. A dropped connection is `lost_connection`: the
 * request may have been applied, so the caller reloads.
 */
export async function runBulk(body: BulkOp, ids: string[], o: { onProgress(done: number, total: number): void; signal: AbortSignal }): Promise<Run> {
  const ok = new Map<string, Link | null>(), failed = new Map<string, string>(), whole = new Set<string>();
  let stop: string | null = null;
  const total = ids.length;
  const report = () => o.onProgress(ok.size + failed.size, total);
  let stopped = false;
  for (let i = 0; i < ids.length && !stopped; i += CHUNK) {
    let chunk = ids.slice(i, i + CHUNK);
    while (chunk.length && !o.signal.aborted) {
      let res: BulkResponse;
      try {
        // No signal on the request itself: one that reached the server finishes, so its results are known.
        res = await api<BulkResponse>("POST", "/api/links/bulk", { ...body, ids: chunk });
      } catch (e) {
        const raw = e instanceof ApiError ? e.code : "offline";
        // "network": an answer that could not be read (the request may have been applied), like a dropped connection.
        const code = raw === "offline" || raw === "network" ? "lost_connection" : raw;
        for (const id of chunk) (failed.set(id, code), whole.add(id));
        stop = code;
        if (code !== "conflict") stopped = true;
        report();
        break;
      }
      for (const r of res.results) {
        if (r.ok) ok.set(r.id, r.link ?? null);
        else failed.set(r.id, r.error);
      }
      // No link decided: the server made no progress, so stop rather than loop.
      if (res.results.length === 0) for (const id of res.pending) failed.set(id, "pending");
      chunk = res.results.length ? res.pending : [];
      report();
    }
    if (o.signal.aborted) break;
  }
  for (const id of ids) {
    if (ok.has(id) || failed.has(id)) continue;
    failed.set(id, "not_run");
    whole.add(id);
    if (!stopped) stop = "not_run"; // cancelled: nothing else ended the run
  }
  return { ok, failed, whole, stop };
}

/** One short URL per line; links whose domain is unknown are left out. */
export function shortUrls(links: Link[], host: (domainId: string) => string): string {
  return links.flatMap((l) => (host(l.domainId) ? [shortUrl(host(l.domainId), l.slug)] : [])).join("\n");
}

const COLUMNS = ["short_url", "destination", "domain", "slug", "status", "redirect_code", "pass_query", "has_password", "starts_at", "expires_at", "routes", "forwards_to", "created_by", "created_at"];

/** Formula guard (= + - @ after optional leading whitespace, or a leading tab or CR, gets a quote), then RFC 4180 quoting. */
function cell(v: string): string {
  const s = /^\s*[=+\-@]|^[\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const iso = (sec: number | null) => (sec === null ? "" : new Date(sec * 1000).toISOString());

function status(l: Link, now: number): string {
  if (l.forwardTo) return "forwards";
  if (l.startsAt !== null && l.startsAt > now) return "scheduled";
  if (l.expiresAt !== null && l.expiresAt <= now) return "expired";
  return "active";
}

/** CSV of the given links: UTF-8 BOM, CRLF, only fields the API returns (has_password, never a hash). */
export function toCsv(links: Link[], host: (domainId: string) => string, people: (userId: string) => string): string {
  const now = Math.floor(Date.now() / 1000);
  const rows = links.map((l) => [
    host(l.domainId) ? shortUrl(host(l.domainId), l.slug) : "", l.url, host(l.domainId), l.slug, status(l, now), String(l.redirectCode), String(l.passQuery), String(l.hasPassword),
    iso(l.startsAt), iso(l.expiresAt), l.routes.length ? JSON.stringify(l.routes) : "", l.forwardTo ? l.url : "", people(l.createdBy), iso(l.createdAt),
  ]);
  return "\uFEFF" + [COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Saves `text` as a file through a Blob URL (no data: URL, nothing inline: the CSP stays strict). */
export function downloadCsv(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const csvName = (d = new Date()): string => `linkwarren-links-${d.toISOString().slice(0, 10)}.csv`;
