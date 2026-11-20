import { describe, expect, it } from "vitest";
import type { Domain, Me, UserItem } from "../api";
import { canManage, domainDiff, draftOf, ownerLabel, parseReserved, sharedWith, statusTag } from "./domainView";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const dom = (o: Partial<Domain> = {}): Domain => ({
  id: "d1", host: "go.test", type: "shared", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false, ...o,
});

describe("parseReserved", () => {
  it("splits on commas and whitespace and keeps case", () => {
    expect(parseReserved("promo, Sale  x")).toEqual({ ok: true, list: ["promo", "Sale", "x"] });
  });
  it("dedupes case-insensitively", () => {
    expect(parseReserved("promo, PROMO")).toEqual({ ok: true, list: ["promo"] });
  });
  it("rejects a bad slug and more than 100", () => {
    expect(parseReserved("a/b")).toEqual({ ok: false, bad: "a/b" });
    expect(parseReserved(Array.from({ length: 101 }, (_, i) => `s${i}`).join(" ")).ok).toBe(false);
    expect(parseReserved("")).toEqual({ ok: true, list: [] });
  });
});

describe("canManage", () => {
  it("owner, or the domain's own owner", () => {
    expect(canManage(owner, dom({ ownerId: "x" }))).toBe(true);
    expect(canManage(member, dom({ ownerId: "um" }))).toBe(true);
    expect(canManage(member, dom({ ownerId: "uo" }))).toBe(false);
  });
});

describe("statusTag", () => {
  it("labels by viewer", () => {
    expect(statusTag(dom(), true)).toEqual({ label: "Active", tone: "ok" });
    expect(statusTag(dom({ status: "pending" }), true)).toEqual({ label: "Needs your approval", tone: "wait" });
    expect(statusTag(dom({ status: "pending" }), false)).toEqual({ label: "Waiting for approval", tone: "wait" });
    expect(statusTag(dom({ status: "disabled" }), false)).toEqual({ label: "Disabled", tone: "off" });
  });
});

describe("ownerLabel and sharedWith", () => {
  const users = [{ id: "u9", email: "d@example.com", name: "Dana", domains: [{ id: "d1", host: "go.test", via: "member" }] }] as unknown as UserItem[];
  it("owner view names people; member view is You or Someone else and has no column", () => {
    expect(ownerLabel(dom({ ownerId: "u9" }), owner, users)).toBe("Dana");
    expect(ownerLabel(dom(), owner, users)).toBe("You");
    expect(ownerLabel(dom({ ownerId: "u9" }), member, null)).toBe("Someone else");
    expect(sharedWith(dom(), users, owner)).toBe("Dana");
    expect(sharedWith(dom(), [], owner)).toBe("Only the owner");
    expect(sharedWith(dom({ type: "main" }), users, owner)).toBe("Everyone");
    expect(sharedWith(dom(), users, member)).toBeNull();
  });
});

describe("domainDiff", () => {
  it("sends only changed keys, empty clears to null", () => {
    const d = dom({ bareRedirect: "https://a.com/" });
    expect(domainDiff(d, draftOf(d), []).body).toEqual({});
    expect(domainDiff(d, { ...draftOf(d), bare: "" }, []).body).toEqual({ bareRedirect: null });
    expect(domainDiff(d, { ...draftOf(d), noindex: false, reserved: "a" }, []).body).toEqual({ noindex: false, reservedExtra: ["a"] });
  });
  it("reports bad redirects and reserved per field", () => {
    const d = dom();
    const r = domainDiff(d, { ...draftOf(d), bare: "ftp://x", nf: "https://go.test/x", reserved: "a/b" }, ["go.test"]);
    expect(r.errors).toEqual({ bare: "scheme", nf: "loop", reserved: "invalid_reserved" });
  });
});
