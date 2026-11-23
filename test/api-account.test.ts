import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dash } from "./helpers/access";
import { auditStmt } from "../src/audit";
import { signedIn, withCookie } from "./helpers/session";
import { MEMBER_DEFAULT } from "../src/roles";

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  await env.DB.batch(["passkeys", "sessions", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => {
  vi.restoreAllMocks();
  e.AUTH_MODE = origMode;
});

const all = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<Record<string, unknown>>()).results;
const json = { "content-type": "application/json" };
const call = (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  dash(path, withCookie(cookie, { method, headers: { ...(body === undefined ? {} : json), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
const addKey = async (userId: string, name = "Laptop") => {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO passkeys (id,credential_id,user_id,public_key,counter,name,created_at) VALUES (?,?,?,'SECRETPUBKEY',0,?,5)").bind(id, `cred-${id}`, userId, name).run();
  return id;
};
const extraSession = async (userId: string) => {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES (?,?,?, 'email', ?, ?, ?)")
    .bind(id, `hash-${id}`, userId, Math.floor(Date.now() / 1000) - 5, 1, Math.floor(Date.now() / 1000) + 1000).run();
  return id;
};
const sid = async (userId: string) => (await all("SELECT id FROM sessions WHERE user_id = ?", userId)).map((r) => r.id as string);

describe("GET /api/account", () => {
  it("lists own passkeys and live sessions, current only for the cookie's, with no secrets", async () => {
    const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
    const pk = await addKey(a.user.id);
    await addKey(b.user.id, "Theirs");
    const [mine] = await sid(a.user.id);
    const other = await extraSession(a.user.id);
    await env.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES ('old','hold',?, 'email',1,1,2)").bind(a.user.id).run();
    const r = await call(a.cookie, "GET", "/api/account");
    const text = await r.text();
    expect(r.status).toBe(200);
    for (const secret of ["token_hash", "tokenHash", "public_key", "publicKey", "SECRETPUBKEY", a.value]) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { passkeys: { id: string; name: string }[]; sessions: { id: string; current: boolean }[] };
    expect(body.passkeys).toEqual([{ id: pk, name: "Laptop", createdAt: 5, lastUsedAt: null, backedUp: false }]);
    expect(body.sessions.map((s) => s.id).sort()).toEqual([...(await sid(a.user.id))].filter((i) => i !== "old").sort());
    expect(body.sessions.filter((s) => s.current).map((s) => s.id)).toEqual([mine]);
    expect(Object.keys(body.sessions[0]!).sort()).toEqual(["createdAt", "current", "device", "id", "ipPrefix", "lastSeenAt", "method"]);
    expect(body.sessions.map((s) => s.id)).toEqual([mine, other]); // newest first
  });

  it("hides a session older than the absolute lifetime even when its expiry is still ahead", async () => {
    const a = await signedIn("a@example.com");
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES ('stale','hstale',?, 'email',?,?,?)")
      .bind(a.user.id, now - 7_776_001, now, now + 1000).run();
    const r = await call(a.cookie, "GET", "/api/account");
    expect(((await r.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).not.toContain("stale");
  });

  it("needs a session and answers 404 in access mode", async () => {
    expect((await dash("/api/account")).status).toBe(401);
    const a = await signedIn("a@example.com");
    e.AUTH_MODE = "access";
    expect((await call(a.cookie, "GET", "/api/account")).status).toBe(404);
  });
});

describe("rename and remove passkeys", () => {
  it("trims, strips hidden characters, collapses whitespace, audits", async () => {
    const a = await signedIn("a@example.com");
    const pk = await addKey(a.user.id);
    const r = await call(a.cookie, "PATCH", `/api/account/passkeys/${pk}`, { name: "  Work‮  ​lap؜﻿top \n " });
    expect([r.status, await r.json()]).toEqual([200, { id: pk, name: "Work laptop", createdAt: 5, lastUsedAt: null, backedUp: false }]);
    expect(await all("SELECT action, target_id, detail FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([{ action: "passkey.rename", target_id: pk, detail: '{"name":"Work laptop"}' }]);
  });

  it.each([["x".repeat(41)], ["   "], ["‮​"], ["⁠⁤"]])("refuses %j with invalid_name", async (name) => {
    const a = await signedIn("a@example.com");
    const pk = await addKey(a.user.id);
    const r = await call(a.cookie, "PATCH", `/api/account/passkeys/${pk}`, { name });
    expect([r.status, await r.text()]).toEqual([400, '{"error":"invalid_name"}']);
    expect((await call(a.cookie, "PATCH", `/api/account/passkeys/${pk}`, { name: "a", extra: 1 })).status).toBe(400);
    expect(await all("SELECT name FROM passkeys")).toEqual([{ name: "Laptop" }]);
  });

  it("answers 404 for another person's passkey and changes nothing", async () => {
    const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
    const pk = await addKey(b.user.id);
    expect((await call(a.cookie, "PATCH", `/api/account/passkeys/${pk}`, { name: "Mine" })).status).toBe(404);
    expect((await call(a.cookie, "DELETE", `/api/account/passkeys/${pk}`)).status).toBe(404);
    expect(await all("SELECT name FROM passkeys")).toEqual([{ name: "Laptop" }]);
    expect(await all("SELECT * FROM audit_log WHERE action LIKE 'passkey.%'")).toEqual([]);
  });

  it("removes with 204 and one audit row", async () => {
    const a = await signedIn("a@example.com");
    const pk = await addKey(a.user.id), keep = await addKey(a.user.id, "Keep");
    expect((await call(a.cookie, "DELETE", `/api/account/passkeys/${pk}`)).status).toBe(204);
    expect(await all("SELECT id FROM passkeys")).toEqual([{ id: keep }]);
    expect(await all("SELECT action, target_id FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([{ action: "passkey.remove", target_id: pk }]);
    expect((await call(a.cookie, "DELETE", `/api/account/passkeys/${pk}`)).status).toBe(404);
    expect(await all("SELECT * FROM audit_log WHERE action = 'passkey.remove'")).toHaveLength(1);
  });
});

describe("end sessions and sign out", () => {
  it("ends another own session, 404 for someone else's", async () => {
    const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
    const mine = await extraSession(a.user.id);
    const [theirs] = await sid(b.user.id);
    const r = await call(a.cookie, "DELETE", `/api/account/sessions/${mine}`);
    expect([r.status, r.headers.get("set-cookie")]).toEqual([204, null]);
    expect(await all("SELECT action, target_id FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([{ action: "session.end", target_id: mine }]);
    expect((await call(a.cookie, "DELETE", `/api/account/sessions/${theirs}`)).status).toBe(404);
    expect(await sid(b.user.id)).toEqual([theirs]);
    expect(await all("SELECT * FROM audit_log WHERE action != 'auth.sign_in'")).toHaveLength(1);
  });

  it("ending the current session clears the cookie", async () => {
    const a = await signedIn("a@example.com");
    const [cur] = await sid(a.user.id);
    const r = await call(a.cookie, "DELETE", `/api/account/sessions/${cur}`);
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call(a.cookie, "GET", "/api/me")).status).toBe(401);
  });

  it("Review Focus 4: a cross-origin sign-out is refused and the session survives; GET is 404", async () => {
    const a = await signedIn("a@example.com");
    const r = await call(a.cookie, "POST", "/api/account/sign-out", undefined, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await call(a.cookie, "GET", "/api/me")).status).toBe(200);
    expect((await call(a.cookie, "GET", "/api/account/sign-out")).status).toBe(404);
  });

  it("sign-out deletes the session, clears the cookie and audits", async () => {
    const a = await signedIn("a@example.com");
    const [cur] = await sid(a.user.id);
    const r = await call(a.cookie, "POST", "/api/account/sign-out");
    expect([r.status, r.headers.get("set-cookie")]).toEqual([204, "__Host-lw_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"]);
    expect((await call(a.cookie, "GET", "/api/me")).status).toBe(401);
    expect(await all("SELECT action, target_id FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([{ action: "auth.sign_out", target_id: cur }]);
  });

  it("sign-out-everywhere removes all of A's sessions and none of B's", async () => {
    const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
    await extraSession(a.user.id);
    await extraSession(a.user.id);
    const r = await call(a.cookie, "POST", "/api/account/sign-out-everywhere");
    expect([r.status, r.headers.get("set-cookie")]).toEqual([204, expect.stringContaining("Max-Age=0")]);
    expect(await sid(a.user.id)).toEqual([]);
    expect(await sid(b.user.id)).toHaveLength(1);
    expect(await all("SELECT action, detail FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([{ action: "auth.sign_out_all", detail: '{"count":3}' }]);
  });
});

describe("owner ends someone's sessions", () => {
  it("owner: the person's next call is 401 and one audit row records the count", async () => {
    const o = await signedIn("o@example.com", { role: "owner" }), b = await signedIn("b@example.com");
    await extraSession(b.user.id);
    const r = await call(o.cookie, "DELETE", `/api/users/${b.user.id}/sessions`);
    expect(r.status).toBe(204);
    expect((await call(b.cookie, "GET", "/api/me")).status).toBe(401);
    expect(await sid(o.user.id)).toHaveLength(1);
    expect(await all("SELECT actor_id, action, target_type, target_id, detail FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([
      { actor_id: o.user.id, action: "session.end_all", target_type: "user", target_id: b.user.id, detail: '{"count":2}' },
    ]);
  });

  it("a person with no sessions: 204 and no audit row", async () => {
    const o = await signedIn("o@example.com", { role: "owner" }), b = await signedIn("b@example.com");
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(b.user.id).run();
    expect((await call(o.cookie, "DELETE", `/api/users/${b.user.id}/sessions`)).status).toBe(204);
    expect(await all("SELECT * FROM audit_log WHERE action = 'session.end_all'")).toEqual([]);
  });

  it("the owner ending their own sessions clears their cookie; another person's does not", async () => {
    const o = await signedIn("o@example.com", { role: "owner" }), b = await signedIn("b@example.com");
    const other = await call(o.cookie, "DELETE", `/api/users/${b.user.id}/sessions`);
    expect(other.headers.get("set-cookie")).toBeNull();
    const own = await call(o.cookie, "DELETE", `/api/users/${o.user.id}/sessions`);
    expect([own.status, own.headers.get("set-cookie")]).toEqual([204, expect.stringContaining("Max-Age=0")]);
  });

  it("member gets 403, unknown person 404", async () => {
    const o = await signedIn("o@example.com", { role: "owner" }), a = await signedIn("a@example.com");
    const r = await call(a.cookie, "DELETE", `/api/users/${o.user.id}/sessions`);
    expect([r.status, await r.text()]).toEqual([403, '{"error":"forbidden"}']);
    expect(await sid(o.user.id)).toHaveLength(1);
    expect((await call(o.cookie, "DELETE", "/api/users/nobody/sessions")).status).toBe(404);
    expect(await all("SELECT * FROM audit_log WHERE action != 'auth.sign_in'")).toEqual([]);
  });
});

describe("/api/me", () => {
  it("reports authMode and the passkey count in app mode", async () => {
    const a = await signedIn("a@example.com");
    await addKey(a.user.id);
    expect(await (await call(a.cookie, "GET", "/api/me")).json()).toEqual({ id: a.user.id, email: "a@example.com", name: null, role: "member", roleId: "member", roleName: "Member", perms: [...MEMBER_DEFAULT], authMode: "app", passkeys: 1 });
  });
});

describe("audit count", () => {
  it("is counted when the batch runs, so a session added after the statement was built is included", async () => {
    const a = await signedIn("a@example.com");
    const stmt = auditStmt(env, { actorId: a.user.id, action: "auth.sign_out_all", targetType: "user", targetId: a.user.id, count: { sql: "SELECT COUNT(*) FROM sessions WHERE user_id = ?", binds: [a.user.id] } });
    await extraSession(a.user.id);
    await env.DB.batch([stmt]);
    expect(await all("SELECT detail FROM audit_log WHERE action = 'auth.sign_out_all'")).toEqual([{ detail: '{"count":2}' }]);
  });
});
