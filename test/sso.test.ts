import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import worker from "../src/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, limitKey } from "../src/limits";
import { PERMS } from "../src/roles";
import { createSession } from "../src/session";
import { ORIGIN, dash } from "./helpers/access";
import { fakeIdp, ISS } from "./helpers/idp";
import { call, pathEnv } from "./helpers/path";
import { fakeResend } from "./helpers/resend";
import { signedIn, withCookie } from "./helpers/session";

const e = env as unknown as Record<string, string | undefined>;
const orig = { mode: e.AUTH_MODE, key: e.SECRETS_KEY };
const KEY32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
let idp: Awaited<ReturnType<typeof fakeIdp>>;

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all<Record<string, unknown>>()).results;
const setting = (key: string, v: unknown) =>
  run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES (?,?,1,'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(v));
const addUser = async (email: string, o: { role?: string; status?: string; roleId?: string | null } = {}) => {
  const id = crypto.randomUUID();
  await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,?,1)", id, email, o.role ?? "member", o.roleId ?? null, o.status ?? "active");
  return id;
};

beforeEach(async () => {
  e.AUTH_MODE = "app";
  e.GOOGLE_CLIENT_SECRET = "g-secret";
  e.GITHUB_CLIENT_SECRET = "gh-secret";
  e.OIDC_CLIENT_SECRET = "o-secret";
  await env.DB.batch(["sessions", "sso_states", "sso_identities", "email_domains", "login_tokens", "auth_limits", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM settings WHERE key LIKE 'sso.%' OR key LIKE 'secret.%'");
  await run("DELETE FROM roles WHERE builtin = 0");
  for (const k of (await env.CACHE.list({ prefix: "sso:disc:" })).keys) await env.CACHE.delete(k.name);
  for (const p of ["google", "github", "oidc"]) {
    await setting(`sso.${p}.enabled`, true);
    await setting(`sso.${p}.clientId`, "client-1");
  }
  await setting("sso.oidc.issuer", ISS);
  idp = await fakeIdp();
});
afterEach(() => {
  vi.restoreAllMocks();
  e.AUTH_MODE = orig.mode;
  e.SECRETS_KEY = orig.key;
  delete e.GOOGLE_CLIENT_SECRET; delete e.GITHUB_CLIENT_SECRET; delete e.OIDC_CLIENT_SECRET;
});

const IP = "203.0.113.9";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  dash(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers }, body: JSON.stringify(body) });

/** POST start; returns the authorize URL, the state cookie pair and the state. */
async function start(p: string, next?: string) {
  const r = await post(`/auth/sso/${p}/start`, next === undefined ? {} : { next });
  expect(r.status).toBe(200);
  const { url } = (await r.json()) as { url: string };
  idp.sawAuthorize(url);
  const sc = r.headers.get("set-cookie")!;
  return { url, sc, cookie: /^([^;]*)/.exec(sc)![1]!, state: new URL(url).searchParams.get("state")! };
}
const callback = (p: string, q: Record<string, string>, cookie?: string) =>
  dash(`/auth/sso/${p}/callback?${new URLSearchParams(q)}`, { headers: { "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}) }, redirect: "manual" });
/** A whole sign-in; returns the callback response. */
async function signIn(p: string, next?: string) {
  const s = await start(p, next);
  return callback(p, { code: "code-1", state: s.state }, s.cookie);
}
const errorOf = (r: Response) => (r.status === 302 ? new URL(r.headers.get("location")!).searchParams.get("error") : `status ${r.status}`);

describe("providers and start", () => {
  it("lists enabled providers with a client id and secret only, with the OIDC label", async () => {
    delete e.GITHUB_CLIENT_SECRET;
    await setting("sso.oidc.label", "Acme SSO");
    const r = await post("/auth/sso/providers", {});
    expect(await r.json()).toEqual({ items: [{ id: "google", label: "Google" }, { id: "oidc", label: "Acme SSO" }] });
    await setting("sso.google.enabled", false);
    expect(((await (await post("/auth/sso/providers", {})).json()) as { items: unknown[] }).items).toEqual([{ id: "oidc", label: "Acme SSO" }]);
  });

  it("start: PKCE S256, state, nonce, exact redirect URI, a 10-minute HttpOnly state cookie", async () => {
    const s = await start("oidc");
    const u = new URL(s.url), q = u.searchParams;
    expect(u.origin + u.pathname).toBe(`${ISS}/authorize`);
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: "client-1", response_type: "code", scope: "openid email", code_challenge_method: "S256",
      redirect_uri: "https://dash.test/auth/sso/oidc/callback",
    });
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.sc).toBe(`__Host-lw_sso=${s.state}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`);
    // Only the hash of the state secret is stored.
    expect(await all("SELECT provider, next, used_at FROM sso_states")).toEqual([{ provider: "oidc", next: "/", used_at: null }]);
    expect(await all("SELECT 1 FROM sso_states WHERE id_hash = ?", s.state)).toEqual([]);
    // The verifier sent at the token call hashes to the challenge.
    await callback("oidc", { code: "c", state: s.state }, s.cookie);
    const verifier = new URLSearchParams(idp.tokenCall()!.body).get("code_verifier")!;
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(q.get("code_challenge"));
  });

  it("start: unknown or disabled provider 404, guarded like /auth (Origin, JSON), limited per range", async () => {
    expect((await post("/auth/sso/nope/start", {})).status).toBe(404);
    await setting("sso.github.enabled", false);
    expect([(await post("/auth/sso/github/start", {})).status]).toEqual([404]);
    const noOrigin = await exports.default.fetch(`${ORIGIN}/auth/sso/google/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([noOrigin.status, await noOrigin.json()]).toEqual([403, { error: "forbidden_origin" }]);
    expect((await dash("/auth/sso/google/start", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await dash("/auth/sso/providers", { method: "GET" })).status).toBe(404);
    await run("INSERT OR REPLACE INTO auth_limits (key, window_start, count) VALUES (?, ?, ?)", limitKey.ssoStart("203.0.113.0/24"), Math.floor(Date.now() / 1000), LIMITS.ssoStart.n);
    const r = await post("/auth/sso/google/start", {});
    expect([r.status, await r.json()]).toEqual([429, { error: "too_many" }]);
  });

  it("404 in access mode", async () => {
    e.AUTH_MODE = "access";
    expect((await post("/auth/sso/providers", {})).status).toBe(404);
    expect((await callback("google", { code: "c", state: "s" })).status).toBe(404);
  });
});

describe("callback", () => {
  it("Google: signs a known person in, binds the identity, clears the state cookie, keeps next inside the dashboard", async () => {
    const uid = await addUser("a@example.com");
    const r = await signIn("google", "/links?x=1");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dash.test/links?x=1"]);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const cookies = r.headers.getSetCookie();
    expect(cookies[0]).toBe("__Host-lw_sso=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
    expect(cookies[1]).toMatch(/^__Host-lw_session=[A-Za-z0-9_-]{43}; Path=\/;/);
    expect(await all("SELECT provider, subject, user_id, email FROM sso_identities")).toEqual([{ provider: "google", subject: "sub-1", user_id: uid, email: "a@example.com" }]);
    expect(await all("SELECT method FROM sessions")).toEqual([{ method: "google" }]);
    expect(await all("SELECT action, detail FROM audit_log ORDER BY id")).toEqual([
      { action: "auth.sign_in", detail: JSON.stringify({ method: "google" }) },
      { action: "signin.sso", detail: JSON.stringify({ provider: "google", joined: false }) },
    ]);
    const me = await dash("/api/me", withCookie(/^([^;]*)/.exec(cookies[1]!)![1]!));
    expect(((await me.json()) as { email: string }).email).toBe("a@example.com");
    // Token call: client secret basic, never in the URL.
    const t = idp.tokenCall()!;
    expect(t.url).toBe("https://oauth2.example.test/token");
    expect(t.headers.get("authorization")).toBe(`Basic ${btoa("client-1:g-secret")}`);
    expect(new URLSearchParams(t.body).get("redirect_uri")).toBe("https://dash.test/auth/sso/google/callback");
  });

  it.each([["https://evil.example/x"], ["//evil.example"], ["/\\evil"]])("next %s falls back to /", async (next) => {
    await addUser("a@example.com");
    expect((await signIn("google", next)).headers.get("location")).toBe("https://dash.test/");
  });

  it("the state is single use, needs the cookie, and must equal it", async () => {
    await addUser("a@example.com");
    const s = await start("google");
    expect(errorOf(await callback("google", { code: "c", state: s.state }))).toBe("sso_failed"); // no cookie
    expect(errorOf(await callback("google", { code: "c", state: "x".repeat(43) }, s.cookie))).toBe("sso_failed"); // mismatch
    expect(errorOf(await callback("github", { code: "c", state: s.state }, s.cookie.replace("google", "")))).toBe("sso_failed"); // other provider
    const ok = await callback("google", { code: "c", state: s.state }, s.cookie);
    expect(ok.headers.get("location")).toBe("https://dash.test/");
    const replay = await callback("google", { code: "c", state: s.state }, s.cookie);
    expect(errorOf(replay)).toBe("sso_failed");
    expect(replay.headers.getSetCookie()).toEqual(["__Host-lw_sso=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"]);
    expect(await all("SELECT COUNT(*) n FROM sessions")).toEqual([{ n: 1 }]);
  });

  it("an expired state row is refused", async () => {
    await addUser("a@example.com");
    const s = await start("google");
    await run("UPDATE sso_states SET expires_at = 1");
    expect(errorOf(await callback("google", { code: "c", state: s.state }, s.cookie))).toBe("sso_failed");
  });

  it.each([
    ["a foreign issuer", { iss: "https://evil.example" }],
    ["another audience", { aud: "someone-else" }],
    ["a wrong nonce", { nonce: "n".repeat(43) }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 700 }],
    ["an iat in the future", { iat: Math.floor(Date.now() / 1000) + 900, exp: Math.floor(Date.now() / 1000) + 1200 }],
  ])("OIDC: %s is sso_failed, nothing bound, failIp counted", async (_n, claims) => {
    await addUser("a@example.com");
    idp.s.claims = claims;
    expect(errorOf(await signIn("oidc"))).toBe("sso_failed");
    expect(await all("SELECT * FROM sso_identities")).toEqual([]);
    expect(await all("SELECT count FROM auth_limits WHERE key = ?", limitKey.fail("203.0.113.0/24"))).toEqual([{ count: 1 }]);
  });

  it("OIDC: a token signed by an unknown key is sso_failed", async () => {
    await addUser("a@example.com");
    idp.s.key = idp.other;
    expect(errorOf(await signIn("oidc"))).toBe("sso_failed");
  });

  it("a provider error answer is sso_failed, never echoed", async () => {
    await addUser("a@example.com");
    idp.s.tokenStatus = 400;
    const r = await signIn("oidc");
    expect(errorOf(r)).toBe("sso_failed");
    expect(r.headers.get("location")).not.toContain("PROVIDER");
  });

  it.each([[false], ["true"], [undefined]])("OIDC: email_verified %s is email_unverified", async (v) => {
    await addUser("a@example.com");
    idp.s.claims = { email_verified: v };
    expect(errorOf(await signIn("oidc"))).toBe("email_unverified");
  });

  it("an unknown address is not_invited; a disabled person is disabled", async () => {
    expect(errorOf(await signIn("google"))).toBe("not_invited");
    await addUser("a@example.com", { status: "disabled" });
    expect(errorOf(await signIn("google"))).toBe("disabled");
    expect(await all("SELECT * FROM sso_identities")).toEqual([]);
  });

  it("an invited person becomes active", async () => {
    const uid = await addUser("a@example.com", { status: "invited" });
    expect((await signIn("google")).headers.get("location")).toBe("https://dash.test/");
    expect(await all("SELECT status FROM users WHERE id = ?", uid)).toEqual([{ status: "active" }]);
  });

  it("matches on (provider, subject) after the first sign-in, even after both emails change", async () => {
    const uid = await addUser("a@example.com");
    await signIn("oidc");
    await run("UPDATE users SET email = 'renamed@example.com' WHERE id = ?", uid);
    idp.s.email = "new-at-idp@example.com";
    expect((await signIn("oidc")).status).toBe(302);
    expect(await all("SELECT user_id, email FROM sso_identities")).toEqual([{ user_id: uid, email: "new-at-idp@example.com" }]);
    expect(await all("SELECT COUNT(*) n FROM sessions WHERE user_id = ?", uid)).toEqual([{ n: 2 }]);
  });

  it("a second account at the same provider never rebinds a person", async () => {
    await addUser("a@example.com");
    await signIn("oidc");
    idp.s.sub = "sub-2";
    expect(errorOf(await signIn("oidc"))).toBe("not_invited");
  });

  it("auto-join creates the person with the domain's role and records joined", async () => {
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('r1','Editors','[\"links.create\"]',0,1,1)");
    await run("INSERT INTO email_domains (domain, join_role_id, enforce_sso, updated_at) VALUES ('example.com','r1',0,1)");
    idp.s.email = "new@Example.com";
    expect((await signIn("google")).status).toBe(302);
    expect(await all("SELECT role, role_id, status FROM users WHERE email = 'new@example.com'")).toEqual([{ role: "member", role_id: "r1", status: "active" }]);
    expect(await all("SELECT detail FROM audit_log WHERE action = 'signin.sso'")).toEqual([{ detail: JSON.stringify({ provider: "google", joined: true }) }]);
    // The built-in Member role is stored as no custom role.
    await run("UPDATE email_domains SET join_role_id = 'member'");
    idp.s.email = "two@example.com"; idp.s.sub = "sub-2";
    expect((await signIn("google")).status).toBe(302);
    expect(await all("SELECT role, role_id FROM users WHERE email = 'two@example.com'")).toEqual([{ role: "member", role_id: null }]);
  });

  it("enforced domain: Google and GitHub refused (nothing created), OIDC works, owners keep every way in", async () => {
    await run("INSERT INTO email_domains (domain, join_role_id, enforce_sso, updated_at) VALUES ('example.com','member',1,1)");
    const uid = await addUser("a@example.com");
    expect(errorOf(await signIn("google"))).toBe("sso_required");
    expect(errorOf(await signIn("github"))).toBe("sso_required");
    idp.s.email = "joiner@example.com"; idp.s.sub = "sub-j";
    expect(errorOf(await signIn("google"))).toBe("sso_required");
    expect(await all("SELECT COUNT(*) n FROM users")).toEqual([{ n: 1 }]);
    expect(await all("SELECT * FROM sso_identities")).toEqual([]);
    idp.s.email = "a@example.com"; idp.s.sub = "sub-1";
    expect((await signIn("oidc")).headers.get("location")).toBe("https://dash.test/");
    expect(await all("SELECT user_id FROM sso_identities")).toEqual([{ user_id: uid }]);
    // Break-glass: an owner at the enforced domain signs in with Google.
    await addUser("boss@example.com", { role: "owner" });
    idp.s.email = "boss@example.com"; idp.s.sub = "sub-b";
    expect((await signIn("google")).status).toBe(302);
    expect(errorOf(await signIn("google"))).not.toBe("sso_required");
  });

  it("enforced domain: the email link is refused with sso_required for members, not owners", async () => {
    vi.restoreAllMocks();
    const fake = fakeResend();
    await run("INSERT INTO email_domains (domain, join_role_id, enforce_sso, updated_at) VALUES ('example.com',NULL,1,1)");
    await addUser("a@example.com");
    await addUser("boss@example.com", { role: "owner" });
    const link = async (email: string) => {
      const ctx = createExecutionContext();
      await worker.fetch(new Request(`${ORIGIN}/auth/email`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email }) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return post("/auth/email/verify", { token: fake.tokenFrom() });
    };
    const m = await link("a@example.com");
    expect([m.status, await m.json()]).toEqual([403, { error: "sso_required" }]);
    expect((await link("boss@example.com")).status).toBe(200);
  });

  it("GitHub: only the verified primary email counts", async () => {
    const uid = await addUser("a@example.com");
    idp.s.gh.emails = [{ email: "other@example.com", primary: false, verified: true }, { email: "a@example.com", primary: true, verified: false }];
    expect(errorOf(await signIn("github"))).toBe("email_unverified");
    idp.s.gh.emails = [{ email: "a@example.com", primary: false, verified: true }, { email: "x@example.com", primary: true, verified: true }];
    expect(errorOf(await signIn("github"))).toBe("not_invited");
    idp.s.gh.emails = [{ email: "a@example.com", primary: true, verified: true }];
    expect((await signIn("github")).status).toBe(302);
    expect(await all("SELECT subject, user_id FROM sso_identities")).toEqual([{ subject: "4242", user_id: uid }]);
    const api = idp.s.calls.find((c) => c.url === "https://api.github.com/user")!;
    expect(api.headers.get("user-agent")).toBe("linkwarren");
    expect(api.headers.get("authorization")).toBe("Bearer gho_test");
  });

  it("a blocked range is refused before the state claim and any fetch", async () => {
    await addUser("a@example.com");
    const s = await start("google");
    await run("INSERT OR REPLACE INTO auth_limits (key, window_start, count) VALUES (?, ?, ?)", limitKey.fail("203.0.113.0/24"), Math.floor(Date.now() / 1000), LIMITS.failIp.n);
    const before = idp.s.calls.length;
    expect(errorOf(await callback("google", { code: "c", state: s.state }, s.cookie))).toBe("too_many");
    expect(idp.s.calls.length).toBe(before);
    expect(await all("SELECT used_at FROM sso_states")).toEqual([{ used_at: null }]);
  });
});

describe("path mode", () => {
  it("state cookie and session cookie under the prefix, redirect URI and next under it", async () => {
    await addUser("a@example.com");
    const pe = pathEnv();
    const o = "https://short.test";
    const r = await call("/dashboard/auth/sso/google/start", { method: "POST", headers: { origin: o, "content-type": "application/json", "cf-connecting-ip": IP }, body: JSON.stringify({ next: "/dashboard/links" }) }, pe);
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    idp.sawAuthorize(url);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe("https://short.test/dashboard/auth/sso/google/callback");
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Secure-lw_sso=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
    const state = new URL(url).searchParams.get("state")!;
    const cb = await call(`/dashboard/auth/sso/google/callback?code=c&state=${state}`, { headers: { cookie: `__Secure-lw_sso=${state}`, "cf-connecting-ip": IP } }, pe);
    expect([cb.status, cb.headers.get("location")]).toEqual([302, "https://short.test/dashboard/links"]);
    expect(cb.headers.getSetCookie()[0]).toBe("__Secure-lw_sso=; Path=/dashboard; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
    expect(cb.headers.getSetCookie()[1]).toMatch(/^__Secure-lw_session=[A-Za-z0-9_-]{43}; Path=\/dashboard;/);
    const bad = await call(`/dashboard/auth/sso/google/callback?code=c&state=${state}`, { headers: { cookie: `__Secure-lw_sso=${state}` } }, pe);
    expect(bad.headers.get("location")).toBe("https://short.test/dashboard/sign-in?error=sso_failed");
  });
});

describe("settings", () => {
  const json = (cookie: string, method: string, body?: unknown) =>
    withCookie(cookie, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("GET shape; secrets are write-only (never returned or audited); owner only for provider changes", async () => {
    e.SECRETS_KEY = KEY32;
    delete e.GITHUB_CLIENT_SECRET;
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    const put = await dash("/api/settings/sso/github", json(cookie, "PUT", { clientSecret: "SUPER-SECRET-VALUE-1", clientId: "gh-id", enabled: true }));
    expect(put.status).toBe(200);
    const text = await (await dash("/api/settings/sso", withCookie(cookie))).text();
    expect(text).not.toContain("SUPER-SECRET");
    expect(JSON.parse(text)).toEqual({
      redirectUris: { google: "https://dash.test/auth/sso/google/callback", github: "https://dash.test/auth/sso/github/callback", oidc: "https://dash.test/auth/sso/oidc/callback" },
      google: { enabled: true, clientId: "client-1", secretSet: true },
      github: { enabled: true, clientId: "gh-id", secretSet: true },
      oidc: { enabled: true, issuer: ISS, clientId: "client-1", label: "Single sign-on", secretSet: true },
      emailDomains: [], secretsReady: true,
    });
    const audit = await all("SELECT action, detail FROM audit_log ORDER BY id");
    expect(JSON.stringify(audit)).not.toContain("SUPER-SECRET");
    expect(audit).toContainEqual({ action: "sso.settings", detail: JSON.stringify({ provider: "github", fields: ["enabled", "clientId", "clientSecret"] }) });
    // An empty secret clears it.
    const cleared = await dash("/api/settings/sso/github", json(cookie, "PUT", { clientSecret: "" }));
    expect(((await cleared.json()) as { github: { secretSet: boolean } }).github.secretSet).toBe(false);
    // A role with settings reads, but cannot change providers.
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('rs','Settings','[\"settings\"]',0,1,1)");
    const s = await signedIn("s@example.com", { roleId: "rs" });
    expect((await dash("/api/settings/sso", withCookie(s.cookie))).status).toBe(200);
    const no = await dash("/api/settings/sso/google", json(s.cookie, "PUT", { enabled: false }));
    expect([no.status, await no.json()]).toEqual([403, { error: "forbidden" }]);
    const m = await signedIn("m@example.com");
    expect((await dash("/api/settings/sso", withCookie(m.cookie))).status).toBe(403);
  });

  it("errors: secrets_key_missing, bad_client_id, bad_issuer, sso_discovery_failed, issuer only for oidc", async () => {
    delete e.SECRETS_KEY;
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    const err = async (p: string, b: unknown) => (await (await dash(`/api/settings/sso/${p}`, json(cookie, "PUT", b))).json()) as { error?: string };
    expect(await err("google", { clientSecret: "abc" })).toEqual({ error: "secrets_key_missing" });
    expect(await err("google", { clientId: "has space" })).toEqual({ error: "bad_client_id" });
    expect(await err("google", { issuer: ISS })).toEqual({ error: "invalid_body" });
    for (const bad of ["http://idp.example.com", "https://u:p@idp.example.com", "https://idp.example.com?x=1", "https://idp.example.com#f", "not a url"])
      expect(await err("oidc", { issuer: bad })).toEqual({ error: "bad_issuer" });
    expect(await err("oidc", { issuer: "https://other.example.com" })).toEqual({ error: "sso_discovery_failed" });
    expect(await err("nope", { enabled: true })).toEqual({ error: "not_found" });
  });

  it("a callback that overlaps an issuer change binds nothing", async () => {
    await addUser("a@example.com");
    idp.s.onToken = async () => {
      await setting("sso.oidc.issuer", "https://other.example.com");
      await run("DELETE FROM sso_identities WHERE provider = 'oidc'");
    };
    expect(errorOf(await signIn("oidc"))).toBe("not_invited");
    expect(await all("SELECT * FROM sso_identities")).toEqual([]);
    expect(await all("SELECT COUNT(*) n FROM sessions")).toEqual([{ n: 0 }]);
  });

  it("a callback that overlaps an issuer change never matches an identity bound under the new issuer", async () => {
    await addUser("a@example.com");
    await signIn("oidc"); // binds (oidc, sub-1)
    await run("DELETE FROM sessions");
    // The issuer changes while the next callback is in flight; the row now stands for the new issuer's sub-1.
    idp.s.onToken = async () => { await setting("sso.oidc.issuer", "https://other.example.com"); };
    expect(errorOf(await signIn("oidc"))).toBe("not_invited");
    expect(await all("SELECT COUNT(*) n FROM sessions")).toEqual([{ n: 0 }]);
  });

  it("the session insert re-checks the issuer: a change after the match starts no session", async () => {
    const uid = await addUser("a@example.com");
    const user = (await import("../src/auth")).findUser;
    const u = (await user(env, "a@example.com"))!;
    const guard = { sql: "EXISTS (SELECT 1 FROM settings WHERE key = 'sso.oidc.issuer' AND value = ?)", binds: [JSON.stringify(ISS)] };
    await setting("sso.oidc.issuer", "https://other.example.com");
    const s = await createSession(env, new Request(`${ORIGIN}/auth/sso/oidc/callback`), u, "oidc", false, guard);
    expect(s.started(await env.DB.batch(s.stmts))).toBe(false);
    expect(await all("SELECT COUNT(*) n FROM sessions WHERE user_id = ?", uid)).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) n FROM audit_log")).toEqual([{ n: 0 }]);
    await setting("sso.oidc.issuer", ISS);
    const ok = await createSession(env, new Request(`${ORIGIN}/auth/sso/oidc/callback`), u, "oidc", false, guard);
    expect(ok.started(await env.DB.batch(ok.stmts))).toBe(true);
  });

  it("a new issuer drops the identities bound under the old one", async () => {
    await addUser("a@example.com");
    await signIn("oidc");
    expect(await all("SELECT COUNT(*) n FROM sso_identities")).toEqual([{ n: 1 }]);
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    expect((await dash("/api/settings/sso/oidc", json(cookie, "PUT", { issuer: "" }))).status).toBe(200);
    expect(await all("SELECT COUNT(*) n FROM sso_identities")).toEqual([{ n: 0 }]);
  });

  it("email domains: set, validate, cap at 50, delete; audited", async () => {
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    const put = (d: string, b: unknown) => dash(`/api/settings/email-domains/${d}`, json(cookie, "PUT", b));
    const ok = await put("Example.COM", { joinRoleId: "member", enforceSso: true });
    expect(((await ok.json()) as { emailDomains: unknown }).emailDomains).toEqual([{ domain: "example.com", joinRoleId: "member", enforceSso: true }]);
    for (const [d, b, code] of [
      ["bad_domain", { joinRoleId: null, enforceSso: false }, "bad_domain"], ["-x.example.com", { joinRoleId: null, enforceSso: false }, "bad_domain"],
      ["a.example.com", { joinRoleId: "owner", enforceSso: false }, "owner_role"], ["a.example.com", { joinRoleId: "nope", enforceSso: false }, "bad_role"],
    ] as const) expect(await (await put(d, b)).json()).toEqual({ error: code });
    await env.DB.batch(Array.from({ length: 49 }, (_, i) => env.DB.prepare("INSERT INTO email_domains (domain, enforce_sso, updated_at) VALUES (?,0,1)").bind(`d${i}.example.com`)));
    const full = await put("more.example.com", { joinRoleId: null, enforceSso: false });
    expect([full.status, await full.json()]).toEqual([409, { error: "too_many" }]);
    expect((await put("example.com", { joinRoleId: null, enforceSso: false })).status).toBe(200); // an update still fits
    expect((await dash("/api/settings/email-domains/example.com", withCookie(cookie, { method: "DELETE" }))).status).toBe(200);
    expect((await dash("/api/settings/email-domains/example.com", withCookie(cookie, { method: "DELETE" }))).status).toBe(404);
    expect((await all("SELECT action FROM audit_log WHERE action LIKE 'email_domain.%' ORDER BY id")).map((r) => r.action)).toEqual(["email_domain.set", "email_domain.set", "email_domain.delete"]);
  });

  it("R14: a non-owner with every permission reads the page but every write is refused", async () => {
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('ra','All',?,0,1,1)", JSON.stringify(PERMS));
    await run("INSERT INTO email_domains (domain, enforce_sso, updated_at) VALUES ('example.com',0,1)");
    const s = await signedIn("s@example.com", { roleId: "ra" });
    expect((await dash("/api/settings/sso", withCookie(s.cookie))).status).toBe(200);
    for (const [m, path, body] of [
      ["PUT", "/api/settings/sso/google", { enabled: false }], ["PUT", "/api/settings/sso/github", { clientId: "x" }],
      ["PUT", "/api/settings/sso/oidc", { issuer: "https://evil.example" }],
      ["PUT", "/api/settings/email-domains/example.com", { joinRoleId: null, enforceSso: true }],
      ["PUT", "/api/settings/email-domains/new.example.com", { joinRoleId: "member", enforceSso: false }],
      ["DELETE", "/api/settings/email-domains/example.com", undefined],
    ] as const) {
      const r = await dash(path, json(s.cookie, m, body));
      expect([m, path, r.status, await r.json()]).toEqual([m, path, 403, { error: "forbidden" }]);
    }
    expect(await all("SELECT domain, enforce_sso FROM email_domains")).toEqual([{ domain: "example.com", enforce_sso: 0 }]);
    expect(await all("SELECT * FROM audit_log WHERE action IN ('sso.settings', 'email_domain.set', 'email_domain.delete')")).toEqual([]);
  });

  it("email_domain.set records the role name; an encoded domain in the path works", async () => {
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('r1','Editors','[]',0,1,1)");
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    expect((await dash(`/api/settings/email-domains/${encodeURIComponent("example.com")}`, json(cookie, "PUT", { joinRoleId: "r1", enforceSso: false }))).status).toBe(200);
    expect(await all("SELECT target_id, detail FROM audit_log WHERE action = 'email_domain.set'")).toEqual([
      { target_id: "example.com", detail: JSON.stringify({ domain: "example.com", joinRoleId: "r1", joinRoleName: "Editors", enforceSso: false }) },
    ]);
  });

  it("deleting a role an auto-join uses turns the auto-join off", async () => {
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('r1','R','[]',0,1,1)");
    await run("INSERT INTO email_domains (domain, join_role_id, enforce_sso, updated_at) VALUES ('example.com','r1',0,1)");
    const { cookie } = await signedIn("owner@example.com", { role: "owner" });
    expect((await dash("/api/roles/r1", withCookie(cookie, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBeLessThan(300);
    expect(await all("SELECT join_role_id FROM email_domains")).toEqual([{ join_role_id: null }]);
  });

  it("access mode: 404 before any auth check", async () => {
    e.AUTH_MODE = "access";
    expect((await dash("/api/settings/sso")).status).toBe(404);
    expect((await dash("/api/settings/email-domains/example.com", { method: "DELETE" })).status).toBe(404);
  });
});

describe("account identities", () => {
  it("lists and unlinks; an enforced person keeps their OIDC link", async () => {
    await addUser("a@example.com");
    await signIn("google");
    await signIn("oidc");
    const cookie = (await signIn("oidc")).headers.getSetCookie()[1]!.split(";")[0]!;
    const list = (await (await dash("/api/account/identities", withCookie(cookie))).json()) as { items: { provider: string; email: string }[] };
    expect(list.items.map((i) => [i.provider, i.email])).toEqual([["google", "a@example.com"], ["oidc", "a@example.com"]]);
    await run("INSERT INTO email_domains (domain, enforce_sso, updated_at) VALUES ('example.com',1,1)");
    const no = await dash("/api/account/identities/oidc", withCookie(cookie, { method: "DELETE" }));
    expect([no.status, await no.json()]).toEqual([403, { error: "sso_required" }]);
    expect((await dash("/api/account/identities/google", withCookie(cookie, { method: "DELETE" }))).status).toBe(204);
    expect((await dash("/api/account/identities/google", withCookie(cookie, { method: "DELETE" }))).status).toBe(404);
    expect(await all("SELECT detail FROM audit_log WHERE action = 'identity.unlink'")).toEqual([{ detail: JSON.stringify({ provider: "google" }) }]);
  });
});

describe("migration 0018", () => {
  it("sessions keeps both indexes and accepts the provider methods", async () => {
    const idx = (await all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
    expect(idx).toEqual(["sessions_expires", "sessions_user"]);
    const uid = await addUser("a@example.com");
    for (const m of ["email", "passkey", "google", "github", "oidc"])
      await run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,1,1,61)", m, `h-${m}`, uid, m);
    await expect(run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES ('x','hx',?,'sms',1,1,61)", uid)).rejects.toThrow();
  });
});
