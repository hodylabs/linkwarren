export type UserRow = {
  id: string; email: string; name: string | null;
  role: "owner" | "member"; status: "invited" | "active" | "disabled"; createdAt: number;
};
export type DomainRow = {
  id: string; host: string; type: "main" | "shared" | "private";
  status: "pending" | "active" | "disabled"; ownerId: string;
  bareRedirect: string | null; notfoundRedirect: string | null;
  caseSensitive: boolean; noindex: boolean; reservedExtra: string[]; createdAt: number;
};
export type LinkRow = {
  id: string; domainId: string; slug: string; slugKey: string; url: string;
  redirectCode: 301 | 302; startsAt: number | null; expiresAt: number | null; passQuery: boolean;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number;
};
export type UserListItem = UserRow & { linkCount: number; domains: { id: string; host: string; via: "owner" | "member" }[] };
export type AuditItem = {
  id: number; at: number; actorId: string; actorEmail: string | null; actorName: string | null; via: string | null;
  action: string; targetType: string; targetId: string; detail: Record<string, unknown>;
};

type R = Record<string, unknown>;

export const rowToUser = (r: R): UserRow => ({
  id: r.id as string, email: r.email as string, name: r.name as string | null,
  role: r.role as UserRow["role"], status: r.status as UserRow["status"], createdAt: r.created_at as number,
});
export const rowToDomain = (r: R): DomainRow => ({
  id: r.id as string, host: r.host as string, type: r.type as DomainRow["type"],
  status: r.status as DomainRow["status"], ownerId: r.owner_id as string,
  bareRedirect: r.bare_redirect as string | null, notfoundRedirect: r.notfound_redirect as string | null,
  caseSensitive: r.case_sensitive === 1, noindex: r.noindex === 1,
  reservedExtra: JSON.parse((r.reserved_extra as string) || "[]"), createdAt: r.created_at as number,
});
export const rowToLink = (r: R): LinkRow => ({
  id: r.id as string, domainId: r.domain_id as string, slug: r.slug as string, slugKey: r.slug_key as string,
  url: r.url as string, redirectCode: r.redirect_code as 301 | 302,
  startsAt: r.starts_at as number | null, expiresAt: r.expires_at as number | null, passQuery: r.pass_query === 1,
  createdBy: r.created_by as string, updatedBy: r.updated_by as string,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});

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
};
export const rowToCf = (r: R): CfRow => ({
  kind: r.kind as CfRow["kind"], zoneId: r.zone_id as string | null, dnsRecordId: r.dns_record_id as string | null,
  routeId: r.route_id as string | null, hostnameId: r.hostname_id as string | null, dns: r.dns as CfRow["dns"],
  ownership: r.ownership as CfRow["ownership"], certificate: r.certificate as CfRow["certificate"],
  errors: JSON.parse((r.errors as string) || "[]"), lastError: r.last_error as string | null,
  checkedAt: r.checked_at as number | null, securityLevel: r.security_level as string | null, rateLimit: r.rate_limit as number | null,
  updatedAt: r.updated_at as number,
});
