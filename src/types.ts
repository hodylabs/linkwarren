import { parsePerms, PERMS, type Perm } from "./roles";
import { vcardOfRow, type VCard } from "./vcard";

/** `role` is the coarse kind (owner or member); `roleId` the effective role (a custom one, or the built-in row `role` names). */
export type UserRow = {
  id: string; email: string; name: string | null;
  role: "owner" | "member"; status: "invited" | "active" | "disabled"; createdAt: number;
  roleId: string; roleName: string; perms: readonly Perm[];
};
/** How a session was started: the two own methods or an S14 sign-in provider. */
export type SessionMethod = "email" | "passkey" | "google" | "github" | "oidc";
/** The public side of an app-mode session (never the cookie secret or its hash). */
export type SessionRef = { id: string; createdAt: number };
export type DomainRow = {
  id: string; host: string; type: "main" | "shared" | "private";
  status: "pending" | "active" | "disabled"; ownerId: string;
  bareRedirect: string | null; notfoundRedirect: string | null;
  caseSensitive: boolean; noindex: boolean; reservedExtra: string[]; createdAt: number;
};
/** Route device values: a form factor, a phone OS or a computer OS. A route matches a visitor who has any one of its values. */
export const ROUTE_DEVICES = ["mobile", "tablet", "desktop", "ios", "android", "windows", "macos", "linux", "chromeos"] as const;
export type RouteDevice = (typeof ROUTE_DEVICES)[number];
export type Route = { countries: string[]; devices: RouteDevice[]; url: string };
export type LinkRow = {
  id: string; domainId: string; slug: string; slugKey: string; url: string;
  /** S12: optional label for people (search, the dashboard). Not on the redirect path: a cached (KV) row has none. */
  name?: string | null;
  redirectCode: 301 | 302; startsAt: number | null; expiresAt: number | null; passQuery: boolean;
  /** Worker-only (redirect path and KV); never sent to a client, see toApiLink. */
  passwordHash: string | null; routes: Route[];
  /** Set on a forwarder: the id of the link it forwards to (one hop, never another forwarder). Test by truthiness: cached rows may lack it. */
  forwardTo: string | null;
  /** "vcard": the short link downloads `vcard` as a contact file instead of redirecting (url is VCARD_URL). Cached rows may lack it: test `=== "vcard"`. */
  kind: "url" | "vcard";
  /** Only on a vCard link, read through LINK_SELECT. */
  vcard?: VCard;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number;
};
/** A link row with its card (if any): the columns rowToLink reads. Unqualified links columns stay unambiguous after the join. */
export const LINK_SELECT = "SELECT links.*, vcards.data AS vcard_data, vcards.photo AS vcard_photo FROM links LEFT JOIN vcards ON vcards.link_id = links.id";
/** A link as the API returns it: the password hash is replaced by a flag. */
/** A card as a list shows it: `hasPhoto` instead of the photo (up to 64 KB each); the single-link read has the photo. */
export type ListVCard = Omit<VCard, "photo"> & { hasPhoto: boolean };
export type ApiLink = Omit<LinkRow, "passwordHash" | "vcard"> & { hasPassword: boolean; vcard?: VCard | ListVCard };
export const toApiLink = ({ passwordHash, ...l }: LinkRow): ApiLink => ({ ...l, hasPassword: passwordHash !== null });
/** toApiLink for list answers: a card's photo becomes `hasPhoto`. */
export const toListLink = (l: LinkRow): ApiLink => {
  const a = toApiLink(l);
  if (!l.vcard) return a;
  const { photo, ...rest } = l.vcard;
  return { ...a, vcard: { ...rest, hasPhoto: photo !== null } };
};
export type UserListItem = UserRow & { linkCount: number; agentCount: number; domains: { id: string; host: string; via: "owner" | "member" }[] };
export type AuditItem = {
  id: number; at: number; actorId: string; actorEmail: string | null; actorName: string | null; via: string | null;
  action: string; targetType: string; targetId: string; detail: Record<string, unknown>;
};

type R = Record<string, unknown>;

/** Needs a row selected with USER_COLS and ROLE_JOIN (src/roles.ts); a row without them throws, so a missed join never yields a permissionless user. */
export const rowToUser = (r: R): UserRow => {
  if (typeof r.role_key !== "string") throw new Error("user row without role join");
  const role = r.role as UserRow["role"];
  return {
    id: r.id as string, email: r.email as string, name: r.name as string | null,
    role, status: r.status as UserRow["status"], createdAt: r.created_at as number,
    roleId: r.role_key, roleName: r.role_name as string, perms: role === "owner" ? [...PERMS] : parsePerms(r.role_perms),
  };
};
export const rowToDomain = (r: R): DomainRow => ({
  id: r.id as string, host: r.host as string, type: r.type as DomainRow["type"],
  status: r.status as DomainRow["status"], ownerId: r.owner_id as string,
  bareRedirect: r.bare_redirect as string | null, notfoundRedirect: r.notfound_redirect as string | null,
  caseSensitive: r.case_sensitive === 1, noindex: r.noindex === 1,
  reservedExtra: JSON.parse((r.reserved_extra as string) || "[]"), createdAt: r.created_at as number,
});
export const rowToLink = (r: R): LinkRow => ({
  id: r.id as string, domainId: r.domain_id as string, slug: r.slug as string, slugKey: r.slug_key as string,
  name: (r.name as string | null | undefined) ?? null,
  url: r.url as string, redirectCode: r.redirect_code as 301 | 302,
  startsAt: r.starts_at as number | null, expiresAt: r.expires_at as number | null, passQuery: r.pass_query === 1,
  passwordHash: (r.password_hash as string | null) ?? null, routes: parseRoutes(r.routes),
  forwardTo: (r.forward_to as string | null) ?? null,
  kind: r.kind === "vcard" ? "vcard" : "url",
  ...(r.kind === "vcard" && typeof r.vcard_data === "string" ? { vcard: vcardOfRow(r.vcard_data, r.vcard_photo) } : {}),
  createdBy: r.created_by as string, updatedBy: r.updated_by as string,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});
function parseRoutes(v: unknown): Route[] {
  try {
    const a: unknown = JSON.parse(v as string);
    // Shape filter: a malformed stored element, or a url that is not http(s), tel: or mailto:, is dropped so route picking and withQuery never throw on it.
    const ok = (r: unknown): r is Route => {
      const x = r as Partial<Route> | null;
      return Array.isArray(x?.countries) && Array.isArray(x?.devices) && typeof x?.url === "string"
        && URL.canParse(x.url) && /^(https?|tel|mailto):$/.test(new URL(x.url).protocol);
    };
    return Array.isArray(a) ? a.filter(ok) : [];
  } catch {
    return [];
  }
}

export type CfRow = {
  kind: "outside" | "account" | "manual"; zoneId: string | null; dnsRecordId: string | null; routeId: string | null;
  hostnameId: string | null; dns: "unknown" | "found" | "missing" | "wrong_target";
  ownership: "unknown" | "pending" | "verified" | "failed";
  certificate: "unknown" | "pending" | "issued" | "failed" | "not_covered";
  errors: string[]; lastError: string | null; checkedAt: number | null; securityLevel: string | null; rateLimit: number | null;
  /** Bumped on every sync attempt, failed ones included (checkedAt moves only on success). */
  updatedAt: number;
};
/** What the API shows about a domain's Cloudflare state. `instructions` only for `outside`. */
export type CfView = Pick<CfRow, "kind" | "dns" | "ownership" | "certificate" | "errors" | "lastError" | "checkedAt" | "securityLevel" | "rateLimit"> & {
  instructions: { type: "CNAME"; name: string; target: string; apex: boolean } | null;
  attachOnApproval: boolean;
  /** linkwarren holds a route for this host (an account domain is connected only then). */
  attached: boolean;
};
export const rowToCf = (r: R): CfRow => ({
  kind: r.kind as CfRow["kind"], zoneId: r.zone_id as string | null, dnsRecordId: r.dns_record_id as string | null,
  routeId: r.route_id as string | null, hostnameId: r.hostname_id as string | null, dns: r.dns as CfRow["dns"],
  ownership: r.ownership as CfRow["ownership"], certificate: r.certificate as CfRow["certificate"],
  errors: JSON.parse((r.errors as string) || "[]"), lastError: r.last_error as string | null,
  checkedAt: r.checked_at as number | null, securityLevel: r.security_level as string | null, rateLimit: r.rate_limit as number | null,
  updatedAt: r.updated_at as number,
});

/** What the API shows about a passkey (never the credential id, public key or counter). */
export type PasskeyItem = { id: string; name: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean };

/** One live session of the signed-in person (never the cookie secret or its hash). */
export type SessionItem = { id: string; current: boolean; method: SessionMethod; createdAt: number; lastSeenAt: number; device: string | null; ipPrefix: string | null };

/** A personal API key as the dashboard sees it (never the secret or its hash). `userEmail` only in the owner's all-keys view. */
export type KeyItem = {
  id: string; userId: string; userEmail: string | null; name: string; prefix: string; write: boolean; del: boolean;
  domainIds: string[]; createdAt: number; lastUsedAt: number | null; expiresAt: number;
};
export const rowToKey = (r: R, withEmail = false): KeyItem => ({
  id: r.id as string, userId: r.user_id as string, userEmail: withEmail ? (r.email as string | null) : null,
  name: r.name as string, prefix: r.prefix as string, write: r.can_write === 1, del: r.can_delete === 1,
  domainIds: JSON.parse((r.domain_ids as string) || "[]"), createdAt: r.created_at as number,
  lastUsedAt: r.last_used_at as number | null, expiresAt: r.expires_at as number,
});
