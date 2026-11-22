import { describe, expect, it } from "vitest";
import { PERMS as SERVER_PERMS } from "../../src/roles";
import type { Domain, Me } from "./api";
import { can, canSee, canUseDomain, isOwner, mayOpen, PERMS } from "./perms";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "./test/roles";

const base = { id: "u1", email: "a@example.com", name: null };
const owner: Me = { ...base, role: "owner", ...OWNER_ROLE, perms: [] }; // stored perms never matter for an owner
const member: Me = { ...base, role: "member", ...MEMBER_ROLE };
const helper: Me = { ...base, ...customRole(["settings", "audit"]) };

describe("perms", () => {
  it("the web copy of the permission list equals the server's, in order", () => {
    expect([...PERMS]).toEqual([...SERVER_PERMS]);
  });

  it("can: an owner has every key, anyone else exactly their role's", () => {
    for (const p of PERMS) expect(can(owner, p)).toBe(true);
    expect(PERMS.filter((p) => can(member, p))).toEqual(MEMBER_ROLE.perms);
    expect(PERMS.filter((p) => can(helper, p))).toEqual(["settings", "audit"]);
    expect(isOwner(owner)).toBe(true);
    expect(isOwner(helper)).toBe(false);
  });

  it("canSee: People needs people.manage or audit, Settings needs settings, the rest is baseline", () => {
    expect(canSee(member, "people")).toBe(false);
    expect(canSee(member, "settings")).toBe(false);
    expect(canSee(member, "agents")).toBe(true);
    expect(canSee(helper, "people")).toBe(true);
    expect(canSee(helper, "settings")).toBe(true);
    expect(canSee({ ...base, ...customRole(["people.manage"]) }, "people")).toBe(true);
  });

  it("mayOpen: create sheets follow their permission", () => {
    expect(mayOpen(member, { kind: "newLink" })).toBe(true);
    expect(mayOpen(member, { kind: "invite" })).toBe(false);
    expect(mayOpen(helper, { kind: "newLink" })).toBe(false);
    expect(mayOpen(helper, { kind: "newKey" })).toBe(false);
    expect(mayOpen(helper, { kind: "addDomain" })).toBe(false);
    expect(mayOpen({ ...base, ...customRole(["domains.manage"]) }, { kind: "addDomain" })).toBe(true);
    expect(mayOpen(helper, { kind: "palette" })).toBe(true);
    expect(mayOpen(owner, { kind: "person", id: "x" })).toBe(true);
  });

  it("canUseDomain: a domain marked canUse false is never usable, a missing canUse means usable", () => {
    const d = { id: "d1", type: "shared", status: "active", ownerId: "uo", isMember: false } as Domain;
    expect(canUseDomain(owner, d)).toBe(true);
    expect(canUseDomain(owner, { ...d, canUse: false })).toBe(false);
    expect(canUseDomain(member, d)).toBe(false);
    expect(canUseDomain(member, { ...d, isMember: true })).toBe(true);
    expect(canUseDomain(member, { ...d, type: "main" })).toBe(true);
    expect(canUseDomain(member, { ...d, type: "main", status: "disabled" })).toBe(false);
  });
});
