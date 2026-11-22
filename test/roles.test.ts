import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { v1 } from "../src/api/v1";
import type { Env } from "../src/env";
import { TOOLS } from "../src/mcp/tools";
import { actorCan, can, MEMBER_DEFAULT, parsePerms, PERMS, roleWithin, within, type Perm } from "../src/roles";
import { rowToUser, type UserRow } from "../src/types";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { connectAgent, mcpCall } from "./helpers/oauth";
import { signedIn, signInApp, withCookie } from "./helpers/session";
import { b64uText, softAuthenticator } from "./helpers/webauthn";

const db = env.DB;
const v1Fetch = (path: string, secret: string) => exports.default.fetch(`https://dash.test${path}`, { headers: { authorization: `Bearer ${secret}` } });
const run = (sql: string, ...a: unknown[]) => db.prepare(sql).bind(...a).run();
const msg = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
};
const holds = async (g: { sql: string; binds: unknown[] }) =>
  (await db.prepare(`SELECT ${g.sql} ok`).bind(...g.binds).first<{ ok: number }>())!.ok;
const role = (id: string, name: string, perms: unknown) =>
  run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, name, typeof perms === "string" ? perms : JSON.stringify(perms));
const person = (id: string, r: "owner" | "member", roleId: string | null = null, status = "active") =>
  run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,?,1)", id, `${id}@example.com`, r, roleId, status);

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
beforeAll(setupAccess);
beforeEach(async () => {
  await db.batch(["passkeys", "auth_challenges", "sessions", "login_tokens", "auth_limits", "audit_log", "tool_calls", "api_keys", "agent_connections", "domain_members", "domains", "links", "users"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
});
afterEach(() => {
  vi.restoreAllMocks();
  e.AUTH_MODE = origMode;
});

describe("roles schema", () => {
  it("seeds exactly Owner and Member, built in, Member with the R2 defaults", async () => {
    const rows = (await db.prepare("SELECT id, name, perms, builtin FROM roles ORDER BY id").all<Record<string, unknown>>()).results;
    expect(rows).toEqual([
      { id: "member", name: "Member", perms: JSON.stringify(MEMBER_DEFAULT), builtin: 1 },
      { id: "owner", name: "Owner", perms: "[]", builtin: 1 },
    ]);
    expect(MEMBER_DEFAULT).toEqual(["links.create", "links.bulk", "domains.own", "keys", "agents"]);
  });

  it("refuses role_id on an owner, role_id 'member' or 'owner', and a role in use being deleted", async () => {
    await role("r1", "Editors", ["keys"]);
    await person("c1", "member", "r1");
    expect(await msg(run("UPDATE users SET role = 'owner' WHERE id = 'c1'"))).toContain("role_id");
    expect(await msg(run("UPDATE users SET role_id = 'member' WHERE id = 'c1'"))).toContain("role_id");
    expect(await msg(person("c2", "owner", "r1"))).toContain("role_id");
    expect(await msg(person("c3", "member", "owner"))).toContain("role_id");
    expect(await msg(person("c4", "member", "nope"))).toContain("FOREIGN KEY");
    expect(await msg(run("DELETE FROM roles WHERE id = 'r1'"))).toContain("FOREIGN KEY");
    await run("UPDATE users SET role_id = NULL WHERE id = 'c1'");
    await run("UPDATE users SET role = 'owner' WHERE id = 'c1'");
    await run("DELETE FROM roles WHERE id = 'r1'");
    // Plain owners and members point at the built-in rows only through COALESCE, not the foreign key: deleting one would lock them all out.
    expect(await msg(run("DELETE FROM roles WHERE id = 'owner'"))).toContain("builtin_role");
    expect(await msg(run("DELETE FROM roles WHERE id = 'member'"))).toContain("builtin_role");
    expect(await db.prepare("SELECT COUNT(*) n FROM roles").first()).toEqual({ n: 2 });
  });
});

describe("roles module", () => {
  it("parsePerms keeps known keys once, in R2 order, and fails closed on anything else", () => {
    expect(parsePerms('["keys","nope","keys"]')).toEqual(["keys"]);
    expect(parsePerms('["agents","links.create"]')).toEqual(["links.create", "agents"]);
    expect(parsePerms("{")).toEqual([]);
    expect(parsePerms('{"keys":true}')).toEqual([]);
    expect(parsePerms('"keys"')).toEqual([]);
    expect(parsePerms('["__proto__","toString",1,null,"audit"]')).toEqual(["audit"]);
    expect(parsePerms(null)).toEqual([]);
    expect(parsePerms(["keys"])).toEqual([]);
  });

  const u = (r: UserRow["role"], status: UserRow["status"], perms: readonly Perm[]): UserRow =>
    ({ id: "u", email: "u@example.com", name: null, role: r, status, createdAt: 0, roleId: r, roleName: r, perms });

  it("can: an active owner has everything; others exactly their perms; nobody inactive has anything", () => {
    for (const status of ["active", "disabled", "invited"] as const)
      for (const p of PERMS) {
        expect(can(u("owner", status, []), p)).toBe(status === "active");
        expect(can(u("member", status, MEMBER_DEFAULT), p)).toBe(status === "active" && MEMBER_DEFAULT.includes(p));
        expect(can(u("member", status, ["audit"]), p)).toBe(status === "active" && p === "audit");
      }
  });

  it("within: owner always; others only for subsets of their own perms", () => {
    expect(within([...PERMS], u("owner", "active", []))).toBe(true);
    expect(within([], u("owner", "disabled", []))).toBe(false);
    expect(within([], u("owner", "invited", []))).toBe(false);
    expect(within([], u("member", "disabled", ["keys"]))).toBe(false);
    const m = u("member", "active", ["keys", "audit"]);
    expect(within([], m)).toBe(true);
    expect(within(["audit"], m)).toBe(true);
    expect(within(["audit", "data"], m)).toBe(false);
  });

  it("actorCan: owner without the key yes; a role that loses the key no; a disabled person no", async () => {
    await role("r1", "Auditors", ["audit", "keys"]);
    await person("o1", "owner");
    await person("c1", "member", "r1");
    await person("m1", "member");
    await person("d1", "member", "r1", "disabled");
    expect(await holds(actorCan("o1", "audit"))).toBe(1);
    expect(await holds(actorCan("c1", "audit"))).toBe(1);
    expect(await holds(actorCan("m1", "keys"))).toBe(1);
    expect(await holds(actorCan("m1", "audit"))).toBe(0);
    expect(await holds(actorCan("d1", "audit"))).toBe(0);
    expect(await holds(actorCan("nobody", "audit"))).toBe(0);
    await run("UPDATE roles SET perms = '[\"keys\"]' WHERE id = 'r1'");
    expect(await holds(actorCan("c1", "audit"))).toBe(0);
    await run("UPDATE roles SET perms = '{' WHERE id = 'r1'"); // tampered: no permissions, not an error
    expect(await holds(actorCan("c1", "keys"))).toBe(0);
    expect(actorCan("c1", "audit").sql).not.toContain("audit"); // bound, never interpolated
  });

  it("roleWithin: an owner actor any role; others never Owner and never a role with a key they lack", async () => {
    await role("big", "Big", ["audit", "keys"]);
    await role("small", "Small", ["audit"]);
    await role("other", "Other", ["audit", "data"]);
    await role("none", "Nothing", []);
    await person("o1", "owner");
    await person("od", "owner", null, "disabled");
    await person("c1", "member", "big");
    await person("cd", "member", "big", "disabled");
    for (const r of ["owner", "member", "big", "other"]) expect(await holds(roleWithin(r, "o1"))).toBe(1);
    expect(await holds(roleWithin("small", "od"))).toBe(0);
    expect(await holds(roleWithin("owner", "c1"))).toBe(0);
    expect(await holds(roleWithin("small", "c1"))).toBe(1);
    expect(await holds(roleWithin("big", "c1"))).toBe(1);
    expect(await holds(roleWithin("none", "c1"))).toBe(1);
    expect(await holds(roleWithin("other", "c1"))).toBe(0);
    expect(await holds(roleWithin("member", "c1"))).toBe(0);
    expect(await holds(roleWithin("small", "cd"))).toBe(0);
    expect(await holds(roleWithin("missing", "c1"))).toBe(0);
    await run(`UPDATE roles SET perms = '["audit", null]' WHERE id = 'big'`); // tampered: a JSON null must not make every key look held
    expect(await holds(roleWithin("other", "c1"))).toBe(0);
    expect(await holds(roleWithin("small", "c1"))).toBe(1);
  });

  it("rowToUser fails closed without the role join", () => {
    expect(() => rowToUser({ id: "x", email: "x@example.com", role: "member", status: "active", created_at: 1 })).toThrow("user row without role join");
  });
});

describe("every auth path loads the role with the user", () => {
  const PERMS_X: Perm[] = ["links.editAny", "keys", "agents"];
  const custom = async (email: string) => {
    await role("rx", "Editors", ["agents", "links.editAny", "keys", "bogus"]);
    await run("UPDATE users SET role_id = 'rx' WHERE email = ?", email);
  };
  const expectEditor = (me: Record<string, unknown>) =>
    expect(me).toMatchObject({ role: "member", roleId: "rx", roleName: "Editors", perms: PERMS_X });
  /** No query reads roles on its own: the role always comes in the user's own query. */
  const noRoleQuery = (prep: { mock: { calls: unknown[][] } }) =>
    expect(prep.mock.calls.map(([sql]) => String(sql)).filter((sql) => /\broles\b/.test(sql) && !/JOIN roles/.test(sql))).toEqual([]);

  it("session cookie: /api/me", async () => {
    e.AUTH_MODE = "app";
    await role("rx", "Editors", ["agents", "links.editAny", "keys"]);
    const { cookie } = await signedIn("s@example.com", { roleId: "rx" });
    const prep = vi.spyOn(env.DB, "prepare");
    const me = await (await dash("/api/me", withCookie(cookie))).json<Record<string, unknown>>();
    expectEditor(me);
    noRoleQuery(prep);
  });

  it("Access JWT: /api/me, and an owner gets every key", async () => {
    await person("o1", "owner");
    await person("j1", "member");
    await custom("j1@example.com");
    const prep = vi.spyOn(env.DB, "prepare");
    expectEditor(await (await dash("/api/me", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("j1@example.com") } })).json());
    noRoleQuery(prep);
    expect(await (await dash("/api/me", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("o1@example.com") } })).json())
      .toMatchObject({ role: "owner", roleId: "owner", roleName: "Owner", perms: [...PERMS] });
  });

  it("passkey sign-in", async () => {
    e.AUTH_MODE = "app";
    const cookie = await signInApp("pk@example.com");
    vi.restoreAllMocks();
    const post = (path: string, body: unknown, c?: string) => dash(path, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9", ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body),
    });
    const dev = softAuthenticator();
    const reg = await post("/api/account/passkeys/options", {}, cookie);
    expect((await post("/api/account/passkeys", { response: await dev.register(await reg.json()) }, cookie)).status).toBe(201);
    await custom("pk@example.com");
    const id = (await db.prepare("SELECT id FROM users WHERE email = 'pk@example.com'").first<{ id: string }>())!.id;
    const opts = await (await post("/auth/passkey/options", {})).json();
    const prep = vi.spyOn(env.DB, "prepare");
    const r = await post("/auth/passkey/verify", { response: await dev.authenticate(opts as never, { userHandle: b64uText(id) }) });
    expect(r.status).toBe(200);
    const fresh = /^([^;]*)/.exec(r.headers.get("set-cookie") ?? "")![1]!;
    expectEditor(await (await dash("/api/me", withCookie(fresh))).json());
    noRoleQuery(prep);
  });

  it("API key: the v1 principal", async () => {
    await person("k1", "member");
    await custom("k1@example.com");
    const made = await dash("/api/keys", {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor("k1@example.com"), "content-type": "application/json" },
      body: JSON.stringify({ name: "ci", write: false, del: false, domainIds: [], expiresInDays: 90 }),
    });
    expect(made.status).toBe(201);
    const { secret } = await made.json<{ secret: string }>();
    // v1's catch-all 404 is registered before any route a test could add, so the probe reuses v1's own first handler
    // (the Bearer key middleware) in front of a route that echoes the principal.
    const auth = v1.routes[0]!;
    expect([auth.method, auth.path]).toEqual(["ALL", "/*"]);
    const probe = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();
    probe.use("*", auth.handler as MiddlewareHandler);
    probe.get("/p", (c) => c.json(c.var.user));
    const prep = vi.spyOn(env.DB, "prepare");
    const ctx = createExecutionContext();
    const r = await probe.fetch(new Request("https://dash.test/p", { headers: { authorization: `Bearer ${secret}` } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(200);
    expectEditor(await r.json());
    noRoleQuery(prep);
    expect((await v1Fetch("/api/v1/links", secret)).status).toBe(200);
  });

  it("MCP: principalFor", async () => {
    await person("a1", "member");
    await custom("a1@example.com");
    const { accessToken } = await connectAgent("a1@example.com");
    TOOLS.__probe = { description: "probe", input: z.strictObject({}), run: async (_api, _a, p) => ({ ...p.user }) };
    try {
      const prep = vi.spyOn(env.DB, "prepare");
      const r = await mcpCall(accessToken, "tools/call", { name: "__probe", arguments: {} });
      expectEditor(r.body.result.structuredContent);
      noRoleQuery(prep);
    } finally {
      delete TOOLS.__probe;
    }
  });
});
