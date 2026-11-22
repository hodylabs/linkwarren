import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ORIGIN, dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signedIn, withCookie } from "./helpers/session";

const e = env as unknown as Record<string, string | undefined>;
const origMode = e.AUTH_MODE;
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all<Record<string, unknown>>()).results;
const json = { "content-type": "application/json" };
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  dash(path, withCookie(cookie, { method, headers: body === undefined ? {} : json, body: body === undefined ? undefined : JSON.stringify(body) }));
const audits = (action: string) => all("SELECT target_id, detail FROM audit_log WHERE action = ?", action);
const userBy = (email: string) => env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<Record<string, unknown>>();

let owner: string;
let member: string;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  e.EMAIL_FROM = "links@example.com";
  e.RESEND_API_KEY = "re_testkey12345";
  await env.DB.batch(["login_tokens", "auth_limits", "sessions", "audit_log", "domain_members", "domains", "settings", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const o = await signedIn("owner@example.com", { role: "owner" });
  owner = o.cookie;
  member = (await signedIn("a@example.com")).cookie;
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.test','main','active',?,1), ('ds1','team.test','shared','active',?,1), ('dp','priv.test','private','active',?,1)", o.user.id, o.user.id, o.user.id);
});
afterEach(() => {
  vi.restoreAllMocks();
  e.AUTH_MODE = origMode;
  e.EMAIL_FROM = undefined;
  e.RESEND_API_KEY = undefined;
});

const invite = (body: unknown, cookie = owner) => call(cookie, "POST", "/api/users/invite", body);

describe("POST /api/users/invite", () => {
  it("creates an invited user with grants, audits once and emails the dashboard address", async () => {
    const fake = fakeResend();
    const r = await invite({ email: "  New@Example.com ", role: "member", domainIds: ["ds1"] });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { user: Record<string, unknown>; emailed: boolean };
    expect(b.emailed).toBe(true);
    expect(b.user).toMatchObject({ email: "new@example.com", role: "member", status: "invited", linkCount: 0, agentCount: 0, domains: [{ id: "ds1", host: "team.test", via: "member" }] });
    const row = await userBy("new@example.com");
    expect(row).toMatchObject({ email: "new@example.com", status: "invited", role: "member", name: null });
    expect(await all("SELECT domain_id FROM domain_members WHERE user_id = ?", row!.id)).toEqual([{ domain_id: "ds1" }]);
    const a = await audits("user.invite");
    expect(a).toHaveLength(1);
    expect(JSON.parse(String(a[0]!.detail))).toEqual({ email: "new@example.com", role: "member", domains: ["team.test"] });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toEqual(["new@example.com"]);
    expect(fake.sent[0]!.text).toContain("https://dash.test/");
  });
  it("a private or unknown domain id is 400 bad_domain and creates nothing", async () => {
    const fake = fakeResend();
    for (const id of ["dp", "nope", "dm"]) {
      const r = await invite({ email: "new@example.com", role: "member", domainIds: [id] });
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_domain" }]);
    }
    expect(await userBy("new@example.com")).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });
  it("an owner invite ignores domainIds", async () => {
    fakeResend();
    const r = await invite({ email: "boss@example.com", role: "owner", domainIds: ["dp"] });
    expect(r.status).toBe(201);
    const row = await userBy("boss@example.com");
    expect(row).toMatchObject({ role: "owner", status: "invited" });
    expect(await all("SELECT 1 FROM domain_members WHERE user_id = ?", row!.id)).toEqual([]);
  });
  it("an existing email in any case is 409 email_taken and sends nothing", async () => {
    const fake = fakeResend();
    const r = await invite({ email: "A@EXAMPLE.com", role: "member" });
    expect([r.status, await r.json()]).toEqual([409, { error: "email_taken" }]);
    expect(fake.sent).toHaveLength(0);
    expect(await audits("user.invite")).toHaveLength(0);
  });
  it("without email config the invite stands: 201 emailed false not_configured", async () => {
    e.RESEND_API_KEY = undefined;
    const fake = fakeResend();
    const r = await invite({ email: "new@example.com", role: "member" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ emailed: false, emailReason: "not_configured" });
    expect(await userBy("new@example.com")).toMatchObject({ status: "invited" });
    expect(fake.sent).toHaveLength(0);
  });
  it("the instance email budget at its cap: 201 emailed false too_many", async () => {
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('inst', ?, 50)", Math.floor(Date.now() / 1000));
    const fake = fakeResend();
    const r = await invite({ email: "new@example.com", role: "member" });
    expect([r.status, await r.json()]).toMatchObject([201, { emailed: false, emailReason: "too_many" }]);
    expect(fake.sent).toHaveLength(0);
  });
  it("a Resend rejection still keeps the invite: emailed false rejected", async () => {
    const fake = fakeResend();
    fake.failNext(422);
    const r = await invite({ email: "new@example.com", role: "member" });
    expect([r.status, await r.json()]).toMatchObject([201, { emailed: false, emailReason: "rejected" }]);
  });
  it("invalid bodies are 400", async () => {
    for (const b of [{ email: "nope", role: "member" }, { email: "x@example.com", role: "admin" }, { email: "x@example.com", role: "member", extra: 1 },
      { email: `${"a".repeat(250)}@example.com`, role: "member" }, { email: "x@example.com", role: "member", domainIds: Array(101).fill("ds1") }]) {
      expect((await invite(b)).status).toBe(400);
    }
  });
  it("the invitee signs in by email link and becomes active", async () => {
    fakeResend();
    expect((await invite({ email: "new@example.com", role: "member" })).status).toBe(201);
    vi.restoreAllMocks();
    const fake = fakeResend();
    const ctx = createExecutionContext();
    const ask = await worker.fetch(new Request(`${ORIGIN}/auth/email`, { method: "POST", headers: { origin: ORIGIN, ...json }, body: JSON.stringify({ email: "new@example.com" }) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ask.status).toBe(202);
    const v = await dash("/auth/email/verify", { method: "POST", headers: json, body: JSON.stringify({ token: fake.tokenFrom() }) });
    expect(v.status).toBe(200);
    const cookie = /^([^;]*)/.exec(v.headers.get("set-cookie") ?? "")![1]!;
    expect((await call(cookie, "GET", "/api/me")).status).toBe(200);
    expect(await userBy("new@example.com")).toMatchObject({ status: "active" });
  });
  it("a member gets 403, a Bearer token without a session 401, a foreign Origin 403", async () => {
    const fake = fakeResend();
    expect((await invite({ email: "new@example.com", role: "member" }, member)).status).toBe(403);
    const bearer = await dash("/api/users/invite", { method: "POST", headers: { ...json, authorization: "Bearer lw_test_123" }, body: JSON.stringify({ email: "new@example.com", role: "member" }) });
    expect(bearer.status).toBe(401);
    const foreign = await dash("/api/users/invite", withCookie(owner, { method: "POST", headers: { ...json, origin: "https://evil.example.com" }, body: JSON.stringify({ email: "new@example.com", role: "member" }) }));
    expect(foreign.status).toBe(403);
    expect(await userBy("new@example.com")).toBeNull();
    expect(fake.sent).toHaveLength(0);
  });
});

describe("POST /api/users/:id/resend", () => {
  const invited = async () => {
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ui','new@example.com','member','invited',1)");
    return "ui";
  };
  it("sends once, audits, and a second call within 60 s is 429 too_soon", async () => {
    const id = await invited();
    const fake = fakeResend();
    const r = await call(owner, "POST", `/api/users/${id}/resend`);
    expect([r.status, await r.json()]).toEqual([200, { emailed: true }]);
    expect(fake.sent.map((m) => m.to)).toEqual([["new@example.com"]]);
    const r2 = await call(owner, "POST", `/api/users/${id}/resend`);
    expect([r2.status, await r2.json()]).toEqual([429, { error: "too_soon" }]);
    expect(fake.sent).toHaveLength(1);
    expect(await audits("user.invite_resend")).toHaveLength(1);
  });
  it("the invite email itself counts: a resend right after inviting is too_soon", async () => {
    fakeResend();
    const b = (await (await invite({ email: "new@example.com", role: "member" })).json()) as { user: { id: string } };
    expect((await call(owner, "POST", `/api/users/${b.user.id}/resend`)).status).toBe(429);
  });
  it("unknown 404, active 409 not_invited_state, unconfigured 409, instance cap 429 too_many, member 403", async () => {
    const id = await invited();
    const fake = fakeResend();
    expect((await call(owner, "POST", "/api/users/nope/resend")).status).toBe(404);
    const act = await userBy("a@example.com");
    const r = await call(owner, "POST", `/api/users/${act!.id}/resend`);
    expect([r.status, await r.json()]).toEqual([409, { error: "not_invited_state" }]);
    expect((await call(member, "POST", `/api/users/${id}/resend`)).status).toBe(403);
    e.RESEND_API_KEY = undefined;
    const nc = await call(owner, "POST", `/api/users/${id}/resend`);
    expect([nc.status, await nc.json()]).toEqual([409, { error: "email_not_configured" }]);
    e.RESEND_API_KEY = "re_testkey12345";
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('inst', ?, 50)", Math.floor(Date.now() / 1000));
    const tm = await call(owner, "POST", `/api/users/${id}/resend`);
    expect([tm.status, await tm.json()]).toEqual([429, { error: "too_many" }]);
    expect(fake.sent).toHaveLength(0);
    expect(await audits("user.invite_resend")).toHaveLength(0);
  });
});

describe("DELETE /api/users/:id/invite", () => {
  it("removes the user, the grants and that email's sign-in links, audits once; a second revoke is 404", async () => {
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ui','new@example.com','member','invited',1)");
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds1','ui')");
    const now = Math.floor(Date.now() / 1000);
    await run("INSERT INTO login_tokens (token_hash,email,next,created_at,expires_at) VALUES ('h1','New@Example.com','/',?,?), ('h2','a@example.com','/',?,?)", now, now + 900, now, now + 900);
    const r = await call(owner, "DELETE", "/api/users/ui/invite");
    expect([r.status, await r.json()]).toEqual([200, {}]);
    expect(await userBy("new@example.com")).toBeNull();
    expect(await all("SELECT 1 FROM domain_members WHERE user_id = 'ui'")).toEqual([]);
    expect(await all("SELECT token_hash FROM login_tokens")).toEqual([{ token_hash: "h2" }]);
    const a = await audits("user.revoke");
    expect(a).toHaveLength(1);
    expect(a[0]!.target_id).toBe("ui");
    expect((await call(owner, "DELETE", "/api/users/ui/invite")).status).toBe(404);
    expect(await audits("user.revoke")).toHaveLength(1);
  });
  it("revoking an active user is 409 not_invited_state and deletes nothing; member 403", async () => {
    const act = await userBy("a@example.com");
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds1',?)", act!.id);
    const r = await call(owner, "DELETE", `/api/users/${act!.id}/invite`);
    expect([r.status, await r.json()]).toEqual([409, { error: "not_invited_state" }]);
    expect(await userBy("a@example.com")).toMatchObject({ status: "active" });
    expect(await all("SELECT 1 FROM domain_members WHERE user_id = ?", act!.id)).toHaveLength(1);
    expect(await audits("user.revoke")).toHaveLength(0);
    expect((await call(member, "DELETE", `/api/users/${act!.id}/invite`)).status).toBe(403);
  });
  it("after a revoke the email's sign-in request sends nothing", async () => {
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ui','new@example.com','member','invited',1)");
    expect((await call(owner, "DELETE", "/api/users/ui/invite")).status).toBe(200);
    const fake = fakeResend();
    const ctx = createExecutionContext();
    const ask = await worker.fetch(new Request(`${ORIGIN}/auth/email`, { method: "POST", headers: { origin: ORIGIN, ...json }, body: JSON.stringify({ email: "new@example.com" }) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ask.status).toBe(202);
    expect(fake.sent).toHaveLength(0);
  });
});
