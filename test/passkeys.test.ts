import { env } from "cloudflare:workers";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signInApp, withCookie } from "./helpers/session";
import { b64uText, softAuthenticator } from "./helpers/webauthn";

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  await env.DB.batch(["passkeys", "auth_challenges", "sessions", "login_tokens", "auth_limits", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => {
  vi.restoreAllMocks();
  e.AUTH_MODE = origMode;
});

const IP = "198.51.100.7";
const post = (path: string, body: unknown, init: RequestInit = {}) =>
  dash(path, { ...init, method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...(init.headers as Record<string, string> | undefined) }, body: JSON.stringify(body) });
const all = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<Record<string, unknown>>()).results;
const userId = async (email: string) => (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!.id;

const regOptions = async (cookie: string) => {
  const r = await post("/api/account/passkeys/options", {}, withCookie(cookie));
  return { r, o: r.status === 200 ? ((await r.json()) as PublicKeyCredentialCreationOptionsJSON) : null };
};
const register = (cookie: string, response: unknown, name?: string) => post("/api/account/passkeys", { response, ...(name === undefined ? {} : { name }) }, withCookie(cookie));
/** Options, authenticator response, POST: the whole registration for `cookie`. */
const addPasskey = async (cookie: string, dev = softAuthenticator()) => {
  const { o } = await regOptions(cookie);
  return { dev, r: await register(cookie, await dev.register(o!)) };
};
const loginOptions = async (headers: Record<string, string> = {}) =>
  (await (await post("/auth/passkey/options", {}, { headers })).json()) as PublicKeyCredentialRequestOptionsJSON;
const signIn = (response: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post("/auth/passkey/verify", { response, ...extra }, { headers });
const FAILED = '{"error":"passkey_failed"}';

describe("passkey registration", () => {
  it("offers options per R10 and stores a register challenge", async () => {
    const cookie = await signInApp("a@example.com");
    const { r, o } = await regOptions(cookie);
    expect(r.status).toBe(200);
    expect(o!.rp.id).toBe("dash.test");
    expect(o!.authenticatorSelection?.residentKey).toBe("required");
    expect(o!.authenticatorSelection?.userVerification).toBe("preferred");
    expect(o!.attestation).toBe("none");
    expect(o!.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(o!.excludeCredentials).toEqual([]);
    expect(o!.user.id).toBe(b64uText(await userId("a@example.com")));
    expect(await all("SELECT purpose, user_id FROM auth_challenges WHERE challenge = ?", o!.challenge)).toEqual([{ purpose: "register", user_id: await userId("a@example.com") }]);
  });

  it.each([-7, -257] as const)("registers alg %i: 201, default name, one passkey.add audit without key material", async (alg) => {
    const cookie = await signInApp("a@example.com");
    const { dev, r } = await addPasskey(cookie, softAuthenticator({ alg }));
    expect(r.status).toBe(201);
    const item = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(["backedUp", "createdAt", "id", "lastUsedAt", "name"]);
    expect(item).toMatchObject({ name: "Passkey", lastUsedAt: null, backedUp: false });
    const [row] = await all("SELECT * FROM passkeys");
    expect(row).toMatchObject({ id: item.id, credential_id: dev.credentialId, user_id: await userId("a@example.com"), counter: 0, transports: '["internal"]', name: "Passkey" });
    const audit = await all("SELECT action, target_type, target_id, detail FROM audit_log WHERE action = 'passkey.add'");
    expect(audit).toEqual([{ action: "passkey.add", target_type: "passkey", target_id: item.id, detail: '{"name":"Passkey"}' }]);
    // The next options exclude it.
    const { o } = await regOptions(cookie);
    expect(o!.excludeCredentials!.map((c) => c.id)).toEqual([dev.credentialId]);
  });

  it("uses the given name, else the device label", async () => {
    const cookie = await signInApp("a@example.com");
    const { o } = await regOptions(cookie);
    const r = await register(cookie, await softAuthenticator().register(o!), "  Work laptop ");
    expect(((await r.json()) as { name: string }).name).toBe("Work laptop");
    const ua = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };
    const { o: o2 } = await regOptions(cookie);
    const r2 = await post("/api/account/passkeys", { response: await softAuthenticator().register(o2!) }, withCookie(cookie, { headers: ua }));
    expect(((await r2.json()) as { name: string }).name).toBe("Passkey on Chrome on macOS");
  });

  it("refuses a used challenge, an expired challenge and a duplicate credential", async () => {
    const cookie = await signInApp("a@example.com");
    const dev = softAuthenticator();
    const { o } = await regOptions(cookie);
    const resp = await dev.register(o!);
    expect((await register(cookie, resp)).status).toBe(201);
    const again = await register(cookie, resp);
    expect(again.status).toBe(400);
    expect(await again.text()).toBe(FAILED);

    const { o: old } = await regOptions(cookie);
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = expires_at - 360 WHERE challenge = ?").bind(old!.challenge).run();
    const late = await register(cookie, await softAuthenticator().register(old!));
    expect([late.status, await late.text()]).toEqual([400, FAILED]);

    // Same credential again under a fresh challenge.
    const { o: o3 } = await regOptions(cookie);
    const dup = await register(cookie, await dev.register(o3!));
    expect([dup.status, await dup.text()]).toEqual([400, FAILED]);
    expect(await all("SELECT COUNT(*) n FROM passkeys")).toEqual([{ n: 1 }]);
  });

  it("Review Focus 5: options fetched by A, response posted by B fails", async () => {
    const a = await signInApp("a@example.com");
    const b = await signInApp("b@example.com");
    const { o } = await regOptions(a);
    const r = await register(b, await softAuthenticator().register(o!));
    expect([r.status, await r.text()]).toEqual([400, FAILED]);
    expect(await all("SELECT COUNT(*) n FROM passkeys")).toEqual([{ n: 0 }]);
  });

  it.each([[{ origin: "https://evil.test" }], [{ rpId: "evil.test" }]])("refuses an authenticator bound to %o", async (o) => {
    const cookie = await signInApp("a@example.com");
    const { o: opts } = await regOptions(cookie);
    const r = await register(cookie, await softAuthenticator(o).register(opts!));
    expect([r.status, await r.text()]).toEqual([400, FAILED]);
  });

  it("refuses garbage responses with passkey_failed and bad bodies with invalid_body", async () => {
    const cookie = await signInApp("a@example.com");
    for (const response of [null, {}, "x", { response: { clientDataJSON: "!!" } }]) {
      const r = await register(cookie, response);
      expect([r.status, await r.text()]).toEqual([400, FAILED]);
    }
    const extra = await post("/api/account/passkeys", { response: {}, extra: 1 }, withCookie(cookie));
    expect([extra.status, await extra.text()]).toEqual([400, '{"error":"invalid_body"}']);
    const long = await register(cookie, {}, "x".repeat(41));
    expect(long.status).toBe(400);
  });

  it("stops at 10 passkeys, also when two options were fetched at 9", async () => {
    const cookie = await signInApp("a@example.com");
    for (let i = 0; i < 9; i++) expect((await addPasskey(cookie)).r.status).toBe(201);
    const { o: o1 } = await regOptions(cookie);
    const { o: o2 } = await regOptions(cookie);
    expect((await register(cookie, await softAuthenticator().register(o1!))).status).toBe(201);
    const over = await register(cookie, await softAuthenticator().register(o2!));
    expect([over.status, await over.text()]).toEqual([409, '{"error":"passkey_limit"}']);
    const { r } = await regOptions(cookie);
    expect([r.status, await r.text()]).toEqual([409, '{"error":"passkey_limit"}']);
    expect(await all("SELECT COUNT(*) n FROM passkeys")).toEqual([{ n: 10 }]);
    expect(await all("SELECT COUNT(*) n FROM audit_log WHERE action = 'passkey.add'")).toEqual([{ n: 10 }]);
  });

  it("refuses bidi and control characters in the name", async () => {
    const cookie = await signInApp("a@example.com");
    for (const name of ["evil\u202Eexe", "a\u2066b", "a\nb", "a\u061Cb", "a\u200Bb", "a\u200Cb", "a\u200Db", "a\uFEFFb"]) {
      const r = await register(cookie, {}, name);
      expect([r.status, await r.text()]).toEqual([400, '{"error":"invalid_body"}']);
    }
  });

  it("holds at most 10 open registration challenges per person", async () => {
    const cookie = await signInApp("a@example.com");
    for (let i = 0; i < 10; i++) expect((await regOptions(cookie)).r.status).toBe(200);
    const { r } = await regOptions(cookie);
    expect([r.status, await r.text()]).toEqual([429, '{"error":"too_many_attempts"}']);
    // Expired ones do not count.
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = 1").run();
    expect((await regOptions(cookie)).r.status).toBe(200);
  });

  it("needs a session", async () => {
    const r = await post("/api/account/passkeys/options", {});
    expect(r.status).toBe(401);
  });
});

describe("passkey sign-in", () => {
  /** A signed-in person with one registered passkey; returns its authenticator. */
  const enrolled = async (email = "a@example.com", alg: -7 | -257 = -7) => {
    const cookie = await signInApp(email);
    const { dev, r } = await addPasskey(cookie, softAuthenticator({ alg }));
    expect(r.status).toBe(201);
    return { dev, cookie, id: await userId(email) };
  };

  it("offers discoverable-credential options without a cookie", async () => {
    const r = await post("/auth/passkey/options", {});
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const o = (await r.json()) as PublicKeyCredentialRequestOptionsJSON;
    expect(o.allowCredentials).toEqual([]);
    expect(o.rpId).toBe("dash.test");
    expect(o.userVerification).toBe("preferred");
    expect(await all("SELECT purpose, user_id FROM auth_challenges WHERE challenge = ?", o.challenge)).toEqual([{ purpose: "login", user_id: null }]);
  });

  it.each([-7, -257] as const)("signs in with alg %i: cookie, audit, counter and last_used_at; the replay fails", async (alg) => {
    const { dev, id } = await enrolled("a@example.com", alg);
    const resp = await dev.authenticate(await loginOptions(), { userHandle: b64uText(id) });
    const r = await signIn(resp, { next: "/links?x=1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ next: "/links?x=1" });
    expect(r.headers.get("set-cookie")).toMatch(/^__Host-lw_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/);
    const [s] = await all("SELECT id, method FROM sessions WHERE user_id = ? AND method = 'passkey'", id);
    expect(s).toBeDefined();
    expect(await all("SELECT detail FROM audit_log WHERE action = 'auth.sign_in' AND target_id = ?", s!.id)).toEqual([{ detail: '{"method":"passkey"}' }]);
    const [pk] = await all("SELECT counter, last_used_at FROM passkeys");
    expect(pk!.counter).toBe(1);
    expect(pk!.last_used_at).toBeGreaterThan(0);

    const replay = await signIn(resp);
    expect([replay.status, await replay.text()]).toEqual([400, FAILED]);
  });

  it("lets only one of two racing assertions with the same counter make a session", async () => {
    const { dev, id } = await enrolled();
    const [o1, o2] = [await loginOptions(), await loginOptions()];
    const [a1, a2] = [await dev.authenticate(o1, { counter: 1 }), await dev.authenticate(o2, { counter: 1 })];
    const rs = await Promise.all([signIn(a1), signIn(a2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await all("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND method = 'passkey'", id)).toEqual([{ n: 1 }]);
    expect(await all("SELECT counter FROM passkeys")).toEqual([{ counter: 1 }]);
  });

  it("accepts an authenticator that always reports counter 0", async () => {
    const { dev } = await enrolled();
    expect((await signIn(await dev.authenticate(await loginOptions(), { counter: 0 }))).status).toBe(200);
    expect((await signIn(await dev.authenticate(await loginOptions(), { counter: 0 }))).status).toBe(200);
  });

  it("rate limits options per IP prefix", async () => {
    const h = { "cf-connecting-ip": "192.0.2.50" };
    for (let i = 0; i < 20; i++) expect((await post("/auth/passkey/options", {}, { headers: h })).status).toBe(200);
    const r = await post("/auth/passkey/options", {}, { headers: { "cf-connecting-ip": "192.0.2.51" } });
    expect([r.status, await r.text()]).toEqual([429, '{"error":"too_many_attempts"}']);
    expect(await all("SELECT COUNT(*) n FROM auth_challenges")).toEqual([{ n: 20 }]);
  });

  it("keeps the options budget apart from the sign-in email budget", async () => {
    const h = { "cf-connecting-ip": "192.0.2.60" };
    for (let i = 0; i < 20; i++) expect((await post("/auth/passkey/options", {}, { headers: h })).status).toBe(200);
    expect((await all("SELECT key FROM auth_limits WHERE key LIKE 'opts:%'")).length).toBe(1);
    await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,'member','active',1)").bind(crypto.randomUUID(), "z@example.com").run();
    fakeResend();
    const r = await post("/auth/email", { email: "z@example.com" }, { headers: { "cf-connecting-ip": "192.0.2.61" } });
    expect(r.status).toBe(202);
  });

  it("refuses a registration challenge at sign-in and a sign-in challenge at registration", async () => {
    const cookie = await signInApp("a@example.com");
    const { dev } = await addPasskey(cookie);
    const { o } = await regOptions(cookie);
    const asLogin = await signIn(await dev.authenticate({ ...o!, rpId: "dash.test", allowCredentials: [] } as unknown as PublicKeyCredentialRequestOptionsJSON));
    expect([asLogin.status, await asLogin.text()]).toEqual([400, FAILED]);
    const login = await loginOptions();
    const asReg = await register(cookie, await softAuthenticator().register({ ...login, rp: { id: "dash.test", name: "x" } } as unknown as PublicKeyCredentialCreationOptionsJSON));
    expect([asReg.status, await asReg.text()]).toEqual([400, FAILED]);
    expect(await all("SELECT COUNT(*) n FROM passkeys")).toEqual([{ n: 1 }]);
  });

  it("deletes another session's row when sign-in carries its cookie and issues a different cookie", async () => {
    const cookie = await signInApp("a@example.com");
    const { dev } = await addPasskey(cookie);
    const before = (await all("SELECT id FROM sessions")).map((r) => r.id);
    const r = await signIn(await dev.authenticate(await loginOptions()), {}, { cookie });
    expect(r.status).toBe(200);
    const fresh = /^([^;]*)/.exec(r.headers.get("set-cookie")!)![1]!;
    expect(fresh).not.toBe(cookie);
    const after = (await all("SELECT id FROM sessions")).map((x) => x.id);
    expect(after.length).toBe(1);
    expect(after).not.toContain(before[0]);
  });

  it("caps the default name at 40 characters", async () => {
    const cookie = await signInApp("a@example.com");
    const { o } = await regOptions(cookie);
    const ua = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };
    const r = await post("/api/account/passkeys", { response: await softAuthenticator().register(o!) }, withCookie(cookie, { headers: ua }));
    expect(((await r.json()) as { name: string }).name.length).toBeLessThanOrEqual(40);
  });

  it("signs in without a userHandle", async () => {
    const { dev } = await enrolled();
    expect((await signIn(await dev.authenticate(await loginOptions()))).status).toBe(200);
  });

  it("refuses a counter lower than the stored one", async () => {
    const { dev } = await enrolled();
    await env.DB.prepare("UPDATE passkeys SET counter = 5").run();
    const r = await signIn(await dev.authenticate(await loginOptions(), { counter: 3 }));
    expect([r.status, await r.text()]).toEqual([400, FAILED]);
    expect(await all("SELECT counter FROM passkeys")).toEqual([{ counter: 5 }]);
  });

  it("answers an unknown credential byte-identically to a bad signature", async () => {
    const { dev } = await enrolled();
    const bad = await dev.authenticate(await loginOptions());
    const sig = bad.response.signature;
    bad.response.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const r1 = await signIn(bad);
    const r2 = await signIn(await softAuthenticator().authenticate(await loginOptions()));
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(await r1.text()).toBe(FAILED);
    expect(await r2.text()).toBe(FAILED);
    expect([...r1.headers].map(([k, v]) => `${k}:${v}`).sort()).toEqual([...r2.headers].map(([k, v]) => `${k}:${v}`).sort());
    expect(r1.headers.get("set-cookie")).toBeNull();
  });

  it("refuses another person's userHandle", async () => {
    const { dev } = await enrolled();
    const other = await enrolled("b@example.com");
    const r = await signIn(await dev.authenticate(await loginOptions(), { userHandle: b64uText(other.id) }));
    expect([r.status, await r.text()]).toEqual([400, FAILED]);
  });

  it.each([[{ origin: "https://evil.test" }], [{ rpId: "evil.test" }]])("refuses an assertion made for %o", async (o) => {
    const { dev } = await enrolled();
    // Same registered key, phishing-site context.
    const resp = await dev.authenticate(await loginOptions(), o);
    const r = await signIn(resp);
    expect([r.status, await r.text()]).toEqual([400, FAILED]);
  });

  it("answers 403 disabled for a disabled person's valid passkey", async () => {
    const { dev, id } = await enrolled();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id).run();
    const r = await signIn(await dev.authenticate(await loginOptions()));
    expect([r.status, await r.text()]).toEqual([403, '{"error":"disabled"}']);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the 21st failure from one prefix with 429, before any check", async () => {
    for (let i = 0; i < 20; i++) expect((await signIn({}, {}, { "cf-connecting-ip": "192.0.2.10" })).status).toBe(400);
    const r = await signIn({}, {}, { "cf-connecting-ip": "192.0.2.11" });
    expect([r.status, await r.text()]).toEqual([429, '{"error":"too_many_attempts"}']);
    // Another prefix is unaffected.
    expect((await signIn({}, {}, { "cf-connecting-ip": "192.0.3.10" })).status).toBe(400);
  });

  it("turns an unsafe next into /", async () => {
    const { dev } = await enrolled();
    const r = await signIn(await dev.authenticate(await loginOptions()), { next: "https://evil.example" });
    expect(await r.json()).toEqual({ next: "/" });
  });

  it("prunes expired challenges on options", async () => {
    await env.DB.prepare("INSERT INTO auth_challenges (challenge, purpose, user_id, expires_at) VALUES ('old', 'login', NULL, 1)").run();
    await loginOptions();
    expect(await all("SELECT challenge FROM auth_challenges WHERE challenge = 'old'")).toEqual([]);
  });

  it("keeps the /auth guard: Origin required, JSON only, strict body", async () => {
    const noOrigin = await post("/auth/passkey/options", {}, { headers: { origin: "" } });
    expect(noOrigin.status).toBe(403);
    const r = await post("/auth/passkey/verify", { response: {}, extra: 1 });
    expect([r.status, await r.text()]).toEqual([400, '{"error":"invalid_body"}']);
  });
});

describe("access mode", () => {
  it("answers 404 on the passkey routes", async () => {
    e.AUTH_MODE = "access";
    expect((await post("/auth/passkey/options", {})).status).toBe(404);
    expect((await post("/auth/passkey/verify", { response: {} })).status).toBe(404);
    expect((await post("/api/account/passkeys/options", {})).status).toBe(404);
    expect((await post("/api/account/passkeys", { response: {} })).status).toBe(404);
  });
});
