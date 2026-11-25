import { describe, expect, it } from "vitest";
import type { CfView, Domain, Me, UserItem } from "../api";
import { canManage, domainDiff, draftOf, needsFinish, ownerLabel, parseReserved, sharedWith, statusTag } from "./domainView";
import { cfSettled } from "./useCfPoll";
import { MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE };
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

  const cf = (dns: CfView["dns"], kind: CfView["kind"] = "outside"): CfView => ({
    kind, dns, ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1, instructions: null, attachOnApproval: false, attached: true, securityLevel: null, rateLimit: null,
  });
  it("an outside domain whose record is missing or wrong reads DNS record missing", () => {
    expect(statusTag(dom({ status: "pending", cloudflare: cf("missing") }), true)).toEqual({ label: "DNS record missing", tone: "bad" });
    expect(statusTag(dom({ cloudflare: cf("wrong_target") }), false)).toEqual({ label: "DNS record missing", tone: "bad" });
  });
  it("found, unknown, account and disabled keep the status tag", () => {
    expect(statusTag(dom({ status: "pending", cloudflare: cf("found") }), true).label).toBe("Needs your approval");
    expect(statusTag(dom({ cloudflare: cf("unknown") }), true).label).toBe("Active");
    expect(statusTag(dom({ cloudflare: cf("missing", "account") }), true).label).toBe("Active");
    expect(statusTag(dom({ status: "disabled", cloudflare: cf("missing") }), true).label).toBe("Disabled");
  });
});

describe("half-attached account domains and stored errors", () => {
  const acc = (o: Partial<CfView> = {}): CfView => ({
    kind: "account", dns: "missing", ownership: "pending", certificate: "issued", errors: [], lastError: null, checkedAt: 1, instructions: null, attachOnApproval: false, attached: false, securityLevel: null, rateLimit: null, ...o,
  });
  it("an active account domain that is not attached, or that has a stored error, reads Not connected", () => {
    expect(statusTag(dom({ cloudflare: acc() }), true)).toEqual({ label: "Not connected", tone: "bad" });
    expect(statusTag(dom({ cloudflare: acc({ attached: true, ownership: "verified", dns: "found", lastError: "route_in_use" }) }), true)).toEqual({ label: "Not connected", tone: "bad" });
    expect(statusTag(dom({ cloudflare: acc({ attached: true, ownership: "verified", dns: "found" }) }), true).label).toBe("Active");
    expect(statusTag(dom({ status: "pending", cloudflare: acc({ attachOnApproval: true }) }), true).label).toBe("Needs your approval");
    expect(needsFinish(acc())).toBe(true);
    expect(needsFinish(acc({ attachOnApproval: true }))).toBe(false);
  });
  it("cfSettled: only unreachable and cloudflare_error keep polling; an unattached account domain never polls", () => {
    const out = (lastError: string | null): CfView => ({ ...acc({ kind: "outside", attached: true }), lastError });
    expect(["cloudflare_unreachable", "cloudflare_error"].map((e) => cfSettled(out(e)))).toEqual([false, false]);
    for (const e of ["cloudflare_forbidden", "outside_not_configured", "route_in_use", "hostname_in_use", "hostname_limit", "dns_record_exists", "dns_not_proxied", "internal_error"])
      expect([e, cfSettled(out(e))]).toEqual([e, true]);
    expect(cfSettled(acc({ lastError: "cloudflare_error" }))).toBe(true);
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
  it("the bare domain may name one of its own links; the not-found field may not", () => {
    const d = dom();
    expect(domainDiff(d, { ...draftOf(d), bare: "/card" }, ["go.test"]).body).toEqual({ bareRedirect: "/card" });
    expect(domainDiff(d, { ...draftOf(d), bare: "https://go.test/card" }, ["go.test"]).body).toEqual({ bareRedirect: "https://go.test/card" });
    expect(domainDiff(d, { ...draftOf(d), nf: "https://go.test/card" }, ["go.test"]).errors.nf).toBeTruthy();
    expect(domainDiff(d, { ...draftOf(d), bare: "https://go.test./card" }, ["go.test"]).body).toEqual({ bareRedirect: "https://go.test./card" });
    expect(domainDiff(d, { ...draftOf(d), bare: "https://go.test:8443/card" }, ["go.test"]).errors.bare).toBeTruthy();
  });
  it("reports bad redirects and reserved per field", () => {
    const d = dom();
    const r = domainDiff(d, { ...draftOf(d), bare: "ftp://x", nf: "https://go.test/x", reserved: "a/b" }, ["go.test"]);
    expect(r.errors).toEqual({ bare: "scheme", nf: "loop", reserved: "invalid_reserved" });
  });
});
