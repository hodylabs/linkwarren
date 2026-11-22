import { describe, expect, it } from "vitest";
import type { AuditItem } from "../api";
import { describeAudit } from "./auditText";

const mk = (o: Partial<AuditItem>): AuditItem => ({
  id: 1, at: 1, actorId: "u1", actorEmail: "dana@example.com", actorName: "Dana R.", via: null,
  action: "link.update", targetType: "link", targetId: "l1", detail: {}, ...o,
});
const d = (o: Partial<AuditItem>, me = "uo") => describeAudit(mk(o), me);

describe("describeAudit", () => {
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
