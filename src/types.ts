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
