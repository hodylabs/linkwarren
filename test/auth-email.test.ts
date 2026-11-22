import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { limitKey } from "../src/limits";
import { SESSION_COOKIE, sha256Hex } from "../src/session";
import { ORIGIN, dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signedIn } from "./helpers/session";

const e = env as { AUTH_MODE?: string; RESEND_API_KEY?: string };
const orig = { mode: e.AUTH_MODE, key: e.RESEND_API_KEY };
let fake: ReturnType<typeof fakeResend>;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  await env.DB.batch(["sessions", "login_tokens", "auth_limits", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  fake = fakeResend();
});
afterEach(() => {
  fake.release();
  vi.restoreAllMocks();
  e.AUTH_MODE = orig.mode;
  e.RESEND_API_KEY = orig.key;
});

const IP = "203.0.113.5";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  dash(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ask = (email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) => post("/auth/email", { email, ...extra }, headers);
const verify = (token: string, headers?: Record<string, string>) => post("/auth/email/verify", { token }, headers);
const addUser = async (email: string, status: string, role = "member") => {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)").bind(id, email, role, status).run();
  return id;
};
const all = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
const LINK = /https:\/\/dash\.test\/sign-in#token=[A-Za-z0-9_-]{43}/;
/** Asks for a link for `email` and returns its token from the fake mail. */
const linkFor = async (email: string, extra: Record<string, unknown> = {}) => {
  expect((await ask(email, extra)).status).toBe(202);
  return fake.tokenFrom();
};

describe("POST /auth/email: sending", () => {
  it("mails an active user", async () => {
    await addUser("a@example.com", "active");
    const r = await ask("a@example.com");
    expect(r.status).toBe(202);
    expect(await r.text()).toBe('{"ok":true}');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(fake.sent).toHaveLength(1);
    const m = fake.sent[0]!;
    expect(m.to).toEqual(["a@example.com"]);
    expect(m.from).toBe("links@example.com");
    expect(m.subject).toBe("Your sign-in link for linkwarren");
    expect(m.text).toMatch(LINK);
    expect(m.html).toMatch(LINK);
    expect(m.text).toContain("Use this link to sign in to linkwarren at dash.test:");
  });
  it("mails an invited user", async () => {
    await addUser("a@example.com", "invited");
    await ask("a@example.com");
    expect(fake.sent).toHaveLength(1);
  });
  it("mails OWNER_EMAIL in another case while the users table is empty", async () => {
    await ask("OWNER@Example.com");
    expect(fake.sent.map((m) => m.to)).toEqual([["OWNER@Example.com"]]);
  });
  it("mails nobody else while the table is empty, and no disabled user", async () => {
    await ask("x@example.com");
    await addUser("d@example.com", "disabled");
    await ask("d@example.com");
    expect(fake.sent).toHaveLength(0);
    expect(await count("login_tokens")).toBe(0);
  });
  it("trims and validates before keying the address limiter (one key per address)", async () => {
    await ask(" A@Example.com ");
    await ask("a@example.com");
    const rows = await all("SELECT key, count FROM auth_limits WHERE key LIKE 'addr:%'");
    expect(rows).toEqual([{ key: await limitKey.addr("a@example.com"), count: 2 }]);
  });
});

describe("POST /auth/email: no account enumeration (Review Focus 3)", () => {
  it("answers identically for active, invited, unknown and disabled addresses", async () => {
    await addUser("act@example.com", "active");
    await addUser("inv@example.com", "invited");
    await addUser("dis@example.com", "disabled");
    const shape = async (email: string) => {
      const r = await ask(email);
      return { status: r.status, body: await r.text(), headers: [...r.headers.keys()].filter((k) => k !== "date").sort() };
    };
    const got = [await shape("act@example.com"), await shape("inv@example.com"), await shape("nobody@example.com"), await shape("dis@example.com")];
    for (const g of got) expect(g).toEqual(got[0]);
    expect(got[0]!.status).toBe(202);
    expect(fake.sent).toHaveLength(2);
  });
  it("responds before the Resend call resolves", async () => {
    await addUser("a@example.com", "active");
    fake.hold();
    const r = await ask("a@example.com");
    expect(r.status).toBe(202);
    expect(fake.sent).toHaveLength(1);
    fake.release();
  });
  it("refuses the 6th request for an unknown address within 15 minutes", async () => {
    for (let i = 0; i < 5; i++) expect((await ask("nobody@example.com")).status).toBe(202);
    const r = await ask("nobody@example.com");
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "too_many_attempts" });
  });
  it("refuses the 21st request from one /24 across different addresses", async () => {
    for (let i = 1; i <= 20; i++) expect((await ask(`u${i}@example.com`, {}, { "cf-connecting-ip": `198.51.100.${i}` })).status).toBe(202);
    const r = await ask("u21@example.com", {}, { "cf-connecting-ip": "198.51.100.200" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "too_many_attempts" });
  });
  it("at the instance cap answers the same 202 and sends nothing", async () => {
    await addUser("a@example.com", "active");
    await env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('inst', ?, 50)").bind(Math.floor(Date.now() / 1000)).run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await ask("a@example.com");
    expect(r.status).toBe(202);
    expect(await r.text()).toBe('{"ok":true}');
    expect(fake.sent).toHaveLength(0);
    expect(await count("login_tokens")).toBe(0);
    expect(warn.mock.calls).toEqual([["email_cap"]]);
  });
});

describe("/auth guard", () => {
  it("requires the Origin header", async () => {
    const r = await exports.default.fetch(`${ORIGIN}/auth/email`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"a@example.com"}' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden_origin" });
  });
  it("refuses a foreign Origin", async () => {
    const r = await ask("a@example.com", {}, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden_origin" });
  });
  it("refuses a non-JSON body with 415", async () => {
    const r = await post("/auth/email", '{"email":"a@example.com"}', { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    expect(await r.json()).toEqual({ error: "unsupported_media_type" });
  });
  it.each([["GET", "/auth/email"], ["GET", "/auth/nope"], ["GET", "/auth"], ["DELETE", "/auth/email"], ["HEAD", "/auth/email"]])("%s %s is the JSON 404", async (method, p) => {
    const r = await dash(p, { method });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-fake-assets")).toBeNull();
  });
  it("answers 404 on an unknown POST /auth path", async () => {
    expect((await post("/auth/nope", {})).status).toBe(404);
  });
  it.each([["not-an-email<x>"], ["a@example.com\u0000"]])("refuses a bad email %j without echoing it", async (email) => {
    const r = await ask(email);
    expect(r.status).toBe(400);
    const t = await r.text();
    expect(t).toBe('{"error":"invalid_body"}');
  });
  it("refuses unknown keys and broken JSON", async () => {
    expect((await ask("a@example.com", { x: 1 })).status).toBe(400);
    expect((await post("/auth/email", "{")).status).toBe(400);
  });
  it("answers 503 email_not_configured without RESEND_API_KEY", async () => {
    delete e.RESEND_API_KEY;
    const r = await ask("a@example.com");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "email_not_configured" });
  });
});

describe("POST /auth/email/verify", () => {
  it("signs in with a valid token", async () => {
    const uid = await addUser("a@example.com", "active");
    const t = await linkFor("a@example.com");
    const r = await verify(t);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"next":"/"}');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$`));
    const s = await all("SELECT user_id, method FROM sessions");
    expect(s).toEqual([{ user_id: uid, method: "email" }]);
    expect((await all("SELECT action, detail FROM audit_log")).map((a) => [a.action, a.detail])).toEqual([["auth.sign_in", '{"method":"email"}']]);
  });

  describe("replay and leakage (Review Focus 2)", () => {
    it("refuses the same token twice", async () => {
      await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      expect((await verify(t)).status).toBe(200);
      const r = await verify(t);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "link_invalid" });
      expect(r.headers.get("set-cookie")).toBeNull();
    });
    it("refuses a 16-minute-old token", async () => {
      await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      await env.DB.prepare("UPDATE login_tokens SET created_at = created_at - 960, expires_at = expires_at - 960").run();
      const r = await verify(t);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "link_invalid" });
    });
    it("gives exactly one 200 and one session for two concurrent verifies", async () => {
      await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      const rs = await Promise.all([verify(t), verify(t)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await count("sessions")).toBe(1);
    });
    it("a scanner GET of /sign-in gets the SPA shell and leaves the token unused", async () => {
      await addUser("a@example.com", "active");
      await linkFor("a@example.com");
      const r = await exports.default.fetch(`${ORIGIN}/sign-in`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("<title>lw</title>");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await all("SELECT used_at FROM login_tokens")).toEqual([{ used_at: null }]);
    });
    it("has no GET verify route", async () => {
      await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      const r = await dash(`/auth/email/verify?token=${t}`);
      expect(r.status).toBe(404);
      expect(await all("SELECT used_at FROM login_tokens")).toEqual([{ used_at: null }]);
    });
    it("never puts the token or its hash in a log, response or audit row, even when Resend echoes the request", async () => {
      await addUser("a@example.com", "active");
      const calls = (["log", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
      fake.failNext(500, (m: unknown) => ({ message: "failed", request: m }));
      const r1 = await ask("a@example.com");
      const t = fake.tokenFrom();
      const hash = await sha256Hex(t);
      await vi.waitFor(() => expect(calls[1]!).toHaveBeenCalledWith("resend_rejected", 500));
      const r2 = await verify(t);
      expect(r2.status).toBe(200);
      const seen = JSON.stringify([
        calls.map((c) => c.mock.calls), await r1.text(), await r2.text(), [...r1.headers], [...r2.headers], await all("SELECT * FROM audit_log"),
      ]);
      expect(seen).not.toContain(t);
      expect(seen).not.toContain(hash);
      const rows = await all("SELECT * FROM login_tokens");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).toBe(hash);
      expect(JSON.stringify(rows)).not.toContain(t);
    });
  });

  describe("users", () => {
    it("activates an invited user: user.activate then auth.sign_in", async () => {
      const uid = await addUser("a@example.com", "invited");
      expect((await verify(await linkFor("a@example.com"))).status).toBe(200);
      expect(await all(`SELECT status FROM users WHERE id = '${uid}'`)).toEqual([{ status: "active" }]);
      expect((await all("SELECT action FROM audit_log ORDER BY id")).map((a) => a.action)).toEqual(["user.activate", "auth.sign_in"]);
    });
    it("bootstraps exactly one owner from the owner's token on an empty table", async () => {
      const t = await linkFor("owner@example.com");
      expect((await verify(t)).status).toBe(200);
      expect(await all("SELECT role, status FROM users")).toEqual([{ role: "owner", status: "active" }]);
      expect(await count("sessions")).toBe(1);
    });
    it("refuses a user disabled between request and verify, with no session", async () => {
      const uid = await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(uid).run();
      const r = await verify(t);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "disabled" });
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(await count("sessions")).toBe(0);
    });
    it.each([["//evil.example", "/"], ["/.//evil.example", "/"], ["/links?q=a", "/links?q=a"]])("stores next %j and returns %j", async (next, want) => {
      await addUser("a@example.com", "active");
      const r = await verify(await linkFor("a@example.com", { next }));
      expect(await r.json()).toEqual({ next: want });
    });
    it("fixation: an incoming session cookie is deleted and a different one issued", async () => {
      await addUser("a@example.com", "active");
      const old = await signedIn("b@example.com");
      const r = await verify(await linkFor("a@example.com"), { cookie: old.cookie });
      expect(r.status).toBe(200);
      expect(await all(`SELECT 1 FROM sessions WHERE token_hash = '${await sha256Hex(old.value)}'`)).toEqual([]);
      expect(r.headers.get("set-cookie")).not.toContain(old.value);
      expect(await count("sessions")).toBe(1);
    });
    it("refuses even a valid token after 20 failed verifies from one prefix", async () => {
      await addUser("a@example.com", "active");
      const t = await linkFor("a@example.com");
      for (let i = 0; i < 20; i++) expect((await verify("A".repeat(42) + String.fromCharCode(97 + i), { "cf-connecting-ip": `203.0.113.${i + 1}` })).status).toBe(400);
      const r = await verify(t);
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ error: "too_many_attempts" });
      expect(await all("SELECT used_at FROM login_tokens")).toEqual([{ used_at: null }]);
    });
    it("refuses a malformed token shape with invalid_body", async () => {
      expect((await verify("short")).status).toBe(400);
      expect(await (await verify("short")).json()).toEqual({ error: "invalid_body" });
    });
  });
});
