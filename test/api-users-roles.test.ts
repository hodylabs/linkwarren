import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_DEFAULT } from "../src/roles";
import { dash } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { fakeResend } from "./helpers/resend";
import { signedIn, withCookie } from "./helpers/session";

const e = env as unknown as Record<string, string | undefined>;
const prev = { mode: e.AUTH_MODE };
beforeAll(() => { e.AUTH_MODE = "app"; });
afterAll(() => { e.AUTH_MODE = prev.mode; });
afterEach(() => {
  vi.restoreAllMocks();
  e.EMAIL_FROM = undefined;
  e.RESEND_API_KEY = undefined;
});

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const rows = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  dash(path, withCookie(cookie, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const patch = (cookie: string, id: string, body: unknown) => call(cookie, "PATCH", `/api/users/${id}`, body);
const answer = async (r: Response) => [r.status, await r.json()];
const role = (id: string, name: string, perms: readonly string[]) =>
  run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, name, JSON.stringify(perms));
const setPerms = (id: string, perms: readonly string[]) => run("UPDATE roles SET perms = ? WHERE id = ?", JSON.stringify(perms), id);
const who = (id: string) => one<{ role: string; role_id: string | null; status: string }>("SELECT role, role_id, status FROM users WHERE id = ?", id);
// Sign-ins (auth.*) are the fixtures' own rows.
const audits = async (like = "%") => (await rows("SELECT action, actor_id, target_id, detail FROM audit_log WHERE action LIKE ? AND action NOT LIKE 'auth.%' ORDER BY id", like))
  .map((r) => ({ ...r, detail: JSON.parse(r.detail as string) }));
const above = { error: "role_above_you" };
const MANAGER = [...MEMBER_DEFAULT, "people.manage"];

let O: Awaited<ReturnType<typeof signedIn>>, M: Awaited<ReturnType<typeof signedIn>>, P: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  for (const k of (await env.OAUTH_KV.list()).keys) await env.OAUTH_KV.delete(k.name);
  await env.DB.batch(["tool_calls", "auth_limits", "login_tokens", "links", "audit_log", "domain_members", "api_keys", "agent_connections", "sessions", "domains", "settings", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("UPDATE roles SET name = 'Member', perms = ? WHERE id = 'member'", JSON.stringify(MEMBER_DEFAULT));
  await role("mg", "Manager", MANAGER);
  await role("hl", "Helper", ["links.create"]);
  await role("st", "Settings", ["settings"]);
  await role("au", "Auditors", ["audit"]);
  O = await signedIn("owner@example.com", { role: "owner" });
  M = await signedIn("manager@example.com", { roleId: "mg" });
  P = await signedIn("p@example.com");
});

describe("people.manage holders manage people within their role", () => {
  it("lists people; a domains.manage holder too; a plain member does not", async () => {
    const r = await call(M.cookie, "GET", "/api/users");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: { email: string }[] }).items.map((u) => u.email).sort()).toEqual(["manager@example.com", "owner@example.com", "p@example.com"]);
    await role("dmg", "Domain admins", ["domains.manage"]);
    const D = await signedIn("d@example.com", { roleId: "dmg" });
    expect((await call(D.cookie, "GET", "/api/users")).status).toBe(200);
    expect(await answer(await call(P.cookie, "GET", "/api/users"))).toEqual([403, { error: "forbidden" }]);
    // domains.manage alone lists, it does not manage
    expect(await answer(await patch(D.cookie, P.user.id, { roleId: "hl" }))).toEqual([403, { error: "forbidden" }]);
  });

  it("moves a member to a weaker role: 200, role_id stored, audit with names and ids; back to Member stores NULL", async () => {
    const r = await patch(M.cookie, P.user.id, { roleId: "hl" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: unknown }).user).toMatchObject({ id: P.user.id, role: "member", roleId: "hl", roleName: "Helper", perms: ["links.create"] });
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: "hl", status: "active" });
    expect(await audits("user.role")).toEqual([{ action: "user.role", actor_id: M.user.id, target_id: P.user.id,
      detail: { email: "p@example.com", from: "Member", to: "Helper", fromId: "member", toId: "hl", movedDomains: [] } }]);
    expect((await patch(M.cookie, P.user.id, { roleId: "member" })).status).toBe(200);
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
  });

  it("disables and re-enables a person within; removes a person within", async () => {
    expect((await patch(M.cookie, P.user.id, { status: "disabled" })).status).toBe(200);
    expect((await patch(M.cookie, P.user.id, { status: "active" })).status).toBe(200);
    expect((await call(M.cookie, "DELETE", `/api/users/${P.user.id}/sessions`)).status).toBe(204);
  });

  it("assigning Owner, or a role with a key the manager lacks, is 403 role_above_you and writes nothing", async () => {
    for (const roleId of ["owner", "st"]) expect(await answer(await patch(M.cookie, P.user.id, { roleId }))).toEqual([403, above]);
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
    expect(await audits()).toEqual([]);
  });

  it("a person whose role holds a key the manager lacks is out of reach: role, status, remove, sign out 403", async () => {
    const X = await signedIn("x@example.com", { roleId: "au" });
    const sessions = await rows("SELECT id FROM sessions WHERE user_id = ?", X.user.id);
    for (const r of [await patch(M.cookie, X.user.id, { roleId: "member" }), await patch(M.cookie, X.user.id, { status: "disabled" }),
      await call(M.cookie, "DELETE", `/api/users/${X.user.id}`), await call(M.cookie, "DELETE", `/api/users/${X.user.id}/sessions`)]) {
      expect(await answer(r)).toEqual([403, above]);
    }
    expect(await who(X.user.id)).toEqual({ role: "member", role_id: "au", status: "active" });
    expect(await rows("SELECT id FROM sessions WHERE user_id = ?", X.user.id)).toEqual(sessions);
    expect(await audits()).toEqual([]);
  });

  it("an owner is out of reach: role, status, remove, sign out 403 and nothing written", async () => {
    for (const r of [await patch(M.cookie, O.user.id, { roleId: "member" }), await patch(M.cookie, O.user.id, { status: "disabled" }),
      await call(M.cookie, "DELETE", `/api/users/${O.user.id}`), await call(M.cookie, "DELETE", `/api/users/${O.user.id}/sessions`)]) {
      expect(await answer(r)).toEqual([403, above]);
    }
    expect(await who(O.user.id)).toEqual({ role: "owner", role_id: null, status: "active" });
    expect((await rows("SELECT id FROM sessions WHERE user_id = ?", O.user.id)).length).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it("the manager on themselves: 409 self (role, status, remove, sign out)", async () => {
    for (const r of [await patch(M.cookie, M.user.id, { roleId: "member" }), await patch(M.cookie, M.user.id, { status: "disabled" }),
      await call(M.cookie, "DELETE", `/api/users/${M.user.id}`), await call(M.cookie, "DELETE", `/api/users/${M.user.id}/sessions`)]) {
      expect(await answer(r)).toEqual([409, { error: "self" }]);
    }
    expect(await who(M.user.id)).toEqual({ role: "member", role_id: "mg", status: "active" });
  });

  it("an unknown roleId is 400 bad_role; a bad body 400 invalid_body; the old role key is refused", async () => {
    expect(await answer(await patch(O.cookie, P.user.id, { roleId: "nope" }))).toEqual([400, { error: "bad_role" }]);
    expect(await answer(await patch(M.cookie, P.user.id, { roleId: "nope" }))).toEqual([400, { error: "bad_role" }]);
    for (const b of [{ role: "owner" }, { roleId: "" }, { roleId: "x".repeat(65) }]) expect((await patch(O.cookie, P.user.id, b)).status).toBe(400);
  });
});

describe("names", () => {
  const nameOf = async (id: string) => (await one<{ name: string | null }>("SELECT name FROM users WHERE id = ?", id))?.name;
  it("a people manager sets and clears a name in reach, cleaned and audited; role and status untouched", async () => {
    expect((await patch(M.cookie, P.user.id, { name: "  Pat\u202E  Doe " })).status).toBe(200);
    expect(await nameOf(P.user.id)).toBe("Pat Doe");
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
    expect((await patch(M.cookie, P.user.id, { name: "" })).status).toBe(200);
    expect(await nameOf(P.user.id)).toBeNull();
    expect((await audits("user.name")).map((a) => a.detail)).toEqual([{ email: "p@example.com", name: "Pat Doe" }, { email: "p@example.com", name: null }]);
  });

  it("refusals: a bad name 400, an owner out of reach 403, yourself 409, a plain member 403; nothing written", async () => {
    expect(await answer(await patch(M.cookie, P.user.id, { name: "x".repeat(41) }))).toEqual([400, { error: "invalid_name" }]);
    expect(await answer(await patch(M.cookie, P.user.id, { name: "\u200b" }))).toEqual([400, { error: "invalid_name" }]);
    expect(await answer(await patch(M.cookie, O.user.id, { name: "Boss" }))).toEqual([403, above]);
    expect(await answer(await patch(M.cookie, M.user.id, { name: "Me" }))).toEqual([409, { error: "self" }]);
    expect((await patch(P.cookie, M.user.id, { name: "Nope" })).status).toBe(403);
    for (const id of [P.user.id, O.user.id, M.user.id]) expect(await nameOf(id)).toBeNull();
    expect(await audits("user.name")).toEqual([]);
  });

  it("your own name: set, clear, refused when bad; audited", async () => {
    expect(await answer(await call(P.cookie, "PUT", "/api/account/name", { name: " Pat " }))).toEqual([200, { name: "Pat" }]);
    expect(await nameOf(P.user.id)).toBe("Pat");
    expect(await answer(await call(P.cookie, "PUT", "/api/account/name", { name: "x".repeat(41) }))).toEqual([400, { error: "invalid_name" }]);
    expect(await answer(await call(P.cookie, "PUT", "/api/account/name", { name: "" }))).toEqual([200, { name: null }]);
    expect(await nameOf(P.user.id)).toBeNull();
    expect((await call(P.cookie, "PUT", "/api/account/name", { name: 5 })).status).toBe(400);
    expect((await audits("user.name")).map((a) => (a as Record<string, unknown>).actor_id)).toEqual([P.user.id, P.user.id]);
  });

  it("an invite can carry a name; a bad one is 400 and invites nobody", async () => {
    expect((await call(M.cookie, "POST", "/api/users/invite", { email: "new@example.com", name: "New One" })).status).toBe(201);
    expect(await one("SELECT name, status FROM users WHERE email = 'new@example.com'")).toEqual({ name: "New One", status: "invited" });
    expect(await answer(await call(M.cookie, "POST", "/api/users/invite", { email: "two@example.com", name: "\u202e" }))).toEqual([400, { error: "invalid_name" }]);
    expect(await one("SELECT id FROM users WHERE email = 'two@example.com'")).toBeNull();
  });
});

describe("removal by a people manager transfers to an owner, never to the manager", () => {
  const owned = async (id: string) => ({
    links: (await rows("SELECT created_by FROM links WHERE id IN ('l1','l2') ORDER BY id")).map((r) => r.created_by),
    domain: (await one<{ owner_id: string }>("SELECT owner_id FROM domains WHERE id = 'dp'"))?.owner_id,
    person: await who(id),
  });
  let B: Awaited<ReturnType<typeof signedIn>>;
  beforeEach(async () => {
    B = await signedIn("b@example.com", { role: "owner", createdAt: 5 }); // O (createdAt 1) is the first owner
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dp','p.test','private','active',?,1), ('dm','m.test','main','active',?,1)", P.user.id, O.user.id);
    for (const l of ["l1", "l2"]) await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'dm',?,?,'https://x.test/',?,?,1,1)", l, l, l, P.user.id, P.user.id);
  });
  const remove = (to?: string) => call(M.cookie, "DELETE", `/api/users/${P.user.id}${to === undefined ? "" : `?transferTo=${encodeURIComponent(to)}`}`);

  it("by default the links and private domains go to the first active owner", async () => {
    expect((await remove()).status).toBe(200);
    expect(await owned(P.user.id)).toEqual({ links: [O.user.id, O.user.id], domain: O.user.id, person: null });
    expect((await audits("user.remove"))[0]!.detail).toMatchObject({ transferTo: O.user.id });
  });

  it("a chosen other owner gets them", async () => {
    expect((await remove(B.user.id)).status).toBe(200);
    expect(await owned(P.user.id)).toEqual({ links: [B.user.id, B.user.id], domain: B.user.id, person: null });
  });

  it("the manager themselves or any non-owner as the target is 400 bad_transfer and nothing moves", async () => {
    const X = await signedIn("x@example.com");
    for (const to of [M.user.id, X.user.id]) expect(await answer(await remove(to))).toEqual([400, { error: "bad_transfer" }]);
    expect(await owned(P.user.id)).toEqual({ links: [P.user.id, P.user.id], domain: P.user.id, person: { role: "member", role_id: null, status: "active" } });
    expect(await audits()).toEqual([]);
  });

  it("an owner may still pick any active person (today's free choice)", async () => {
    const X = await signedIn("x@example.com");
    expect((await call(O.cookie, "DELETE", `/api/users/${P.user.id}?transferTo=${X.user.id}`)).status).toBe(200);
    expect(await owned(P.user.id)).toEqual({ links: [X.user.id, X.user.id], domain: X.user.id, person: null });
  });

  it("an owner demoted to a people.manage role between read and batch cannot move things to a non-owner: 403, nothing written", async () => {
    const X = await signedIn("x@example.com");
    const restore = beforeBatch(1, () => run("UPDATE users SET role = 'member', role_id = 'mg' WHERE id = ?", O.user.id));
    let r: Response;
    try { r = await call(O.cookie, "DELETE", `/api/users/${P.user.id}?transferTo=${X.user.id}`); } finally { restore(); }
    expect(await answer(r)).toEqual([403, { error: "forbidden" }]);
    expect(await owned(P.user.id)).toEqual({ links: [P.user.id, P.user.id], domain: P.user.id, person: { role: "member", role_id: null, status: "active" } });
    expect(await audits()).toEqual([]);
  });

  for (const [what, sql] of [["demoted", "UPDATE users SET role = 'member' WHERE id = ?"], ["disabled", "UPDATE users SET status = 'disabled' WHERE id = ?"]] as const) {
    it(`the chosen owner is ${what} between read and batch: 400 bad_transfer and nothing written`, async () => {
      const restore = beforeBatch(1, () => run(sql, B.user.id));
      let r: Response;
      try { r = await remove(B.user.id); } finally { restore(); }
      expect(await answer(r)).toEqual([400, { error: "bad_transfer" }]);
      expect(await owned(P.user.id)).toEqual({ links: [P.user.id, P.user.id], domain: P.user.id, person: { role: "member", role_id: null, status: "active" } });
      expect(await audits()).toEqual([]);
    });
  }
});

describe("owners with roleId", () => {
  it("promoting a member on a custom role clears role_id in the same statement (no trigger 500)", async () => {
    const r = await patch(O.cookie, M.user.id, { roleId: "owner" });
    expect(r.status).toBe(200);
    expect(await who(M.user.id)).toEqual({ role: "owner", role_id: null, status: "active" });
    const [a] = await audits("user.role");
    expect(a!.detail).toEqual({ email: "manager@example.com", from: "Manager", to: "Owner", fromId: "mg", toId: "owner", movedDomains: [] });
  });

  it("an owner demoted to a custom role keeps the domain move; between non-owner roles nothing moves", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('ds','s.test','shared','active',?,1), ('dp','p.test','private','active',?,1)", B.user.id, B.user.id);
    expect((await patch(O.cookie, B.user.id, { roleId: "hl" })).status).toBe(200);
    expect(await who(B.user.id)).toEqual({ role: "member", role_id: "hl", status: "active" });
    expect(await rows("SELECT id, owner_id FROM domains ORDER BY id")).toEqual([{ id: "dp", owner_id: B.user.id }, { id: "ds", owner_id: O.user.id }]);
    expect((await audits("user.role"))[0]!.detail).toMatchObject({ from: "Owner", to: "Helper", movedDomains: ["s.test"] });
    expect((await patch(O.cookie, B.user.id, { roleId: "st" })).status).toBe(200);
    expect((await audits("user.role"))[1]!.detail).toMatchObject({ from: "Helper", to: "Settings", movedDomains: [] });
    expect(await rows("SELECT id, owner_id FROM domains ORDER BY id")).toEqual([{ id: "dp", owner_id: B.user.id }, { id: "ds", owner_id: O.user.id }]);
  });

  it("the same role again is a no-op 200 with nothing written", async () => {
    expect((await patch(O.cookie, M.user.id, { roleId: "mg" })).status).toBe(200);
    expect(await audits()).toEqual([]);
  });

  it("a role change between read and batch (role_id moved) is 409 changed and writes nothing", async () => {
    const restore = beforeBatch(1, () => run("UPDATE users SET role_id = 'hl' WHERE id = ?", P.user.id));
    let r: Response;
    try { r = await patch(O.cookie, P.user.id, { roleId: "st" }); } finally { restore(); }
    expect(await answer(r)).toEqual([409, { error: "changed" }]);
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: "hl", status: "active" });
    expect(await audits()).toEqual([]);
  });
});

describe("races: every R4 check is re-done in the batch", () => {
  it("the owner adds settings to Helper between the manager's read and batch: 403, nothing written", async () => {
    const restore = beforeBatch(1, () => setPerms("hl", ["links.create", "settings"]));
    let r: Response;
    try { r = await patch(M.cookie, P.user.id, { roleId: "hl" }); } finally { restore(); }
    expect(await answer(r)).toEqual([403, above]);
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
    expect(await audits()).toEqual([]);
  });

  it("the new role is deleted between read and batch: 400 bad_role on PATCH and invite, nothing written", async () => {
    await role("gone", "Gone", ["links.create"]);
    for (const go of [() => patch(M.cookie, P.user.id, { roleId: "gone" }), () => call(M.cookie, "POST", "/api/users/invite", { email: "new@example.com", roleId: "gone" })]) {
      await run("INSERT OR IGNORE INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('gone','Gone','[\"links.create\"]',0,1,1)");
      const restore = beforeBatch(1, () => run("DELETE FROM roles WHERE id = 'gone'"));
      let r: Response;
      try { r = await go(); } finally { restore(); }
      expect(await answer(r)).toEqual([400, { error: "bad_role" }]);
    }
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
    expect(await one("SELECT 1 x FROM users WHERE email = 'new@example.com'")).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it("the target's current role gains a key between read and batch: 403, nothing written", async () => {
    await run("UPDATE users SET role_id = 'hl' WHERE id = ?", P.user.id);
    const restore = beforeBatch(1, () => setPerms("hl", ["links.create", "audit"]));
    let r: Response;
    try { r = await patch(M.cookie, P.user.id, { status: "disabled" }); } finally { restore(); }
    expect(await answer(r)).toEqual([403, above]);
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: "hl", status: "active" });
    expect(await audits()).toEqual([]);
  });

  it("the owner removes people.manage from Manager between read and batch: role, status, remove, sign out, invite write nothing", async () => {
    const sessions = await rows("SELECT id FROM sessions WHERE user_id = ?", P.user.id);
    const attempts: (() => Promise<Response>)[] = [
      () => patch(M.cookie, P.user.id, { roleId: "hl" }),
      () => patch(M.cookie, P.user.id, { status: "disabled" }),
      () => call(M.cookie, "DELETE", `/api/users/${P.user.id}`),
      () => call(M.cookie, "DELETE", `/api/users/${P.user.id}/sessions`),
      () => call(M.cookie, "POST", "/api/users/invite", { email: "new@example.com", roleId: "member" }),
    ];
    for (const go of attempts) {
      await setPerms("mg", MANAGER);
      const restore = beforeBatch(1, () => setPerms("mg", MEMBER_DEFAULT));
      let r: Response;
      try { r = await go(); } finally { restore(); }
      expect(await answer(r)).toEqual([403, { error: "forbidden" }]);
    }
    expect(await who(P.user.id)).toEqual({ role: "member", role_id: null, status: "active" });
    expect(await rows("SELECT id FROM sessions WHERE user_id = ?", P.user.id)).toEqual(sessions);
    expect(await one("SELECT 1 x FROM users WHERE email = 'new@example.com'")).toBeNull();
    expect(await audits()).toEqual([]);
  });
});

describe("invites by a people manager", () => {
  const invite = (cookie: string, body: unknown) => call(cookie, "POST", "/api/users/invite", body);
  beforeEach(async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('ds1','team.test','shared','active',?,1)", O.user.id);
  });

  it("roleId member (and the default) 201; a weaker custom role is stored as role_id; audit carries roleId and roleName", async () => {
    expect((await invite(M.cookie, { email: "one@example.com", roleId: "member" })).status).toBe(201);
    expect((await invite(M.cookie, { email: "two@example.com" })).status).toBe(201);
    const r = await invite(M.cookie, { email: "three@example.com", roleId: "hl" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { user: unknown }).user).toMatchObject({ email: "three@example.com", status: "invited", role: "member", roleId: "hl", roleName: "Helper" });
    expect(await rows("SELECT email, role, role_id FROM users WHERE status = 'invited' ORDER BY email")).toEqual([
      { email: "one@example.com", role: "member", role_id: null }, { email: "three@example.com", role: "member", role_id: "hl" }, { email: "two@example.com", role: "member", role_id: null },
    ]);
    expect((await audits("user.invite")).map((a) => a.detail)).toEqual([
      { email: "one@example.com", role: "member", roleId: "member", roleName: "Member", domains: [] },
      { email: "two@example.com", role: "member", roleId: "member", roleName: "Member", domains: [] },
      { email: "three@example.com", role: "member", roleId: "hl", roleName: "Helper", domains: [] },
    ]);
  });

  it("roleId owner or a stronger role is 403 role_above_you; unknown 400 bad_role; nothing created", async () => {
    expect(await answer(await invite(M.cookie, { email: "x@example.com", roleId: "owner" }))).toEqual([403, above]);
    expect(await answer(await invite(M.cookie, { email: "x@example.com", roleId: "st" }))).toEqual([403, above]);
    expect(await answer(await invite(M.cookie, { email: "x@example.com", roleId: "nope" }))).toEqual([400, { error: "bad_role" }]);
    expect(await answer(await invite(M.cookie, { email: "x@example.com", role: "member" }))).toEqual([400, { error: "invalid_body" }]);
    expect(await one("SELECT 1 x FROM users WHERE email = 'x@example.com'")).toBeNull();
  });

  it("domainIds need domains.manage too: 403 forbidden without, 201 with", async () => {
    expect(await answer(await invite(M.cookie, { email: "x@example.com", roleId: "member", domainIds: ["ds1"] }))).toEqual([403, { error: "forbidden" }]);
    expect(await one("SELECT 1 x FROM users WHERE email = 'x@example.com'")).toBeNull();
    await role("md", "Manager plus", [...MANAGER, "domains.manage"]);
    const D = await signedIn("md@example.com", { roleId: "md" });
    expect((await invite(D.cookie, { email: "x@example.com", roleId: "member", domainIds: ["ds1"] })).status).toBe(201);
    expect(await rows("SELECT d.domain_id FROM domain_members d JOIN users u ON u.id = d.user_id WHERE u.email = 'x@example.com'")).toEqual([{ domain_id: "ds1" }]);
  });

  it("domains.manage removed between read and batch: the invite with domains writes nothing", async () => {
    await role("md", "Manager plus", [...MANAGER, "domains.manage"]);
    const D = await signedIn("md@example.com", { roleId: "md" });
    const restore = beforeBatch(1, () => setPerms("md", MANAGER));
    let r: Response;
    try { r = await invite(D.cookie, { email: "x@example.com", roleId: "member", domainIds: ["ds1"] }); } finally { restore(); }
    expect(await answer(r)).toEqual([403, { error: "forbidden" }]);
    expect(await one("SELECT 1 x FROM users WHERE email = 'x@example.com'")).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it("the invited role gains a key between read and batch: 403 role_above_you, nothing written", async () => {
    const restore = beforeBatch(1, () => setPerms("hl", ["links.create", "settings"]));
    let r: Response;
    try { r = await invite(M.cookie, { email: "x@example.com", roleId: "hl" }); } finally { restore(); }
    expect(await answer(r)).toEqual([403, above]);
    expect(await one("SELECT 1 x FROM users WHERE email = 'x@example.com'")).toBeNull();
  });

  it("resend and revoke: an owner invitee or one on a stronger role is out of reach; a member invitee is not", async () => {
    e.EMAIL_FROM = "links@example.com";
    e.RESEND_API_KEY = "re_testkey12345";
    fakeResend();
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('io','io@example.com','owner',NULL,'invited',1), ('ix','ix@example.com','member','st','invited',1), ('im','im@example.com','member',NULL,'invited',1)");
    for (const id of ["io", "ix"]) {
      expect(await answer(await call(M.cookie, "POST", `/api/users/${id}/resend`))).toEqual([403, above]);
      expect(await answer(await call(M.cookie, "DELETE", `/api/users/${id}/invite`))).toEqual([403, above]);
    }
    expect((await call(M.cookie, "POST", "/api/users/im/resend")).status).toBe(200);
    expect((await call(M.cookie, "DELETE", "/api/users/im/invite")).status).toBe(200);
    expect(await rows("SELECT id FROM users WHERE status = 'invited' ORDER BY id")).toEqual([{ id: "io" }, { id: "ix" }]);
  });

  it("the invite mail names a custom role, escaped in HTML", async () => {
    e.EMAIL_FROM = "links@example.com";
    e.RESEND_API_KEY = "re_testkey12345";
    const mail = fakeResend();
    await role("ht", "<b>Ops</b>", ["links.create"]);
    expect((await invite(O.cookie, { email: "x@example.com", roleId: "ht" })).status).toBe(201);
    expect(mail.sent[0]!.text).toContain("You will join with the role <b>Ops</b>.");
    expect(mail.sent[0]!.html).toContain("You will join with the role &lt;b&gt;Ops&lt;/b&gt;.");
    expect(mail.sent[0]!.html).not.toContain("<b>Ops");
  });
});
