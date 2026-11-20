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
  it("member on someone else's private domain without membership is denied", () => {
    expect(canUseDomain(user("member"), dom("private", "active", false), false)).toBe(false);
  });
  it("member with membership on a disabled domain is denied", () => {
    expect(canUseDomain(user("member"), dom("shared", "disabled", false), true)).toBe(false);
    expect(canUseDomain(user("member"), dom("private", "disabled", false), true)).toBe(false);
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

describe("usableDomainsSql mirrors canUseDomain", () => {
  it("returns exactly the domains canUseDomain allows, for every user status and role", async () => {
    const { env } = await import("cloudflare:workers");
    const { usableDomainsSql } = await import("../src/perm");
    const { rowToDomain, rowToUser } = await import("../src/types");
    const db = env.DB;
    await db.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => db.prepare(`DELETE FROM ${t}`)));
    const users: [string, string, string][] = [];
    for (const role of ["owner", "member"]) for (const status of ["active", "invited", "disabled"]) users.push([`${role}-${status}`, role, status]);
    await db.batch(users.map(([id, role, status]) => db.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,0)").bind(id, `${id}@x.dev`, role, status)));
    const stmts: D1PreparedStatement[] = [];
    let n = 0;
    for (const type of ["main", "shared", "private"]) for (const status of ["active", "pending", "disabled"])
      for (const owner of ["member-active", "owner-active"]) for (const member of [false, true]) {
        const id = `d${n++}`;
        stmts.push(db.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,0)").bind(id, `${id}.test`, type, status, owner));
        if (member) for (const [u] of users) stmts.push(db.prepare("INSERT INTO domain_members (domain_id,user_id) VALUES (?,?)").bind(id, u));
      }
    await db.batch(stmts);
    const domains = (await db.prepare("SELECT * FROM domains").all()).results.map(rowToDomain);
    for (const [uid] of users) {
      const u = rowToUser((await db.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first())!);
      const mem = new Set((await db.prepare("SELECT domain_id FROM domain_members WHERE user_id = ?").bind(uid).all<{ domain_id: string }>()).results.map((r) => r.domain_id));
      const expected = domains.filter((d) => canUseDomain(u, d, mem.has(d.id))).map((d) => d.id).sort();
      const got = (await db.prepare(`SELECT id FROM domains WHERE id IN (${usableDomainsSql})`).bind(uid).all<{ id: string }>()).results.map((r) => r.id).sort();
      expect([uid, got]).toEqual([uid, expected]);
    }
  });
});
