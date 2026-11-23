import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ABSOLUTE, ROLLING, SESSION_COOKIE, TOUCH_EVERY, clearCookie, createSession, deviceLabel, endSessionStmt, ipPrefix, readCookie,
  safeNext, sha256Hex,
} from "../src/session";
import { dash } from "./helpers/access";
import { signedIn } from "./helpers/session";
import { MEMBER_DEFAULT } from "../src/roles";

const e = env as { AUTH_MODE?: unknown };
const orig = e.AUTH_MODE;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  await env.DB.batch(["sessions", "users", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => { e.AUTH_MODE = orig; });

const now = () => Math.floor(Date.now() / 1000);
const row = (id: string) => env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<Record<string, unknown>>();
const only = async () => (await env.DB.prepare("SELECT * FROM sessions").all<Record<string, unknown>>()).results;
const me = (cookie: string) => dash("/api/me", { headers: { cookie } });

describe("createSession", () => {
  it("sets the exact host-only cookie and stores only the SHA-256 of its value", async () => {
    const s = await signedIn();
    expect(s.setCookie).toBe(`${SESSION_COOKIE}=${s.value}; Path=/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax`);
    expect(s.setCookie).not.toMatch(/domain/i);
    expect(s.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await only();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.token_hash).toBe(await sha256Hex(s.value));
    expect(Object.values(r)).not.toContain(s.value);
    expect(r.method).toBe("email");
    expect(r.expires_at).toBe((r.created_at as number) + ROLLING);
    const a = await env.DB.prepare("SELECT * FROM audit_log").all<Record<string, unknown>>();
    expect(a.results.map((x) => [x.action, x.target_type, x.target_id, x.detail])).toEqual([["auth.sign_in", "session", r.id, '{"method":"email"}']]);
    expect(JSON.stringify(a.results)).not.toContain(s.value);
    expect(JSON.stringify(a.results)).not.toContain(r.token_hash as string);
  });

  it("records device and IP prefix from the request", async () => {
    const user = (await signedIn()).user;
    const req = new Request("https://dash.test/x", {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "cf-connecting-ip": "203.0.113.77" },
    });
    const { stmts } = await createSession(env, req, user, "passkey");
    await env.DB.batch(stmts);
    const r = await env.DB.prepare("SELECT * FROM sessions WHERE method = 'passkey'").first<Record<string, unknown>>();
    expect([r!.device, r!.ip_prefix]).toEqual(["Chrome on macOS", "203.0.113.0/24"]);
  });

  it("deletes the session of the incoming cookie (fixation) and issues a new value", async () => {
    const a = await signedIn();
    const aId = (await only())[0]!.id as string;
    const { setCookie, stmts } = await createSession(env, new Request("https://dash.test/x", { headers: { cookie: a.cookie } }), a.user, "email");
    await env.DB.batch(stmts);
    expect(await row(aId)).toBeNull();
    expect(setCookie).not.toContain(a.value);
    expect(await only()).toHaveLength(1);
    expect((await me(a.cookie)).status).toBe(401);
  });

  it("keeps the incoming session when the new one is refused (the person was disabled meanwhile)", async () => {
    const a = await signedIn();
    const aId = (await only())[0]!.id as string;
    const b = await signedIn("b@example.com", { status: "disabled" });
    const { stmts, started } = await createSession(env, new Request("https://dash.test/x", { headers: { cookie: a.cookie } }), b.user, "email");
    expect(started(await env.DB.batch(stmts))).toBe(false);
    expect(await row(aId)).not.toBeNull();
    expect((await me(a.cookie)).status).toBe(200);
  });
});

describe("readSession through /api/me (app mode)", () => {
  it("a valid cookie answers 200 with the /api/me fields", async () => {
    const s = await signedIn();
    const r = await me(s.cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: s.user.id, email: "a@example.com", name: null, role: "member", roleId: "member", roleName: "Member", perms: [...MEMBER_DEFAULT], authMode: "app", passkeys: 0 });
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it.each(["abc", "A".repeat(44), "x;y"])("malformed cookie %j -> 401", async (v) => {
    await signedIn();
    expect((await me(`${SESSION_COOKIE}=${v}`)).status).toBe(401);
  });

  it("an expired session -> 401", async () => {
    const s = await signedIn();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(now() - 1).run();
    expect((await me(s.cookie)).status).toBe(401);
  });

  it("past the 90-day absolute cap -> 401 even with a fresh last_seen_at", async () => {
    const s = await signedIn();
    await env.DB.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ?").bind(now() - 91 * 86400, now(), now() + 3600).run();
    expect((await me(s.cookie)).status).toBe(401);
  });

  it("last seen 9 minutes ago: the row is not touched", async () => {
    const s = await signedIn();
    const t = now() - 540;
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ?").bind(t, t + ROLLING).run();
    const before = (await only())[0];
    expect((await me(s.cookie)).status).toBe(200);
    expect((await only())[0]).toEqual(before);
  });

  it("last seen 11 minutes ago: last_seen_at = now and expires_at = MIN(created + 90 d, now + 30 d)", async () => {
    const s = await signedIn();
    const t = now() - 660;
    const created = now() - 80 * 86400; // the 90-day cap is nearer than now + 30 d
    await env.DB.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ?").bind(created, t, t + ROLLING).run();
    expect((await me(s.cookie)).status).toBe(200);
    const r = (await only())[0]!;
    expect(Math.abs((r.last_seen_at as number) - now())).toBeLessThanOrEqual(2);
    expect(r.expires_at).toBe(created + ABSOLUTE);

    await env.DB.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?").bind(now() - 86400, now() - TOUCH_EVERY - 60).run();
    expect((await me(s.cookie)).status).toBe(200);
    const r2 = (await only())[0]!;
    expect(Math.abs((r2.expires_at as number) - (now() + ROLLING))).toBeLessThanOrEqual(2);
  });

  it("a disabled user with a live session -> 403 disabled", async () => {
    const s = await signedIn();
    await env.DB.prepare("UPDATE users SET status = 'disabled'").run();
    const r = await me(s.cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "disabled" });
  });

  it("a deleted user -> 401", async () => {
    const s = await signedIn();
    await env.DB.prepare("DELETE FROM users").run();
    expect((await me(s.cookie)).status).toBe(401);
  });
});

describe("cookie helpers", () => {
  it("readCookie finds the session value among other cookies and refuses bad shapes", () => {
    const v = "A".repeat(43);
    const req = (c: string) => new Request("https://dash.test/", { headers: { cookie: c } });
    expect(readCookie(req(`a=1; ${SESSION_COOKIE}=${v}; b=2`))).toBe(v);
    expect(readCookie(req(`${SESSION_COOKIE}=${v}x`))).toBeNull();
    expect(readCookie(new Request("https://dash.test/"))).toBeNull();
  });

  it("clearCookie uses the same name with Max-Age=0", () => {
    expect(clearCookie()).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  });

  it("endSessionStmt deletes by id or by user, honouring a guard", async () => {
    const a = await signedIn("a@example.com");
    const b = await signedIn("b@example.com");
    await env.DB.batch([endSessionStmt(env, { userId: a.user.id }, { sql: "1 = 0", binds: [] })]);
    expect(await only()).toHaveLength(2);
    await env.DB.batch([endSessionStmt(env, { userId: a.user.id })]);
    const left = await only();
    expect(left.map((r) => r.user_id)).toEqual([b.user.id]);
    await env.DB.batch([endSessionStmt(env, { id: left[0]!.id as string })]);
    expect(await only()).toHaveLength(0);
  });
});

describe("ipPrefix", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0/24"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd::/48"],
    ["2001:0DB8:ABCD:0012:0000:0000:0000:0001", "2001:db8:abcd::/48"],
    ["::ffff:203.0.113.7", "203.0.113.0/24"],
    ["::ffff:cb00:7107", "203.0.113.0/24"],
    ["nope", null], ["", null], [null, null], ["256.1.1.1", null], ["1.2.3", null], ["1::2::3", null], ["fe80::1%eth0", null],
  ])("%j -> %j", (ip, want) => {
    expect(ipPrefix(ip)).toBe(want);
  });
});

describe("deviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["curl/8.5.0", null], ["", null], [null, null],
  ])("%j -> %j", (ua, want) => {
    expect(deviceLabel(ua)).toBe(want);
  });
  it("stays fast on a huge hostile header", () => {
    const t = Date.now();
    expect(deviceLabel("Version/" + "1.".repeat(60_000))).toBeNull();
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("safeNext", () => {
  const O = "https://dash.test";
  it.each([
    ["/links?q=a", "/links?q=a"], ["/", "/"], ["/a/b#c", "/a/b#c"],
    ["//evil.example", "/"], ["/\\evil.example", "/"], ["https://evil.example", "/"], ["javascript:alert(1)", "/"],
    [" /x", "/"], ["/a\tb", "/"], ["/a\nb", "/"], ["/a\u007fb", "/"], ["/" + "a".repeat(2048), "/"], [42, "/"], [null, "/"], ["", "/"],
    ["/.//evil.example", "/"], ["/..//evil.example", "/"], ["/./\\evil.example", "/"],
  ])("%j -> %j", (raw, want) => {
    expect(safeNext(raw, O)).toBe(want);
  });
  it("keeps a 2048-char path and never returns a protocol-relative value", () => {
    const p = "/" + "a".repeat(2047);
    expect(safeNext(p, O)).toBe(p);
    expect(safeNext("/.//evil.example", O).startsWith("//")).toBe(false);
  });
});
