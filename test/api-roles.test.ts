import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMBER_DEFAULT, PERMS } from "../src/roles";
import { dash } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { signedIn, withCookie } from "./helpers/session";

const mode = env as { AUTH_MODE?: string };
const prevMode = mode.AUTH_MODE;
beforeAll(() => { mode.AUTH_MODE = "app"; });
afterAll(() => { mode.AUTH_MODE = prevMode; });

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const rows = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  dash(path, withCookie(cookie, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const audits = async (action: string) =>
  (await rows("SELECT actor_id, target_id, detail FROM audit_log WHERE action = ? ORDER BY id", action)).map((r) => ({ ...r, detail: JSON.parse(r.detail as string) }));
const role = (id: string, name: string, perms: string[]) =>
  run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, name, JSON.stringify(perms));
const create = async (cookie: string, name: string, perms: string[] = []) => call(cookie, "POST", "/api/roles", { name, perms });
type Item = { id: string; name: string; perms: string[]; builtin: string | null; people: number };

let A: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  await env.DB.batch(["audit_log", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("UPDATE roles SET name = 'Member', perms = ? WHERE id = 'member'", JSON.stringify(MEMBER_DEFAULT));
  A = await signedIn("owner@example.com", { role: "owner" });
});

describe("who may use /api/roles", () => {
  it("member and people.manage holder: 403 on POST, PATCH, DELETE; people.manage gets GET, member does not", async () => {
    await role("pm", "Managers", ["people.manage"]);
    await role("rx", "Editors", ["links.create"]);
    const m = await signedIn("m@example.com");
    const p = await signedIn("p@example.com", { roleId: "pm" });
    for (const who of [m, p]) {
      expect((await create(who.cookie, "New")).status).toBe(403);
      expect((await call(who.cookie, "PATCH", "/api/roles/rx", { name: "Other" })).status).toBe(403);
      expect((await call(who.cookie, "DELETE", "/api/roles/rx", {})).status).toBe(403);
    }
    expect((await call(m.cookie, "GET", "/api/roles")).status).toBe(403);
    // The fixture really stores role_id (helper's roleId option), so this is a people manager, not a plain member.
    expect(await one("SELECT role_id FROM users WHERE id = ?", p.user.id)).toEqual({ role_id: "pm" });
    expect(await (await call(p.cookie, "GET", "/api/me")).json()).toMatchObject({ roleId: "pm", roleName: "Managers", perms: ["people.manage"] });
    const g = await call(p.cookie, "GET", "/api/roles");
    expect(g.status).toBe(200);
    const items = (await g.json()) as Item[];
    expect(items.map((i) => i.id)).toEqual(["owner", "member", "rx", "pm"]);
    expect(items[0]).toEqual({ id: "owner", name: "Owner", perms: [...PERMS], builtin: "owner", people: 1 });
    expect(items[1]).toEqual({ id: "member", name: "Member", perms: [...MEMBER_DEFAULT], builtin: "member", people: 1 });
    expect(items[3]).toEqual({ id: "pm", name: "Managers", perms: ["people.manage"], builtin: null, people: 1 });
    expect(await one("SELECT COUNT(*) n FROM roles WHERE name = 'New'")).toEqual({ n: 0 });
    expect(await one("SELECT name FROM roles WHERE id = 'rx'")).toEqual({ name: "Editors" });
  });
});

describe("create, rename, edit, delete", () => {
  it("each writes one audit row with the R14 detail", async () => {
    const r = await create(A.cookie, "  Editors ", ["keys", "links.create"]);
    expect(r.status).toBe(201);
    const it = (await r.json()) as Item;
    expect(it).toMatchObject({ name: "Editors", perms: ["links.create", "keys"], builtin: null, people: 0 });
    expect(await audits("role.create")).toEqual([{ actor_id: A.user.id, target_id: it.id, detail: { name: "Editors", perms: ["links.create", "keys"] } }]);

    const rn = await call(A.cookie, "PATCH", `/api/roles/${it.id}`, { name: "Writers" });
    expect(rn.status).toBe(200);
    expect(((await rn.json()) as Item).name).toBe("Writers");
    const ed = await call(A.cookie, "PATCH", `/api/roles/${it.id}`, { perms: ["links.create", "audit"] });
    expect(ed.status).toBe(200);
    expect(((await ed.json()) as Item).perms).toEqual(["links.create", "audit"]);
    expect((await audits("role.update")).map((a) => a.detail)).toEqual([
      { name: "Writers", from: "Editors", added: [], removed: [] },
      { name: "Writers", added: ["audit"], removed: ["keys"] },
    ]);

    const d = await call(A.cookie, "DELETE", `/api/roles/${it.id}`, {});
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ moved: 0 });
    expect(await audits("role.delete")).toEqual([{ actor_id: A.user.id, target_id: it.id, detail: { name: "Writers", movedTo: null, people: 0 } }]);
    expect(await one("SELECT 1 x FROM roles WHERE id = ?", it.id)).toBeNull();
  });

  it("owner PATCH 409 owner_fixed; DELETE member 409 builtin; unknown 404; Member can be renamed and edited", async () => {
    expect((await call(A.cookie, "PATCH", "/api/roles/owner", { name: "Boss" })).status).toBe(409);
    expect(await (await call(A.cookie, "PATCH", "/api/roles/owner", { perms: [] })).json()).toEqual({ error: "owner_fixed" });
    const d = await call(A.cookie, "DELETE", "/api/roles/member", {});
    expect(d.status).toBe(409);
    expect(await d.json()).toEqual({ error: "builtin" });
    expect((await call(A.cookie, "DELETE", "/api/roles/owner", {})).status).toBe(409);
    expect((await call(A.cookie, "PATCH", "/api/roles/nope", { name: "X" })).status).toBe(404);
    expect((await call(A.cookie, "DELETE", "/api/roles/nope", {})).status).toBe(404);
    const m = await call(A.cookie, "PATCH", "/api/roles/member", { name: "Staff", perms: ["links.create"] });
    expect(m.status).toBe(200);
    expect(await m.json()).toMatchObject({ id: "member", name: "Staff", perms: ["links.create"], builtin: "member" });
    expect(await rows("SELECT id FROM audit_log WHERE action LIKE 'role.%'")).toHaveLength(1);
  });

  it("empty or unknown body keys 400", async () => {
    expect((await call(A.cookie, "POST", "/api/roles", { name: "X", perms: [], extra: 1 })).status).toBe(400);
    expect((await call(A.cookie, "PATCH", "/api/roles/member", {})).status).toBe(400);
    expect((await call(A.cookie, "DELETE", "/api/roles/member", { moveTo: "owner", x: 1 })).status).toBe(400);
  });
});

describe("names and perms", () => {
  it("refuses Owner and Member names in any case, frees a renamed Member's old name", async () => {
    for (const n of ["owner", " Owner ", "MEMBER"]) {
      const r = await create(A.cookie, n);
      expect(r.status, n).toBe(409);
      expect(await r.json()).toEqual({ error: "name_taken" });
    }
    await role("rx", "Editors", []);
    expect(await (await call(A.cookie, "PATCH", "/api/roles/rx", { name: "editors" })).json()).toMatchObject({ name: "editors" });
    expect((await call(A.cookie, "PATCH", "/api/roles/member", { name: "EDITORS" })).status).toBe(409);
    expect((await call(A.cookie, "PATCH", "/api/roles/member", { name: "Staff" })).status).toBe(200);
    expect((await create(A.cookie, "Member")).status).toBe(201);
    expect(await rows("SELECT id FROM audit_log WHERE action = 'role.create'")).toHaveLength(1);
  });

  it("strips control, bidi and zero-width characters; 1 to 40 characters", async () => {
    const r = await create(A.cookie, "a‮b​");
    expect(r.status).toBe(201);
    expect(((await r.json()) as Item).name).toBe("ab");
    for (const n of ["x".repeat(41), "  ", "‮\u0007"]) {
      const b = await create(A.cookie, n);
      expect(b.status).toBe(400);
      expect(await b.json()).toEqual({ error: "bad_name" });
    }
    expect((await create(A.cookie, "\u{1F600}".repeat(40))).status).toBe(201);
    const nfc = await create(A.cookie, "Caf\u0065\u0301");
    expect(((await nfc.json()) as Item).name).toBe("Caf\u00e9");
    expect(await (await create(A.cookie, "caf\u00e9")).json()).toEqual({ error: "name_taken" });
  });

  it("refuses unknown perm keys, __proto__ included; stores R2 order without duplicates", async () => {
    const r = await create(A.cookie, "X", ["keys", "__proto__"]);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_perms" });
    expect((await call(A.cookie, "PATCH", "/api/roles/member", { perms: ["admin"] })).status).toBe(400);
    const ok = await create(A.cookie, "Y", ["audit", "keys", "audit"]);
    expect(((await ok.json()) as Item).perms).toEqual(["keys", "audit"]);
    expect(await one("SELECT perms FROM roles WHERE name = 'Y'")).toEqual({ perms: '["keys","audit"]' });
  });

  it("at most 20 custom roles", async () => {
    for (let i = 0; i < 20; i++) await role(`r${i}`, `Role ${i}`, []);
    const r = await create(A.cookie, "One more");
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "too_many_roles" });
    expect(await audits("role.create")).toEqual([]);
  });
});

describe("delete a role in use", () => {
  beforeEach(async () => {
    await role("rx", "Editors", ["links.create", "audit"]);
    await role("ry", "Writers", ["links.create"]);
  });

  it("without moveTo: 409 role_in_use with the count, nothing changed", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    await signedIn("p2@example.com", { roleId: "rx" });
    const r = await call(A.cookie, "DELETE", "/api/roles/rx", {});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "role_in_use", people: 2 });
    expect((await call(A.cookie, "DELETE", "/api/roles/rx")).status).toBe(409);
    expect(await one("SELECT COUNT(*) n FROM users WHERE role_id = 'rx'")).toEqual({ n: 2 });
    expect(await audits("role.delete")).toEqual([]);
    expect(await one("SELECT role_id FROM users WHERE id = ?", p1.user.id)).toEqual({ role_id: "rx" });
  });

  it("bad moveTo: owner, itself, unknown, empty: 400 bad_move_to", async () => {
    await signedIn("p1@example.com", { roleId: "rx" });
    for (const moveTo of ["owner", "rx", "nope", ""]) {
      const r = await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo });
      expect(r.status, moveTo).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_move_to" });
    }
    expect(await one("SELECT COUNT(*) n FROM users WHERE role_id = 'rx'")).toEqual({ n: 1 });
  });

  it("moveTo member: both people end on Member (role_id NULL) and get Member perms on their next /api/me", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    const p2 = await signedIn("p2@example.com", { roleId: "rx" });
    const r = await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "member" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ moved: 2 });
    expect(await rows("SELECT role_id FROM users WHERE id IN (?,?)", p1.user.id, p2.user.id)).toEqual([{ role_id: null }, { role_id: null }]);
    for (const p of [p1, p2]) {
      const me = await (await call(p.cookie, "GET", "/api/me")).json();
      expect(me).toMatchObject({ role: "member", roleId: "member", roleName: "Member", perms: [...MEMBER_DEFAULT] });
    }
    expect((await audits("role.delete")).map((a) => a.detail)).toEqual([{ name: "Editors", movedTo: "Member", people: 2 }]);
  });

  it("moveTo a custom role moves them there", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    const r = await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "ry" });
    expect(await r.json()).toEqual({ moved: 1 });
    expect(await one("SELECT role_id FROM users WHERE id = ?", p1.user.id)).toEqual({ role_id: "ry" });
    expect((await audits("role.delete")).map((a) => a.detail)).toEqual([{ name: "Editors", movedTo: "Writers", people: 1 }]);
  });

  it("an empty role deleted with moveTo records movedTo null", async () => {
    expect(await (await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "ry" })).json()).toEqual({ moved: 0 });
    expect((await audits("role.delete")).map((a) => a.detail)).toEqual([{ name: "Editors", movedTo: null, people: 0 }]);
  });

  it("race: the role renamed during DELETE {moveTo}: 409 changed, nobody moved", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    const restore = beforeBatch(1, () => run("UPDATE roles SET name = 'Renamed' WHERE id = 'rx'"));
    try {
      expect(await (await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "member" })).json()).toEqual({ error: "changed" });
    } finally { restore(); }
    expect(await one("SELECT role_id FROM users WHERE id = ?", p1.user.id)).toEqual({ role_id: "rx" });
    expect(await one("SELECT name FROM roles WHERE id = 'rx'")).toEqual({ name: "Renamed" });
    expect(await audits("role.delete")).toEqual([]);
  });

  it("race: a swap in the window (one person off, another on, same count): 409 changed, nobody moved", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    const q = await signedIn("q@example.com");
    const restore = beforeBatch(1, () => env.DB.batch([
      env.DB.prepare("UPDATE users SET role_id = NULL WHERE id = ?").bind(p1.user.id),
      env.DB.prepare("UPDATE users SET role_id = 'rx' WHERE id = ?").bind(q.user.id),
    ]));
    try {
      expect(await (await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "ry" })).json()).toEqual({ error: "changed" });
    } finally { restore(); }
    expect(await one("SELECT role_id FROM users WHERE id = ?", q.user.id)).toEqual({ role_id: "rx" });
    expect(await one("SELECT role_id FROM users WHERE id = ?", p1.user.id)).toEqual({ role_id: null });
    expect(await audits("role.delete")).toEqual([]);
  });

  it("race: the role or the target deleted in the window: 404, bad_move_to", async () => {
    await signedIn("p1@example.com", { roleId: "rx" });
    let restore = beforeBatch(1, () => run("DELETE FROM roles WHERE id = 'ry'"));
    try {
      expect(await (await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "ry" })).json()).toEqual({ error: "bad_move_to" });
    } finally { restore(); }
    await role("rz", "Empty", []);
    restore = beforeBatch(1, () => run("DELETE FROM roles WHERE id = 'rz'"));
    try {
      expect((await call(A.cookie, "DELETE", "/api/roles/rz", {})).status).toBe(404);
    } finally { restore(); }
    expect(await audits("role.delete")).toEqual([]);
  });

  it("race: a person assigned between the pre-read and the batch makes the delete 409 changed, nothing changed", async () => {
    const q = await signedIn("q@example.com");
    const restore = beforeBatch(1, () => run("UPDATE users SET role_id = 'rx' WHERE id = ?", q.user.id));
    try {
      const r = await call(A.cookie, "DELETE", "/api/roles/rx", {});
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "changed" });
    } finally { restore(); }
    expect(await one("SELECT name FROM roles WHERE id = 'rx'")).toEqual({ name: "Editors" });
    expect(await one("SELECT role_id FROM users WHERE id = ?", q.user.id)).toEqual({ role_id: "rx" });
    expect(await audits("role.delete")).toEqual([]);
  });

  it("race with moveTo: a person added in the window keeps everyone on the role, 409 changed", async () => {
    const p1 = await signedIn("p1@example.com", { roleId: "rx" });
    const q = await signedIn("q@example.com");
    const restore = beforeBatch(1, () => run("UPDATE users SET role_id = 'rx' WHERE id = ?", q.user.id));
    try {
      expect(await (await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "member" })).json()).toEqual({ error: "changed" });
    } finally { restore(); }
    expect(await rows("SELECT role_id FROM users WHERE id IN (?,?)", p1.user.id, q.user.id)).toEqual([{ role_id: "rx" }, { role_id: "rx" }]);
    expect(await audits("role.delete")).toEqual([]);
  });

  it("the actor demoted in the window: 403, nothing changed", async () => {
    await signedIn("o2@example.com", { role: "owner" });
    await signedIn("p1@example.com", { roleId: "rx" });
    const restore = beforeBatch(1, () => run("UPDATE users SET role = 'member' WHERE id = ?", A.user.id));
    try {
      expect((await call(A.cookie, "DELETE", "/api/roles/rx", { moveTo: "member" })).status).toBe(403);
    } finally { restore(); }
    expect(await one("SELECT COUNT(*) n FROM users WHERE role_id = 'rx'")).toEqual({ n: 1 });
  });
});

describe("concurrent edits", () => {
  it("a perms PATCH lands before a name-only PATCH's batch: the rename is 409 changed, perms are not restored", async () => {
    await role("rx", "Editors", ["links.create"]);
    const restore = beforeBatch(1, () => run(`UPDATE roles SET perms = '["keys"]' WHERE id = 'rx'`));
    try {
      expect(await (await call(A.cookie, "PATCH", "/api/roles/rx", { name: "Writers" })).json()).toEqual({ error: "changed" });
    } finally { restore(); }
    expect(await one("SELECT name, perms FROM roles WHERE id = 'rx'")).toEqual({ name: "Editors", perms: '["keys"]' });
    expect(await audits("role.update")).toEqual([]);
  });

  it("PATCH: the new name taken or the role deleted in the window: 409 name_taken, 404", async () => {
    await role("rx", "Editors", []);
    let restore = beforeBatch(1, () => role("ry", "Writers", []));
    try {
      expect(await (await call(A.cookie, "PATCH", "/api/roles/rx", { name: "writers" })).json()).toEqual({ error: "name_taken" });
    } finally { restore(); }
    restore = beforeBatch(1, () => run("DELETE FROM roles WHERE id = 'rx'"));
    try {
      expect((await call(A.cookie, "PATCH", "/api/roles/rx", { name: "Other" })).status).toBe(404);
    } finally { restore(); }
    expect(await audits("role.update")).toEqual([]);
  });

  it("POST: the name taken or the 20th role made in the window: 409 name_taken, too_many_roles", async () => {
    let restore = beforeBatch(1, () => role("ry", "Writers", []));
    try {
      expect(await (await create(A.cookie, "WRITERS")).json()).toEqual({ error: "name_taken" });
    } finally { restore(); }
    for (let i = 0; i < 18; i++) await role(`r${i}`, `Role ${i}`, []);
    restore = beforeBatch(1, () => role("r19", "Role 19", []));
    try {
      const r = await create(A.cookie, "Twenty-first");
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "too_many_roles" });
    } finally { restore(); }
    expect(await audits("role.create")).toEqual([]);
  });

  it("two PATCHes on the same role: one wins, the other 409 changed with nothing written", async () => {
    await role("rx", "Editors", ["links.create"]);
    let inner: Response | undefined;
    const restore = beforeBatch(1, async () => { inner = await call(A.cookie, "PATCH", "/api/roles/rx", { perms: ["keys"] }); });
    let outer: Response;
    try { outer = await call(A.cookie, "PATCH", "/api/roles/rx", { perms: ["audit"] }); } finally { restore(); }
    expect(inner!.status).toBe(200);
    expect(outer.status).toBe(409);
    expect(await outer.json()).toEqual({ error: "changed" });
    expect(await one("SELECT perms FROM roles WHERE id = 'rx'")).toEqual({ perms: '["keys"]' });
    expect((await audits("role.update")).map((a) => a.detail)).toEqual([{ name: "Editors", added: ["keys"], removed: ["links.create"] }]);
  });
});
