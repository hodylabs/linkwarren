import type { Perm } from "../../src/roles";
import type { AuditItem as ServerAuditItem, ApiLink, CfView, DomainRow, KeyItem, UserListItem, UserRow } from "../../src/types";
import { withBase } from "./base";

export type { CfView, KeyItem };
/** One item of GET /api/agents/connections (src/api/agents.ts); `userEmail` only in the owner's ?all=1 view of someone else's. */
export type ConnectionItem = {
  id: string; userId: string; userEmail: string | null; clientName: string; redirectHost: string;
  write: boolean; del: boolean; createdAt: number; lastUsedAt: number | null; calls7d: number;
};
/** `authMode` and `passkeys` come from /api/me; optional so a Me built without them reads as access mode. */
/** GET /api/agents/mcp: whether agent connections are on, and whether the deploy config locks them off. */
export type McpState = { on: boolean; locked: boolean };
export type Me = Pick<UserRow, "id" | "email" | "name" | "role" | "roleId" | "roleName" | "perms"> & { authMode?: "app" | "access"; passkeys?: number };
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
/** `canUse` only in a non-owner domain manager's list (S8 R8): false = administer only. Missing means usable. */
export type Domain = DomainRow & { linkCount: number; isMember: boolean; cloudflare?: CfView; canUse?: boolean };
export type UserItem = UserListItem;
/** One item of GET /api/roles (src/api/roles.ts `RoleItem`): Owner first, Member second, then custom roles by name. Owner's perms are all. */
export type RoleItem = { id: string; name: string; perms: Perm[]; builtin: "owner" | "member" | null; people: number };
/** POST /api/users/invite and /api/users/:id/resend (src/api/invites.ts): the invite stands whether or not the mail went out. */
export type InviteResult = { emailed: boolean; emailReason?: "not_configured" | "rejected" | "network" | "settings" | "too_many" };
export type AuditItem = ServerAuditItem;
export type Page<T> = { items: T[]; next: string | null };
type Count = { value: string; clicks: number };
/** GET /api/analytics. Same shape as the server's report (src/analytics.ts). */
export type AnalyticsReport = {
  from: string; to: string; unit: "day" | "hour"; live: "ok" | "off" | "unavailable"; truncated: boolean;
  totals: { clicks: number; qr: number; typed: number; bots: number; visitors: number | null; prevClicks: number | null };
  series: { bucket: string; qr: number; typed: number }[];
  links: { linkId: string; domainId: string; host: string; slug: string; clicks: number; name?: string }[];
  domains: { domainId: string; host: string; clicks: number }[];
  countries: Count[]; devices: Count[]; referrers: Count[];
  /** Only on a per-link report (`?link=`). */
  link?: { linkId: string; host: string; slug: string; name?: string | null };
  /** S13 R1: set when breakdown filters cut a range reaching past the 90-day window; the report covers this UTC day on. */
  filteredFrom?: string;
};
/** One print of a QR code (S13): `value` is its code ("" for a plain `?lw=qr` scan), `label` its name, null when unlabelled. */
export type PrintCount = Count & { label: string | null };
/** GET /api/analytics/detail (src/analytics.ts DetailReport): from Analytics Engine only, `from`..`to` are the UTC days covered. */
export type DetailReport = {
  live: "ok" | "off" | "unavailable"; from: string; to: string;
  os: Count[]; browsers: Count[]; languages: Count[]; places: Count[];
  /** hours[weekday][hour], Monday first, in the time zone sent. */
  hours: number[][];
  /** S13, optional so a server without them still reads: prints and the UTM tags. */
  prints?: PrintCount[]; utmSources?: Count[]; utmMediums?: Count[]; utmCampaigns?: Count[];
  filteredFrom?: string;
  /** Some print or UTM lists were left out: the view was too big for one answer. */
  cut?: true;
};
/** One item of GET /api/analytics/recent (S13): the last 50 human clicks of the last 24 hours, newest first. No IP or user agent. */
export type RecentClick = {
  at: string; linkId: string; host: string; slug: string; country: string; place: string; device: string; os: string; browser: string;
  language: string; source: "qr" | "typed"; print: string; printLabel: string | null; referrer: string;
  utmSource: string; utmMedium: string; utmCampaign: string;
};
export type RecentReport = { items: RecentClick[]; live: "ok" | "off" | "unavailable" };
/** GET and PUT /api/account/digest: the weekly email opt-in. */
export type DigestPrefs = { enabled: boolean; tz: string | null; emailReady: boolean };
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
/** Called on every API answer that means the session is gone (a login redirect, a non-JSON 200, or 401). Returns an unsubscribe. */
export function onSignedOut(fn: () => void): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

function fail(status: number, code: string, data?: unknown): never {
  if (code === "network" || status === 401) signedOutListeners.forEach((fn) => fn());
  throw new ApiError(status, code, data);
}

/**
 * Same-origin JSON call. Redirects are never followed, so an expired Access session (a redirect to its login page) is told
 * apart from a dropped connection: the redirect is status 0 / "network" (signed out), a fetch that throws is 0 / "offline".
 */
export async function api<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // Programming error, not a user error: only same-origin API and sign-in paths, never a full URL.
  if (!/^\/(api|auth)\//.test(path)) throw new Error(`api(): path must start with /api/ or /auth/, got ${path}`);
  const init: RequestInit = { method, credentials: "same-origin", redirect: "manual", signal };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(withBase(path), init);
  } catch (e) {
    if (signal?.aborted) throw e; // the caller cancelled: not a sign-in problem
    fail(0, "offline");
  }
  // The API never redirects; Access does when the session is gone.
  if (res.type === "opaqueredirect") fail(0, "network");
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

/** S13: GET and PUT /api/account/alerts, the link alert emails opt-in (src/api/account.ts). */
export type AlertPrefs = { enabled: boolean; quiet: boolean; spike: boolean; emailReady: boolean; analyticsReady: boolean };
/** S13: one active share page (GET /api/shares, src/api/shares.ts). Never carries the token. */
export type ShareItem = { id: string; scope: "link" | "domain"; scopeId: string; createdAt: number; createdBy: string };
/** POST /api/shares: the only answer that carries the page URL. */
export type NewShare = ShareItem & { url: string };
/** S13: one labelled QR print of a link (GET /api/links/:id/qr-labels). Its QR content is `<shortUrl>?lw=qr.<code>`. */
export type QrLabel = { id: string; code: string; label: string; createdAt: number };
/** S14: a single sign-on provider id, as in /auth/sso/:provider and the settings routes. */
export type SsoProvider = "google" | "github" | "oidc";
export const SSO_PROVIDERS: readonly SsoProvider[] = ["google", "github", "oidc"];
/** POST /auth/sso/providers: the enabled providers only. `label` is the button text the owner set (OIDC). */
export type SsoProviderItem = { id: SsoProvider; label: string };
/** One row of the email domains list: `joinRoleId` null means no auto-join, and it is never the owner role. */
export type EmailDomain = { domain: string; joinRoleId: string | null; enforceSso: boolean };
/** GET and PUT /api/settings/sso (perm settings, app mode). Never carries a client secret, only whether one is set. */
export type SsoSettings = {
  redirectUris: Record<SsoProvider, string>;
  google: { enabled: boolean; clientId: string; secretSet: boolean };
  github: { enabled: boolean; clientId: string; secretSet: boolean };
  oidc: { enabled: boolean; issuer: string; clientId: string; label: string; secretSet: boolean };
  emailDomains: EmailDomain[];
  secretsReady: boolean;
};
/** PUT /api/settings/sso/:provider. An empty `clientSecret` clears it; leaving it out keeps it. */
export type SsoPatch = { enabled?: boolean; clientId?: string; clientSecret?: string; issuer?: string; label?: string };
/** One item of GET /api/account/identities. */
export type IdentityItem = { provider: SsoProvider; email: string; createdAt: number; lastUsedAt: number | null };
/** Plain provider names for lists and the audit log. */
export const PROVIDER_NAME: Record<SsoProvider, string> = { google: "Google", github: "GitHub", oidc: "Single sign-on" };
/** The provider's name, or null for an id this build does not know. */
export const providerName = (p: unknown): string | null => (typeof p === "string" && Object.hasOwn(PROVIDER_NAME, p) ? PROVIDER_NAME[p as SsoProvider] : null);
