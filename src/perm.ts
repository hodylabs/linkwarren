import { can } from "./roles";
import type { DomainRow, UserRow } from "./types";

/** Domain administration (S8 R8): an owner or a domains.manage holder on every domain, anyone on a domain they own (baseline). Never widens canUseDomain. */
export function canManageDomain(user: UserRow, domain: DomainRow): boolean {
  if (user.status !== "active") return false;
  return can(user, "domains.manage") || domain.ownerId === user.id;
}

/** `only` (a grant's domain restriction) narrows, never widens: a domain outside it is refused, for the owner too. */
/** `only` is required so a forgotten restriction is a type error; the dashboard passes its grant's null. */
export function canUseDomain(user: UserRow, domain: DomainRow, isMember: boolean, only: readonly string[] | null): boolean {
  if (user.status !== "active") return false;
  if (only && !only.includes(domain.id)) return false;
  if (user.role === "owner") return true;
  if (domain.status === "disabled") return false;
  switch (domain.type) {
    case "main": return true;
    case "shared": return isMember;
    case "private": return isMember || domain.ownerId === user.id;
    default: return false;
  }
}

/**
 * SQL twin of canUseDomain: selects the ids of every domain the user (one bind: user id) can use.
 * Keep the two in step; test/perm.test.ts checks they agree on a full matrix.
 */
export const usableDomainsSql = `SELECT d.id FROM domains d JOIN users u ON u.id = ?
  WHERE u.status = 'active' AND (u.role = 'owner' OR (d.status != 'disabled' AND (
    d.type = 'main'
    OR (d.type IN ('shared', 'private') AND EXISTS (SELECT 1 FROM domain_members m WHERE m.domain_id = d.id AND m.user_id = u.id))
    OR (d.type = 'private' AND d.owner_id = u.id))))`;

/** usableDomainsSql narrowed to a grant's domains. Binds: user id, JSON array of domain ids. */
export const usableDomainsSqlOnly = `${usableDomainsSql}
  AND d.id IN (SELECT value FROM json_each(?))`;

/** The usable-domains subquery for a grant: the plain one when unrestricted. */
export const usableDomains = (userId: string, only: readonly string[] | null): { sql: string; binds: unknown[] } =>
  only ? { sql: usableDomainsSqlOnly, binds: [userId, JSON.stringify(only)] } : { sql: usableDomainsSql, binds: [userId] };
