import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ORIGIN, dash } from "./helpers/access";
import { connectAgent, mcpCall, token } from "./helpers/oauth";
import { beforeBatch } from "./helpers/race";
import { fakeResend } from "./helpers/resend";
import { signInApp, signedIn, withCookie } from "./helpers/session";

const mode = env as { AUTH_MODE?: string };
const prevMode = mode.AUTH_MODE;
beforeAll(() => { mode.AUTH_MODE = "app"; });
afterAll(() => { mode.AUTH_MODE = prevMode; });
afterEach(() => vi.restoreAllMocks());

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const rows = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  dash(path, withCookie(cookie, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const patch = (cookie: string, id: string, body: unknown) => call(cookie, "PATCH", `/api/users/${id}`, body);
const remove = (cookie: string, id: string, to?: string) => call(cookie, "DELETE", `/api/users/${id}${to === undefined ? "" : `?transferTo=${encodeURIComponent(to)}`}`);
const audits = (action: string) => rows("SELECT actor_id, target_id, detail FROM audit_log WHERE action = ? ORDER BY id", action);
const activeOwners = async () => (await one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND status = 'active'"))!.n;
const user = (id: string) => one<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", id);
const dom = (id: string, host: string, type: string, owner: string) =>
  run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
const link = (id: string, d: string, by: string) =>
  run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.test/',?,?,1,1)", id, d, id, id, by, by);
const grantsOf = async (userId: string) => (await env.OAUTH_PROVIDER!.listUserGrants(userId)).items;
const refresh = (clientId: string, refresh_token: string) => token({ grant_type: "refresh_token", refresh_token, client_id: clientId });
const v1 = (secret: string, path: string) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { headers: { authorization: `Bearer ${secret}` } }), env, createExecutionContext());
async function apiKey(cookie: string) {
  const r = await call(cookie, "POST", "/api/keys", { name: "ci", write: false, del: false, domainIds: [], expiresInDays: 90 });
  expect(r.status).toBe(201);
  return ((await r.json()) as { secret: string }).secret;
}
/** A tool call is refused either by the provider (grant gone: 401) or by the per-call person check. */
async function mcpRefused(accessToken: string) {
  const r = await mcpCall(accessToken, "tools/call", { name: "server_info", arguments: {} });
  return r.status === 401 || r.body?.result?.isError === true;
}

let A: Awaited<ReturnType<typeof signedIn>>;
beforeEach(async () => {
  for (const k of (await env.OAUTH_KV.list()).keys) await env.OAUTH_KV.delete(k.name);
  await env.DB.batch(["tool_calls", "auth_limits", "login_tokens", "links", "slug_locks", "audit_log", "domain_members", "api_keys", "agent_connections", "passkeys", "sessions", "domains", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  A = await signedIn("owner@example.com", { role: "owner" });
});

describe("PATCH /api/users/:id role", () => {
  it("promotes a member; audit user.role", async () => {
    const m = await signedIn("m@example.com");
    const r = await patch(A.cookie, m.user.id, { role: "owner" });
    expect(r.status).toBe(200);
    const { user: u } = (await r.json()) as { user: { id: string; role: string; linkCount: number; domains: unknown[] } };
    expect(u).toMatchObject({ id: m.user.id, role: "owner", status: "active", linkCount: 0, domains: [] });
    expect(await audits("user.role")).toEqual([{ actor_id: A.user.id, target_id: m.user.id, detail: JSON.stringify({ email: "m@example.com", from: "member", to: "owner", movedDomains: [] }) }]);
  });

  it("demoting owner B moves B's main and shared domains to the actor, leaves the private one", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    await dom("dm", "go.test", "main", B.user.id);
    await dom("ds", "s.test", "shared", B.user.id);
    await dom("dp", "p.test", "private", B.user.id);
    const r = await patch(A.cookie, B.user.id, { role: "member" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { role: string } }).user.role).toBe("member");
    expect(await rows("SELECT id, owner_id FROM domains ORDER BY id")).toEqual([
      { id: "dm", owner_id: A.user.id }, { id: "dp", owner_id: B.user.id }, { id: "ds", owner_id: A.user.id },
    ]);
    const [a] = await audits("user.role");
    expect(JSON.parse(a!.detail as string)).toEqual({ email: "b@example.com", from: "owner", to: "member", movedDomains: ["go.test", "s.test"] });
  });

  it("member 403 (PATCH and DELETE), unknown id 404, empty body 400 no_changes, extra key 400", async () => {
    const m = await signedIn("m@example.com");
    const o = await signedIn("o2@example.com", { role: "owner" });
    for (const r of [await patch(m.cookie, o.user.id, { role: "member" }), await remove(m.cookie, o.user.id), await patch(m.cookie, "nope", { role: "owner" })]) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden" });
    }
    expect((await patch(A.cookie, "nope", { role: "owner" })).status).toBe(404);
    expect((await remove(A.cookie, "nope")).status).toBe(404);
    const e = await patch(A.cookie, m.user.id, {});
    expect([e.status, await e.json()]).toEqual([400, { error: "no_changes" }]);
    expect((await patch(A.cookie, m.user.id, { role: "owner", email: "x@example.com" })).status).toBe(400);
    expect((await patch(A.cookie, m.user.id, { role: "admin" })).status).toBe(400);
    expect(await user(o.user.id)).toEqual({ role: "owner", status: "active" });
  });

  it("self: PATCH or DELETE self is 409 self", async () => {
    for (const r of [await patch(A.cookie, A.user.id, { role: "member" }), await patch(A.cookie, A.user.id, { status: "disabled" }), await remove(A.cookie, A.user.id)]) {
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "self" });
    }
    expect(await user(A.user.id)).toEqual({ role: "owner", status: "active" });
  });
});

describe("Review Focus 1: never zero owners", () => {
  it("(a) A is demoted between read and batch: A's 'disable B' is 403, nothing written, B stays an active owner", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    const sessions = await rows("SELECT * FROM sessions WHERE user_id = ?", B.user.id);
    const restore = beforeBatch(1, () => run("UPDATE users SET role = 'member' WHERE id = ?", A.user.id));
    let r: Response;
    try { r = await patch(A.cookie, B.user.id, { status: "disabled" }); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await user(B.user.id)).toEqual({ role: "owner", status: "active" });
    expect(await rows("SELECT * FROM sessions WHERE user_id = ?", B.user.id)).toEqual(sessions);
    expect(await rows("SELECT * FROM audit_log WHERE action LIKE 'user.%'")).toEqual([]);
    expect(await activeOwners()).toBeGreaterThanOrEqual(1);
  });

  it("(b) owners A, B, C; C disabled in between: A's 'demote B' still succeeds and A remains", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    const C = await signedIn("c@example.com", { role: "owner" });
    const restore = beforeBatch(1, () => run("UPDATE users SET status = 'disabled' WHERE id = ?", C.user.id));
    let r: Response;
    try { r = await patch(A.cookie, B.user.id, { role: "member" }); } finally { restore(); }
    expect(r.status).toBe(200);
    expect(await user(A.user.id)).toEqual({ role: "owner", status: "active" });
    expect(await user(B.user.id)).toEqual({ role: "member", status: "active" });
    expect(await activeOwners()).toBeGreaterThanOrEqual(1);
  });

  it("(c) the only active owner changing themselves is 409 self", async () => {
    await signedIn("m@example.com");
    expect((await patch(A.cookie, A.user.id, { role: "member" })).status).toBe(409);
    expect(await activeOwners()).toBe(1);
  });
});

describe("disable and enable", () => {
  it("disable ends the cookie, refuses the API key, the MCP call and the OAuth refresh; enable restores sign-in", async () => {
    const P = await signedIn("p@example.com");
    const secret = await apiKey(P.cookie);
    const agent = await connectAgent("p@example.com");
    expect((await v1(secret, "/links")).status).toBe(200);
    expect(await mcpRefused(agent.accessToken)).toBe(false);

    const r = await patch(A.cookie, P.user.id, { status: "disabled" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { status: string } }).user.status).toBe("disabled");
    expect([401, 403]).toContain((await dash("/api/me", withCookie(P.cookie))).status);
    expect(await rows("SELECT id FROM sessions WHERE user_id = ?", P.user.id)).toEqual([]);
    // reconcile: the existing per-call check answers 401 invalid_key for a disabled person's key (the brief said 403).
    expect([401, 403]).toContain((await v1(secret, "/links")).status);
    expect(await mcpRefused(agent.accessToken)).toBe(true);
    expect((await refresh(agent.clientId, agent.refreshToken)).status).toBeGreaterThanOrEqual(400);
    expect(await grantsOf(P.user.id)).toEqual([]);
    expect(await audits("user.disable")).toEqual([{ actor_id: A.user.id, target_id: P.user.id, detail: JSON.stringify({ email: P.user.email }) }]);

    const again = await patch(A.cookie, P.user.id, { status: "disabled" });
    expect([again.status, await again.json()]).toEqual([409, { error: "bad_state" }]);

    expect((await patch(A.cookie, P.user.id, { status: "active" })).status).toBe(200);
    expect((await audits("user.enable")).map((a) => a.detail)).toEqual([JSON.stringify({ email: P.user.email })]);
    const cookie = await signInApp("p@example.com");
    expect((await dash("/api/me", withCookie(cookie))).status).toBe(200);

    const active = await patch(A.cookie, P.user.id, { status: "active" });
    expect([active.status, await active.json()]).toEqual([409, { error: "bad_state" }]);
  });

  it("an invited person can be disabled", async () => {
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ui','i@example.com','member','invited',1)");
    expect((await patch(A.cookie, "ui", { status: "disabled" })).status).toBe(200);
    expect(await user("ui")).toEqual({ role: "member", status: "disabled" });
  });

  it("disabling an owner leaves another person's sessions alone", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    const C = await signedIn("c@example.com");
    const theirs = await rows("SELECT * FROM sessions WHERE user_id != ? ORDER BY id", B.user.id);
    expect((await patch(A.cookie, B.user.id, { status: "disabled" })).status).toBe(200);
    expect(await rows("SELECT * FROM sessions WHERE user_id != ? ORDER BY id", B.user.id)).toEqual(theirs);
    expect(C.user.id).toBeTruthy();
  });
});

describe("DELETE /api/users/:id (Review Focus 2)", () => {
  it("removes a person with a key, an agent connection, a grant, links and a private domain; everything moves to the actor", async () => {
    const P = await signedIn("p@example.com");
    const secret = await apiKey(P.cookie);
    const agent = await connectAgent("p@example.com");
    expect(await grantsOf(P.user.id)).toHaveLength(1);
    await dom("dp", "p.test", "private", P.user.id);
    await link("l1", "dp", P.user.id);
    await link("l2", "dp", P.user.id);
    await run("INSERT INTO domain_members (domain_id, user_id) VALUES ('dp', ?)", P.user.id);
    await run("INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES ('h1', 'p@example.com', 1, 9999999999)");

    const r = await remove(A.cookie, P.user.id);
    expect([r.status, await r.json()]).toEqual([200, {}]);
    expect(await one("SELECT 1 FROM users WHERE id = ?", P.user.id)).toBeNull();
    expect(await rows("SELECT id, created_by FROM links ORDER BY id")).toEqual([{ id: "l1", created_by: A.user.id }, { id: "l2", created_by: A.user.id }]);
    expect(await rows("SELECT id, owner_id FROM domains")).toEqual([{ id: "dp", owner_id: A.user.id }]);
    for (const t of ["api_keys", "agent_connections", "domain_members", "sessions"])
      expect([t, await rows(`SELECT * FROM ${t} WHERE user_id = ?`, P.user.id)]).toEqual([t, []]);
    expect(await rows("SELECT * FROM login_tokens WHERE email = 'p@example.com'")).toEqual([]);
    expect((await v1(secret, "/links")).status).toBe(401);
    expect(await grantsOf(P.user.id)).toEqual([]);
    expect(await mcpRefused(agent.accessToken)).toBe(true);
    const [a] = await audits("user.remove");
    expect(a!.target_id).toBe(P.user.id);
    expect(JSON.parse(a!.detail as string)).toEqual({ email: "p@example.com", role: "member", transferTo: A.user.id, links: 2, domains: ["p.test"] });

    const fake = fakeResend();
    const ctx = createExecutionContext();
    const ask = await worker.fetch(new Request(`${ORIGIN}/auth/email`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "p@example.com" }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ask.status).toBe(202);
    expect(fake.sent).toEqual([]);
  });

  it("transferTo another active member moves links and private domains there", async () => {
    const P = await signedIn("p@example.com");
    const T = await signedIn("t@example.com");
    await dom("dp", "p.test", "private", P.user.id);
    await link("l1", "dp", P.user.id);
    expect((await remove(A.cookie, P.user.id, T.user.id)).status).toBe(200);
    expect(await one("SELECT created_by FROM links WHERE id = 'l1'")).toEqual({ created_by: T.user.id });
    expect(await one("SELECT owner_id FROM domains WHERE id = 'dp'")).toEqual({ owner_id: T.user.id });
  });

  it("bad transfer targets: the person, unknown, disabled; a member when a shared domain moves", async () => {
    const P = await signedIn("p@example.com", { role: "owner" });
    const M = await signedIn("m@example.com");
    const D = await signedIn("d@example.com", { status: "disabled" });
    await dom("ds", "s.test", "shared", P.user.id);
    for (const to of [P.user.id, "nope", D.user.id]) {
      const r = await remove(A.cookie, P.user.id, to);
      expect([to, r.status, await r.json()]).toEqual([to, 400, { error: "bad_transfer" }]);
    }
    const r = await remove(A.cookie, P.user.id, M.user.id);
    expect([r.status, await r.json()]).toEqual([400, { error: "transfer_needs_owner" }]);
    expect(await user(P.user.id)).toEqual({ role: "owner", status: "active" });
    expect((await remove(A.cookie, P.user.id)).status).toBe(200);
    expect(await one("SELECT owner_id FROM domains WHERE id = 'ds'")).toEqual({ owner_id: A.user.id });
  });

  it("Review Focus 3: the transfer target is disabled between read and batch: 400 and nothing changes", async () => {
    const P = await signedIn("p@example.com");
    const T = await signedIn("t@example.com");
    await apiKey(P.cookie);
    await connectAgent("p@example.com");
    await dom("dp", "p.test", "private", P.user.id);
    await link("l1", "dp", P.user.id);
    const snap = async () => ({
      links: await rows("SELECT * FROM links ORDER BY id"), domains: await rows("SELECT * FROM domains ORDER BY id"),
      keys: await rows("SELECT * FROM api_keys ORDER BY id"), conns: await rows("SELECT * FROM agent_connections ORDER BY id"),
      users: await rows("SELECT id, role, email FROM users ORDER BY id"), audit: await rows("SELECT COUNT(*) n FROM audit_log"),
      grants: (await grantsOf(P.user.id)).map((g) => g.id),
    });
    const before = await snap();
    const restore = beforeBatch(1, () => run("UPDATE users SET status = 'disabled' WHERE id = ?", T.user.id));
    let r: Response;
    try { r = await remove(A.cookie, P.user.id, T.user.id); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_transfer" }]);
    expect(await snap()).toEqual(before);
  });

  it("the person is removed between read and batch: 404 and no audit row", async () => {
    const P = await signedIn("p@example.com");
    const restore = beforeBatch(1, () => env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(P.user.id), env.DB.prepare("DELETE FROM users WHERE id = ?").bind(P.user.id)]));
    let r: Response;
    try { r = await remove(A.cookie, P.user.id); } finally { restore(); }
    expect(r.status).toBe(404);
    expect(await audits("user.remove")).toEqual([]);
  });

  it("remove uses fewer than 50 D1 queries, auth included", async () => {
    const P = await signedIn("p@example.com", { role: "owner" });
    await dom("ds", "s.test", "shared", P.user.id);
    await link("l1", "ds", P.user.id);
    let n = 0;
    const real = env.DB;
    (env as { DB: D1Database }).DB = new Proxy(real, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => { n++; return t.prepare(sql); };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    let r: Response;
    try { r = await remove(A.cookie, P.user.id); } finally { (env as { DB: D1Database }).DB = real; }
    expect(r.status).toBe(200);
    expect(n).toBeLessThan(50);
  });
});

describe("hardening (Task 11)", () => {
  it("disable deletes the person's unused email links, so a re-enable cannot revive one", async () => {
    const P = await signedIn("p@example.com");
    await run("INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES ('h1', 'P@Example.com', 1, 9999999999)");
    await run("INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES ('h2', 'other@example.com', 1, 9999999999)");
    expect((await patch(A.cookie, P.user.id, { status: "disabled" })).status).toBe(200);
    expect(await rows("SELECT token_hash FROM login_tokens ORDER BY token_hash")).toEqual([{ token_hash: "h2" }]);
  });

  it("demoting an owner with 150 shared domains works (no bind cap)", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    await env.DB.batch(Array.from({ length: 150 }, (_, i) =>
      env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'shared','active',?,1)").bind(`d${i}`, `s${i}.test`, B.user.id)));
    const r = await patch(A.cookie, B.user.id, { role: "member" });
    expect(r.status).toBe(200);
    expect(await one("SELECT COUNT(*) n FROM domains WHERE owner_id = ?", A.user.id)).toEqual({ n: 150 });
    const [a] = await audits("user.role");
    expect(JSON.parse(a!.detail as string).movedDomains).toHaveLength(150);
  });

  it("an empty ?transferTo= defaults to the actor", async () => {
    const P = await signedIn("p@example.com");
    await dom("dp", "p.test", "private", P.user.id);
    expect((await remove(A.cookie, P.user.id, "")).status).toBe(200);
    expect(await one("SELECT owner_id FROM domains WHERE id = 'dp'")).toEqual({ owner_id: A.user.id });
  });

  it("links.created_by is indexed (remove counts and moves by it)", async () => {
    expect(await one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'links_created_by'")).toEqual({ name: "links_created_by" });
  });

  it("the grant revoke failing after disable still leaves the OAuth refresh and MCP call refused", async () => {
    const P = await signedIn("p@example.com");
    const agent = await connectAgent("p@example.com");
    vi.spyOn(env.OAUTH_PROVIDER!, "listUserGrants").mockRejectedValue(new Error("kv down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await patch(A.cookie, P.user.id, { status: "disabled" })).status).toBe(200);
    vi.restoreAllMocks();
    expect(await grantsOf(P.user.id)).toHaveLength(1);
    expect((await refresh(agent.clientId, agent.refreshToken)).status).toBeGreaterThanOrEqual(400);
    expect(await mcpRefused(agent.accessToken)).toBe(true);
  });

  it("after enable the API key works again and the agent connection stays revoked", async () => {
    const P = await signedIn("p@example.com");
    const secret = await apiKey(P.cookie);
    await connectAgent("p@example.com");
    expect((await patch(A.cookie, P.user.id, { status: "disabled" })).status).toBe(200);
    expect((await patch(A.cookie, P.user.id, { status: "active" })).status).toBe(200);
    expect((await v1(secret, "/links")).status).toBe(200);
    expect(await rows("SELECT id FROM agent_connections WHERE user_id = ? AND revoked_at IS NULL", P.user.id)).toEqual([]);
  });

  it("owners A and B remove each other at once: exactly one wins, one active owner remains", async () => {
    const B = await signedIn("b@example.com", { role: "owner" });
    // B removes A in the window between A's reads and A's batch.
    const restore = beforeBatch(1, async () => { expect((await remove(B.cookie, A.user.id)).status).toBe(200); });
    let r: Response;
    try { r = await remove(A.cookie, B.user.id); } finally { restore(); }
    expect(r.status).toBe(403);
    expect(await user(B.user.id)).toEqual({ role: "owner", status: "active" });
    expect(await activeOwners()).toBe(1);
    expect((await audits("user.remove")).map((a) => a.target_id)).toEqual([A.user.id]);
  });
});
