import type { AuditItem as ServerAuditItem, ApiLink, CfView, DomainRow, KeyItem, UserListItem, UserRow } from "../../src/types";

export type { CfView, KeyItem };
/** One item of GET /api/agents/connections (src/api/agents.ts); `userEmail` only in the owner's ?all=1 view of someone else's. */
export type ConnectionItem = {
  id: string; userId: string; userEmail: string | null; clientName: string; redirectHost: string;
  write: boolean; del: boolean; createdAt: number; lastUsedAt: number | null; calls7d: number;
};
/** `authMode` and `passkeys` come from /api/me; optional so a Me built without them reads as access mode. */
export type Me = Pick<UserRow, "id" | "email" | "name" | "role"> & { authMode?: "app" | "access"; passkeys?: number };
export type { PasskeyItem, Route, RouteDevice, SessionItem } from "../../src/types";
export type Link = ApiLink;
/** One bulk action as POST /api/links/bulk takes it (src/api/bulk.ts), without the ids. Absent fields are kept. */
export type BulkOp =
  | { action: "delete" }
  | { action: "schedule"; startsAt?: number | null; expiresAt?: number | null; endNow?: true }
  | { action: "redirect"; redirectCode?: 301 | 302; passQuery?: boolean }
  | { action: "password"; password: string | null }
  | { action: "move"; domainId: string; oldAddress: "forward" | "copy" };
export type BulkBody = BulkOp & { ids: string[] };
/** Per link; a copy answers with the new link under the source id, a delete with no link. */
export type BulkResult = { id: string; ok: true; link?: Link } | { id: string; ok: false; error: string };
/** `pending`: accepted password links not hashed yet (one per request), to send again. */
export type BulkResponse = { results: BulkResult[]; pending: string[] };
export type Domain = DomainRow & { linkCount: number; isMember: boolean; cloudflare?: CfView };
export type UserItem = UserListItem;
export type AuditItem = ServerAuditItem;
export type Page<T> = { items: T[]; next: string | null };
type Count = { value: string; clicks: number };
/** GET /api/analytics. Same shape as the server's report (src/analytics.ts). */
export type AnalyticsReport = {
  from: string; to: string; unit: "day" | "hour"; live: "ok" | "off" | "unavailable"; truncated: boolean;
  totals: { clicks: number; qr: number; typed: number; bots: number; visitors: number | null; prevClicks: number | null };
  series: { bucket: string; qr: number; typed: number }[];
  links: { linkId: string; domainId: string; host: string; slug: string; clicks: number }[];
  domains: { domainId: string; host: string; clicks: number }[];
  countries: Count[]; devices: Count[]; referrers: Count[];
};
/** One item of GET /api/analytics/links: `days` are today-6..today (UTC), oldest first. */
export type LinkStats = { linkId: string; days: number[]; clicks: number; qr: number; topCountry: string | null };
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The whole error answer, for codes that carry more (approve's 409 not_verified has `cloudflare`). */
  readonly data: unknown;
  constructor(status: number, code: string, data?: unknown) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const signedOutListeners = new Set<() => void>();
/** Called on every API answer that means the Access session is gone (status 0 or 401). Returns an unsubscribe. */
export function onSignedOut(fn: () => void): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

function fail(status: number, code: string, data?: unknown): never {
  if (status === 0 || status === 401) signedOutListeners.forEach((fn) => fn());
  throw new ApiError(status, code, data);
}

/** Same-origin JSON call. Status 0 / "network" when fetch throws, which is what an expired Access session (login redirect) looks like. */
export async function api<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // Programming error, not a user error: only same-origin API and sign-in paths, never a full URL.
  if (!/^\/(api|auth)\//.test(path)) throw new Error(`api(): path must start with /api/ or /auth/, got ${path}`);
  const init: RequestInit = { method, credentials: "same-origin", signal };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (signal?.aborted) throw e; // the caller cancelled: not a sign-in problem
    fail(0, "network");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch((e: unknown) => {
    if (signal?.aborted) throw e; // cancelled while reading the body: not a sign-in problem either
    return undefined;
  });
  if (!res.ok) {
    const code = (data as { error?: unknown } | undefined)?.error;
    fail(res.status, typeof code === "string" ? code : `http_${res.status}`, data);
  }
  // An OK answer that is not JSON is not the API (for example a sign-in page served in its place).
  if (data === undefined) fail(0, "network");
  return data as T;
}
