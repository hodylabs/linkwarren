import { describe, expect, it } from "vitest";
import type { AuditItem } from "../api";
import { describeAudit } from "./auditText";

const mk = (o: Partial<AuditItem>): AuditItem => ({
  id: 1, at: 1, actorId: "u1", actorEmail: "dana@example.com", actorName: "Dana R.", via: null,
  action: "link.update", targetType: "link", targetId: "l1", detail: {}, ...o,
});
const d = (o: Partial<AuditItem>, me = "uo") => describeAudit(mk(o), me);

describe("describeAudit", () => {
  it("settings.update for mcp.enabled", () => {
    expect(d({ action: "settings.update", targetType: "settings", targetId: "mcp.enabled", detail: { key: "mcp.enabled", value: "1" } }).text).toBe("turned agent connections on");
    expect(d({ action: "settings.update", targetType: "settings", targetId: "mcp.enabled", detail: { key: "mcp.enabled", value: "0" } }).text).toBe("turned agent connections off");
    expect(d({ action: "settings.update", targetType: "settings", targetId: "x", detail: { key: "other" } }).text).toBe("changed instance settings");
  });
  it("names the actor: You, name, email, or a deleted user", () => {
    expect(d({ actorId: "uo" }).who).toBe("You");
    expect(d({}).who).toBe("Dana R.");
    expect(d({ actorName: null }).who).toBe("dana@example.com");
    expect(d({ actorName: null, actorEmail: null }).who).toBe("A deleted user");
  });
  it("via is shown as via <agent>", () => {
    expect(d({ via: "Claude" }).via).toBe("via Claude");
    expect(d({}).via).toBeNull();
  });
  it("link.create and link.update and link.delete", () => {
    expect(d({ action: "link.create", detail: { host: "go.test", slug: "spring" } })).toMatchObject({ text: "created", code: "go.test/spring" });
    expect(d({ action: "link.update", detail: { host: "go.test", slug: "spring" } })).toMatchObject({ text: "changed", code: "go.test/spring" });
    expect(d({ action: "link.delete", detail: { host: "go.test", slug: "spring" } })).toMatchObject({
      text: "deleted", code: "go.test/spring",
    });
    expect(d({ action: "link.delete", detail: { host: "go.test", slug: "x" } }).text).toBe("deleted");
  });
  it("link.move names both hosts and says the old address forwards", () => {
    expect(d({ action: "link.move", detail: { fromHost: "go.test", toHost: "b.test", slug: "spring", oldAddress: "forward" } })).toMatchObject({
      text: "moved", code: "go.test/spring", suffix: " to b.test, the old address forwards",
    });
  });
  it("link.create with copiedFrom says copied ... to ...", () => {
    expect(d({ action: "link.create", detail: { host: "b.test", slug: "spring", copiedFrom: "l1" } })).toMatchObject({ text: "copied", code: "spring", suffix: " to b.test" });
    expect(d({ action: "link.create", detail: { host: "b.test", slug: "spring" } }).text).toBe("created");
  });
  it("link.delete adds the locked slug sentence", () => {
    expect(d({ action: "link.delete", detail: { host: "a", slug: "b" } }).suffix).toBe(". The slug is locked, visits go to the domain's not-found page");
  });
  it("domain actions use the host as code", () => {
    const detail = { host: "go.test" };
    const t = (action: string) => d({ action, targetType: "domain", detail }).text;
    expect(t("domain.create")).toBe("added the domain");
    expect(t("domain.approve")).toBe("approved");
    expect(t("domain.disable")).toBe("disabled");
    expect(t("domain.update")).toBe("changed the settings of");
    expect(t("domain.members")).toBe("changed who can use");
    expect(d({ action: "domain.approve", targetType: "domain", detail }).code).toBe("go.test");
  });
  it("lock.release shows host/slug from the server shape (targetId domainId/key, detail domainId + slugKeys)", () => {
    const row = { action: "lock.release", targetType: "lock", targetId: "d1/spring", detail: { domainId: "d1", slugKeys: ["spring"] } };
    expect(describeAudit(mk(row), "uo", [{ id: "d1", host: "go.test" }])).toMatchObject({ text: "released the locked slug", code: "go.test/spring" });
  });
  it("lock.release falls back to the target id when the domain is unknown or the detail is malformed", () => {
    const row = { action: "lock.release", targetType: "lock", targetId: "d9/spring", detail: { domainId: "d9", slugKeys: ["spring"] } };
    expect(describeAudit(mk(row), "uo", [{ id: "d1", host: "go.test" }]).code).toBe("d9/spring");
    expect(describeAudit(mk({ ...row, detail: { domainId: 5 } }), "uo", [{ id: "d1", host: "go.test" }]).code).toBe("d9/spring");
    expect(d({ action: "lock.release", targetType: "lock", targetId: "k9" }).code).toBe("k9");
  });
  it("user and import actions", () => {
    expect(d({ action: "user.bootstrap", targetType: "user" })).toMatchObject({ text: "set up this linkwarren", code: null });
    expect(d({ action: "user.activate", targetType: "user" })).toMatchObject({ text: "signed in for the first time", code: null });
    expect(d({ action: "import.run", targetType: "import", detail: { planned: 5, skipped: 2 } })).toMatchObject({ text: "imported links", suffix: " (5 planned, 2 skipped)", code: null });
    expect(d({ action: "import.chunk", targetType: "import" }).text).toBe("imported a batch of links");
  });
  it("an unknown action falls back to the action and the target", () => {
    expect(d({ action: "thing.happen", targetType: "widget", targetId: "w1" })).toMatchObject({ text: "thing.happen", code: "widget w1" });
  });
  it("detail with the wrong shape never throws", () => {
    expect(d({ action: "link.create", detail: { host: 5, slug: null } }).code).toBe("link l1");
  });
  it("sign-in, session and passkey actions", () => {
    expect(d({ action: "auth.sign_in", detail: { method: "email" } }).text).toBe("signed in with an email link");
    expect(d({ action: "auth.sign_in", detail: { method: "passkey" } }).text).toBe("signed in with a passkey");
    expect(d({ action: "auth.sign_out" }).text).toBe("signed out");
    expect(d({ action: "auth.sign_out_all", detail: { count: 2 } }).text).toBe("signed out everywhere");
    expect(d({ action: "session.end", targetType: "session" }).text).toBe("ended a session");
    expect(d({ action: "passkey.add", detail: { name: "Laptop" } })).toMatchObject({ text: "added the passkey", code: "Laptop" });
    expect(d({ action: "passkey.rename", detail: { name: "Desk" } })).toMatchObject({ text: "renamed a passkey to", code: "Desk" });
    expect(d({ action: "passkey.remove" }).text).toBe("removed a passkey");
  });
  it("session.end_all names the person by email, else their id", () => {
    const row = mk({ action: "session.end_all", targetType: "user", targetId: "u9", detail: { count: 3 } });
    expect(describeAudit(row, "uo", [], [{ id: "u9", email: "pat@example.com" }])).toMatchObject({ text: "signed", code: "pat@example.com", suffix: " out everywhere" });
    expect(describeAudit(row, "uo").code).toBe("u9");
  });
});

describe("describeAudit system actor", () => {
  it("names the system actor linkwarren and words the purge", () => {
    const r = d({ actorId: "system", actorEmail: null, actorName: null, action: "audit.purge", targetType: "audit", targetId: "audit_log", detail: { deleted: 12 } });
    expect(r.who).toBe("linkwarren");
    expect(r.text).toBe("removed audit entries older than 3 years");
    expect(r.suffix).toBe(" (12)");
  });
});

describe("describeAudit agents and keys", () => {
  const t = (o: Partial<AuditItem>) => d({ targetType: "agent_connection", targetId: "c1", ...o });
  it("agent.connect names the client, shown as the person via the client", () => {
    const r = t({ action: "agent.connect", via: "Claude", detail: { clientId: "x", redirectHost: "claude.ai", write: false, del: false } });
    expect(r).toMatchObject({ who: "Dana R.", via: "via Claude", text: "connected an agent", code: "Claude" });
  });
  it("agent.access and agent.disconnect", () => {
    expect(t({ action: "agent.access", detail: { write: true, del: false } }).text).toBe("changed what an agent can do");
    expect(t({ action: "agent.disconnect", detail: { userId: "u1", clientName: "Codex" } })).toMatchObject({ text: "disconnected an agent", code: "Codex" });
  });
  it("a failed approval reads failed to connect", () => {
    expect(t({ action: "agent.disconnect", via: "Claude", detail: { reason: "failed" } })).toMatchObject({ via: "via Claude", text: "failed to connect", code: null });
  });
  it("key.create and key.revoke", () => {
    expect(d({ action: "key.create", targetType: "api_key", detail: { name: "zapier", prefix: "lw_abc" } })).toMatchObject({ text: "created the API key", code: "zapier" });
    expect(d({ action: "key.revoke", targetType: "api_key", detail: { name: "zapier" } })).toMatchObject({ text: "revoked an API key", code: null });
  });

  const users = [{ id: "ub", email: "bea@example.com", name: "Bea" }];
  const pd = (o: Partial<AuditItem>) => describeAudit(mk(o), "uo", [], users);
  it("user.invite names the email and the domains, or the main domain", () => {
    expect(pd({ action: "user.invite", targetType: "user", detail: { email: "jo@example.com", role: "member", domains: ["nw.link", "qr.test"] } }))
      .toMatchObject({ text: "invited", code: "jo@example.com", suffix: " with access to nw.link, qr.test" });
    expect(pd({ action: "user.invite", targetType: "user", detail: { email: "jo@example.com", role: "member", domains: [] } }).suffix).toBe(" with access to the main domain");
    expect(pd({ action: "user.invite", targetType: "user", detail: { email: "jo@example.com", role: "owner", domains: [] } }).suffix).toBe(" as an owner");
  });
  it("user.invite names a custom role (S8)", () => {
    expect(pd({ action: "user.invite", targetType: "user", detail: { email: "jo@example.com", role: "member", roleId: "hl", roleName: "Helper", domains: [] } }).suffix)
      .toBe(" as Helper with access to the main domain");
    expect(pd({ action: "user.invite", targetType: "user", detail: { email: "jo@example.com", role: "member", roleId: "member", roleName: "Member", domains: [] } }).suffix)
      .toBe(" with access to the main domain");
  });
  it("user.invite_resend and user.revoke", () => {
    expect(pd({ action: "user.invite_resend", detail: { email: "jo@example.com", emailed: true } })).toMatchObject({ text: "re-sent the invite to", code: "jo@example.com" });
    expect(pd({ action: "user.revoke", detail: { email: "jo@example.com" } })).toMatchObject({ text: "revoked the invite for", code: "jo@example.com" });
  });
  it("user.role, user.disable and user.enable name the person", () => {
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "member", to: "owner", movedDomains: [] } })).toMatchObject({ text: "made", code: "bea@example.com", suffix: " an owner" });
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "owner", to: "member", movedDomains: [] } }).suffix).toBe(" a member");
    expect(pd({ action: "user.disable", targetId: "ub" })).toMatchObject({ text: "turned off access for", code: "bea@example.com" });
    expect(pd({ action: "user.enable", targetType: "user", targetId: "gone" })).toMatchObject({ text: "turned on access for", code: "user gone" });
    // The server writes the email, so a removed person still reads by name.
    expect(pd({ action: "user.disable", targetType: "user", targetId: "gone", detail: { email: "jo@example.com" } }).code).toBe("jo@example.com");
    expect(pd({ action: "user.role", targetType: "user", targetId: "gone", detail: { email: "jo@example.com", to: "owner" } }).code).toBe("jo@example.com");
  });
  it("user.role with role names and ids (S8 R14): changed <person> from <from> to <to>", () => {
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "Member", to: "Owner", fromId: "member", toId: "owner", movedDomains: [] } }))
      .toMatchObject({ text: "changed", code: "bea@example.com", suffix: " from Member to Owner" });
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "Helper", to: "Member", fromId: "hl", toId: "member", movedDomains: [] } }).suffix).toBe(" from Helper to Member");
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "Owner", to: "Helper", fromId: "owner", toId: "hl", movedDomains: ["go.test"] } }).suffix)
      .toBe(" from Owner to Helper and took over go.test");
  });
  it("role.create, role.update and role.delete (S8 R14) use the plain permission labels", () => {
    expect(d({ action: "role.create", targetType: "role", targetId: "hl", detail: { name: "Helper", perms: ["keys"] } })).toMatchObject({ text: "created the role", code: "Helper", suffix: "" });
    expect(d({ action: "role.update", targetType: "role", targetId: "hl", detail: { name: "Helper", added: ["keys", "audit"], removed: ["links.bulk"] } }))
      .toMatchObject({ text: "changed the role", code: "Helper", suffix: ": added Personal API keys, Audit log, removed Change many links at once" });
    expect(d({ action: "role.update", targetType: "role", targetId: "hl", detail: { name: "Helper", added: ["keys"], removed: [] } }).suffix).toBe(": added Personal API keys");
    expect(d({ action: "role.update", targetType: "role", targetId: "hl", detail: { name: "Aides", from: "Helper", added: [], removed: [] } }).suffix).toBe(", renamed from Helper");
    expect(d({ action: "role.update", targetType: "role", targetId: "hl", detail: { name: "Helper", added: ["__proto__", 3], removed: [] } }).suffix).toBe("");
    expect(d({ action: "role.delete", targetType: "role", targetId: "hl", detail: { name: "Helper", movedTo: "Member", people: 2 } }))
      .toMatchObject({ text: "deleted the role", code: "Helper", suffix: " and moved 2 people to Member" });
    expect(d({ action: "role.delete", targetType: "role", targetId: "hl", detail: { name: "Helper", movedTo: "Member", people: 1 } }).suffix).toBe(" and moved 1 person to Member");
    expect(d({ action: "role.delete", targetType: "role", targetId: "hl", detail: { name: "Helper", movedTo: null, people: 0 } }).suffix).toBe("");
  });
  it("user.role names the domains that moved to the actor on a demote", () => {
    expect(pd({ action: "user.role", targetId: "ub", detail: { from: "owner", to: "member", movedDomains: ["go.test", "s.test"] } }).suffix)
      .toBe(" a member and took over go.test, s.test");
  });
  it("user.remove names who got their links", () => {
    expect(pd({ action: "user.remove", detail: { email: "jo@example.com", role: "member", transferTo: "ub", links: 3, domains: [] } }))
      .toMatchObject({ text: "removed", code: "jo@example.com", suffix: ", moving their links to Bea" });
    expect(pd({ action: "user.remove", detail: { email: "jo@example.com", transferTo: "uo", links: 0, domains: [] } }).suffix).toBe(", moving their links to you");
  });
  it("settings.update per key", () => {
    const s = (key: string) => pd({ action: "settings.update", targetType: "settings", targetId: key, detail: { key, value: "x" } }).text;
    expect(s("instance.name")).toBe("renamed the instance");
    expect(s("instance.mainDomainId")).toBe("changed the main domain");
    expect(s("links.defaultRedirectCode")).toBe("changed link defaults");
    expect(s("links.defaultPassQuery")).toBe("changed link defaults");
    expect(s("instance.logoVersion")).toBe("changed instance settings");
  });
  it("secret, logo, setup, export and email texts", () => {
    expect(pd({ action: "secret.update", detail: { name: "CF_API_TOKEN" } }).text).toBe("saved the Cloudflare token");
    expect(pd({ action: "secret.update", detail: { name: "RESEND_API_KEY" } }).text).toBe("saved the Resend key");
    expect(pd({ action: "secret.delete", detail: { name: "CF_API_TOKEN" } }).text).toBe("removed the saved Cloudflare token");
    expect(pd({ action: "secret.delete", detail: { name: "RESEND_API_KEY" } }).text).toBe("removed the saved Resend key");
    expect(pd({ action: "logo.update", detail: { type: "image/png", bytes: 10 } }).text).toBe("changed the logo");
    expect(pd({ action: "logo.remove" }).text).toBe("removed the logo");
    expect(pd({ action: "setup.complete" }).text).toBe("finished the first-run setup");
    expect(pd({ action: "export.run" }).text).toBe("downloaded a full export");
    expect(pd({ action: "email.test" }).text).toBe("sent a test email");
  });
});
