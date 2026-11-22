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
    expect(d({ action: "settings.update", targetType: "settings", targetId: "x", detail: { key: "other" } }).text).toBe("settings.update");
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
});
