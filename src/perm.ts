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
