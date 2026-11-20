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
    expect(d({ action: "link.update", detail: { host: "go.test", slug: "spring" } })).toMatchObject({ text: "changed the destination of", code: "go.test/spring" });
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
  it("lock.release uses the host from detail, else the target id", () => {
    expect(d({ action: "lock.release", targetType: "lock", detail: { host: "go.test" } })).toMatchObject({ text: "released the locked slug", code: "go.test" });
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
});
