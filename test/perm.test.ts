import { describe, expect, it } from "vitest";
import { canManageDomain, canUseDomain } from "../src/perm";
import type { DomainRow, UserRow } from "../src/types";

const user = (role: UserRow["role"], status: UserRow["status"] = "active"): UserRow =>
  ({ id: "u1", email: "u@x.dev", name: null, role, status, createdAt: 0 });
const dom = (type: DomainRow["type"], status: DomainRow["status"], owned: boolean): DomainRow => ({
  id: "d1", host: "x.dev", type, status, ownerId: owned ? "u1" : "other",
  bareRedirect: null, notfoundRedirect: null, caseSensitive: false, noindex: false, reservedExtra: [], createdAt: 0,
});

// [role, type, status, isMember, isDomainOwner, canUse]
type Row = [UserRow["role"], DomainRow["type"], DomainRow["status"], boolean, boolean, boolean];
const rows: Row[] = [];
for (const role of ["owner", "member"] as const)
  for (const type of ["main", "shared", "private"] as const)
    for (const status of ["active", "pending", "disabled"] as const)
      for (const member of [false, true])
        for (const owned of [false, true]) {
          const typeOk = type === "main" || (type === "shared" ? member : member || owned);
          const expected = role === "owner" ? true : status === "disabled" ? false : typeOk;
          rows.push([role, type, status, member, owned, expected]);
        }

describe("canUseDomain truth table", () => {
  it.each(rows)("%s / %s / %s / member=%s / owns=%s -> %s", (role, type, status, member, owned, expected) => {
    expect(canUseDomain(user(role), dom(type, status, owned), member)).toBe(expected);
  });

  it("member cannot use a shared domain without a grant", () => {
    expect(canUseDomain(user("member"), dom("shared", "active", false), false)).toBe(false);
  });
  it("member can use their own pending private domain", () => {
    expect(canUseDomain(user("member"), dom("private", "pending", true), false)).toBe(true);
  });
  it.each(["invited", "disabled"] as const)("%s user is denied everywhere, even the owner role", (status) => {
    for (const role of ["owner", "member"] as const)
      for (const type of ["main", "shared", "private"] as const) {
        expect(canUseDomain(user(role, status), dom(type, "active", true), true)).toBe(false);
        expect(canManageDomain(user(role, status), dom(type, "active", true))).toBe(false);
      }
  });
});

describe("canManageDomain", () => {
  it.each(["main", "shared", "private"] as const)("%s: owner and domain owner only", (type) => {
    for (const status of ["active", "pending", "disabled"] as const) {
      expect(canManageDomain(user("owner"), dom(type, status, false))).toBe(true);
      expect(canManageDomain(user("member"), dom(type, status, true))).toBe(true);
      expect(canManageDomain(user("member"), dom(type, status, false))).toBe(false);
    }
  });
});
