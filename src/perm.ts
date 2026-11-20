import type { DomainRow, UserRow } from "./types";

export function canManageDomain(user: UserRow, domain: DomainRow): boolean {
  if (user.status !== "active") return false;
  return user.role === "owner" || domain.ownerId === user.id;
}

export function canUseDomain(user: UserRow, domain: DomainRow, isMember: boolean): boolean {
  if (user.status !== "active") return false;
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
