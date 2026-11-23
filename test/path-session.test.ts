// S8c Task 3: session cookie, passkeys, mail links and return paths in path mode (R6, R7, R9, R12, R13).
import { env } from "cloudflare:workers";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { wrapper } from "../src/index";
import { resetMcpCache } from "../src/mcp/switch";
import { handleRedirect } from "../src/redirect";
import { clearCookie, createSession, readCookie, safeNext } from "../src/session";
import { rp } from "../src/webauthn";
import { pathEnv, seedShort, testCtx } from "./helpers/path";
import { fakeResend } from "./helpers/resend";
import { signedIn } from "./helpers/session";
import { softAuthenticator } from "./helpers/webauthn";

const O = "https://short.test";
const PATH_COOKIE = /^__Secure-lw_session=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/;
const hostEnv = () => ({ ...env, DASHBOARD_HOST: "dash.test", AUTH_MODE: "app" }) as Env;
const now = () => Math.floor(Date.now() / 1000);

/** The wrapper with a context whose waitUntil work (the mail) can be awaited. */
async function go(path: string, init: RequestInit = {}, e: Env = pathEnv()): Promise<Response> {
  const bg: Promise<unknown>[] = [];
  const ctx = { ...testCtx(), waitUntil: (p: Promise<unknown>) => void bg.push(p) } as unknown as ExecutionContext;
  const r = await wrapper(new Request(`${O}${path}`, { redirect: "manual", ...init }), e, ctx);
  await Promise.all(bg);
  return r;
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  go(path, { method: "POST", headers: { origin: O, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const pair = (setCookie: string) => /^([^;]*)/.exec(setCookie)![1]!;

beforeEach(async () => {
  await env.DB.batch(["passkeys", "auth_challenges", "login_tokens", "auth_limits", "sessions", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await seedShort();
});
afterEach(() => vi.restoreAllMocks());

/** Email sign-in through the wrapper: returns the mail and the verify response. */
async function emailSignIn(email = "path-owner@example.com") {
  const fake = fakeResend();
  const ask = await post("/dashboard/auth/email", { email });
  expect(ask.status).toBe(202);
  const mail = fake.sent.at(-1)!;
  const r = await post("/dashboard/auth/email/verify", { token: fake.tokenFrom() });
  return { mail, r };
}

describe("path mode session cookie (R6)", () => {
  it("email sign-in sets the prefix-scoped __Secure- cookie, which works only under the prefix", async () => {
    const { mail, r } = await emailSignIn();
    expect(mail.text).toMatch(/https:\/\/short\.test\/dashboard\/sign-in#token=[A-Za-z0-9_-]{43}/);
    expect(mail.html).toMatch(/href="https:\/\/short\.test\/dashboard\/sign-in#token=/);
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(PATH_COOKIE);
    const cookie = pair(sc);

    const me = await go("/dashboard/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("path-owner@example.com");

    const hello = await go("/hello", { headers: { cookie } });
    expect([hello.status, hello.headers.get("location"), hello.headers.get("set-cookie")]).toEqual([302, "https://dest.example.com/hello", null]);

    const root = await go("/api/me", { headers: { cookie } });
    const plain = await handleRedirect(new Request(`${O}/api/me`), pathEnv(), now(), testCtx());
    expect([root.status, root.headers.get("location"), await root.text()]).toEqual([plain.status, plain.headers.get("location"), await plain.text()]);
  });

  it("sign-out clears the cookie with the same name and Path", async () => {
    const cookie = pair((await emailSignIn()).r.headers.get("set-cookie")!);
    const r = await post("/dashboard/api/account/sign-out", {}, { cookie });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("set-cookie")).toBe("__Secure-lw_session=; Path=/dashboard; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
    expect(clearCookie(pathEnv())).toBe("__Secure-lw_session=; Path=/dashboard; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
    expect(clearCookie(hostEnv())).toBe("__Host-lw_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
  });

  it("each mode reads only its own cookie name, so switching modes signs everyone out (R13)", async () => {
    const v = "a".repeat(43);
    const req = (c: string) => new Request(`${O}/`, { headers: { cookie: c } });
    expect(readCookie(req(`__Host-lw_session=${v}`), pathEnv())).toBeNull();
    expect(readCookie(req(`__Secure-lw_session=${v}`), pathEnv())).toBe(v);
    expect(readCookie(req(`__Secure-lw_session=${v}`), hostEnv())).toBeNull();
    expect(readCookie(req(`__Host-lw_session=${v}`), hostEnv())).toBe(v);

    // A real host-mode session is refused under the prefix.
    const host = await signedIn(`hm-${crypto.randomUUID()}@example.com`);
    expect((await go("/dashboard/api/me", { headers: { cookie: host.cookie } })).status).toBe(401);
    const renamed = `__Secure-lw_session=${host.value}`;
    expect((await go("/dashboard/api/me", { headers: { cookie: renamed } })).status).toBe(200);
  });

  it("createSession in host mode is unchanged", async () => {
    const u = await signedIn(`h2-${crypto.randomUUID()}@example.com`);
    const { setCookie } = await createSession(hostEnv(), new Request("https://dash.test/x"), u.user, "email");
    expect(setCookie).toMatch(/^__Host-lw_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/);
  });
});

describe("path mode return paths (R9)", () => {
  it.each([["/../hello", "/"], ["/./../x", "/"], ["/%2e%2e/x", "/"], ["//x", "/"], ["/links?a=1", "/links?a=1"], ["/", "/"],
    // A next that already carries the prefix is stripped once (the web does the same), so it is never doubled.
    ["/dashboard/agents?sel=1", "/agents?sel=1"], ["/dashboard", "/"], ["/dashboard?x=1", "/?x=1"], ["/dashboard#a", "/#a"],
    ["/dashboard//evil.example", "/"], ["/dashboard/../hello", "/"], ["/dashboard/dashboard/x", "/dashboard/x"], ["/dashboardx", "/dashboardx"]])("%j -> %j", (raw, want) => {
    expect(safeNext(raw, O, "/dashboard")).toBe(want);
  });

  it("host mode keeps a /dashboard next as an inner path", () => {
    expect(safeNext("/dashboard/agents", "https://dash.test")).toBe("/dashboard/agents");
  });

  it("a stored next is checked again on verify but never stripped a second time", async () => {
    const fake = fakeResend();
    // Stored as "/dashboard/x" (one strip of the doubled prefix); a second strip on verify would turn it into "/x".
    await post("/dashboard/auth/email", { email: "path-owner@example.com", next: "/dashboard/dashboard/x" });
    const r = await post("/dashboard/auth/email/verify", { token: fake.tokenFrom() });
    expect(await r.json()).toEqual({ next: "/dashboard/x" });
  });

  it("a sign-in link carrying /../hello returns to the dashboard root", async () => {
    const fake = fakeResend();
    await post("/dashboard/auth/email", { email: "path-owner@example.com", next: "/../hello" });
    const r = await post("/dashboard/auth/email/verify", { token: fake.tokenFrom() });
    expect(await r.json()).toEqual({ next: "/" });
  });

  it("/dashboard/authorize signed out sends to the prefixed sign-in with an inner next", async () => {
    resetMcpCache();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'mcp.enabled'").run();
    const r = await go("/dashboard/authorize?response_type=code&client_id=x", { headers: { "sec-fetch-dest": "document" } }, pathEnv({ MCP_ENABLED: "1" }));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")!.startsWith("/dashboard/sign-in?next=%2Fauthorize%3F")).toBe(true);
    resetMcpCache();
  });
});

describe("path mode mail links (R12)", () => {
  it("the invite mail links <base>/join", async () => {
    const cookie = pair((await emailSignIn()).r.headers.get("set-cookie")!);
    const fake = fakeResend();
    const r = await post("/dashboard/api/users/invite", { email: `inv-${crypto.randomUUID()}@example.com`, roleId: "member" }, { cookie });
    expect(r.status).toBeLessThan(300);
    const m = fake.sent.at(-1)!;
    expect(m.text).toContain("Open https://short.test/dashboard/join and sign in");
    expect(m.html).toContain('href="https://short.test/dashboard/join"');
  });
});

describe("path mode passkeys (R7)", () => {
  it("rp follows the dashboard origin in both modes", () => {
    expect(rp(pathEnv())).toEqual({ rpID: "short.test", origin: "https://short.test" });
    expect(rp(hostEnv())).toEqual({ rpID: "dash.test", origin: "https://dash.test" });
  });

  it("registers and signs in with rp.id short.test and origin https://short.test; the old host's binding is refused", async () => {
    const cookie = pair((await emailSignIn()).r.headers.get("set-cookie")!);
    const o = (await (await post("/dashboard/api/account/passkeys/options", {}, { cookie })).json()) as PublicKeyCredentialCreationOptionsJSON;
    expect(o.rp.id).toBe("short.test");
    const dev = softAuthenticator();
    expect((await post("/dashboard/api/account/passkeys", { response: await dev.register(o) }, { cookie })).status).toBeLessThan(300);

    const lo = async () => (await (await post("/dashboard/auth/passkey/options", {})).json()) as PublicKeyCredentialRequestOptionsJSON;
    const l1 = await lo();
    expect(l1.rpId).toBe("short.test");
    const bad = await post("/dashboard/auth/passkey/verify", { response: await dev.authenticate(l1, { origin: "https://dash.test" }) });
    expect(bad.status).toBe(400);
    const ok = await post("/dashboard/auth/passkey/verify", { response: await dev.authenticate(await lo()) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(PATH_COOKIE);
  });
});
