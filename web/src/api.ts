import type { AuditItem as ServerAuditItem, CfView, DomainRow, LinkRow, UserListItem, UserRow } from "../../src/types";

export type { CfView };
export type Me = Pick<UserRow, "id" | "email" | "name" | "role">;
export type Link = LinkRow;
export type Domain = DomainRow & { linkCount: number; isMember: boolean; cloudflare?: CfView };
export type UserItem = UserListItem;
export type AuditItem = ServerAuditItem;
export type Page<T> = { items: T[]; next: string | null };
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
  // Programming error, not a user error: only same-origin API paths, never a full URL.
  if (!path.startsWith("/api/")) throw new Error(`api(): path must start with /api/, got ${path}`);
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
