import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";
import { dashUrl } from "../../src/dash";
import type { Env } from "../../src/env";
import worker, { wrapper } from "../../src/index";
import { ORIGIN, tokenFor } from "./access";
import { testCtx } from "./path";
import { fakeResend } from "./resend";
import { signInApp } from "./session";

export const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
/**
 * `path` is an inner (dashboard) path. Without `e`: the default worker on the host-mode ORIGIN. With `e`: straight through
 * the wrapper at dashUrl(e, path) (path mode: under the prefix), with a context whose waitUntil work is awaited.
 */
async function fetchW(path: string, init?: RequestInit, e?: Env): Promise<Response> {
  if (!e) return exports.default.fetch(`${ORIGIN}${path}`, init);
  const bg: Promise<unknown>[] = [];
  const ctx = { ...testCtx(), waitUntil: (p: Promise<unknown>) => void bg.push(p) } as unknown as ExecutionContext;
  const r = await wrapper(new Request(dashUrl(e, path), { redirect: "manual", ...init }), e, ctx);
  await Promise.all(bg);
  return r;
}
const originOf = (e?: Env) => (e ? `https://${e.DASHBOARD_HOST}` : ORIGIN);
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh PKCE S256 pair. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}

/** DCR like Claude Code; a random IP and cleared registration and approval limits so suites never hit the /register caps. */
export async function registerClient(redirect = CLAUDE_CB, o: { name?: string | null; auth?: string } = {}, e?: Env): Promise<{ clientId: string; clientSecret?: string }> {
  await env.DB.prepare("DELETE FROM auth_limits WHERE key LIKE 'reg:%' OR key LIKE 'authz:%'").run();
  const ip = `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.1`;
  const r = await fetchW("/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      redirect_uris: [redirect], ...(o.name === null ? {} : { client_name: o.name ?? "Claude" }),
      grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: o.auth ?? "none",
    }),
  }, e);
  if (r.status !== 201) throw new Error(`register ${r.status}`);
  const j = await r.json<{ client_id: string; client_secret?: string }>();
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

export const authorizePath = (q: Record<string, string | undefined>) =>
  `/authorize?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined))}`;

/**
 * The signed-in credentials for `email` in the current AUTH_MODE: a session cookie (app) or an Access JWT (access, needs setupAccess).
 * `roleId` puts the (member) person on that custom role first.
 */
export async function signInHeaders(email: string, roleId?: string, e?: Env): Promise<Record<string, string>> {
  const onRole = () => roleId ? env.DB.prepare("UPDATE users SET role_id = ? WHERE email = ?").bind(roleId, email).run() : null;
  if (e) {
    // The real email flow through the wrapper, so the cookie is the env's own (path mode: __Secure-, Path=<prefix>).
    await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) SELECT ?,?,'member','active',1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)")
      .bind(crypto.randomUUID(), email, email).run();
    const fake = fakeResend();
    const json = (body: unknown) => ({ method: "POST", headers: { origin: originOf(e), "content-type": "application/json" }, body: JSON.stringify(body) });
    const ask = await fetchW("/auth/email", json({ email }), e);
    if (ask.status !== 202) throw new Error(`sign-in request ${ask.status}`);
    const r = await fetchW("/auth/email/verify", json({ token: fake.tokenFrom() }), e);
    vi.restoreAllMocks();
    if (r.status !== 200) throw new Error(`sign-in verify ${r.status}`);
    await onRole();
    return { cookie: /^([^;]*)/.exec(r.headers.get("set-cookie") ?? "")![1]! };
  }
  if ((env as { AUTH_MODE?: string }).AUTH_MODE === "app") {
    const cookie = await signInApp(email);
    vi.restoreAllMocks();
    await onRole();
    return { cookie };
  }
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) SELECT ?,?,'member','active',1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)")
    .bind(crypto.randomUUID(), email, email).run();
  await onRole();
  return { "Cf-Access-Jwt-Assertion": await tokenFor(email) };
}

/** The `name=value` pairs of every Set-Cookie on `r`, joined for a `cookie` request header. */
export const cookiesFrom = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
export const handleFrom = (html: string) => /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
export const uidFrom = (html: string) => /name="uid" value="([^"]+)"/.exec(html)?.[1] ?? "";

/** GET /authorize as `auth`; returns the page, its handle and the consent binding cookie. */
export async function openConsent(path: string, auth: Record<string, string>, e?: Env) {
  const res = await fetchW(path, { headers: auth, redirect: "manual" }, e);
  const html = await res.text();
  return { res, html, handle: handleFrom(html), uid: uidFrom(html), binding: cookiesFrom(res) };
}

/** POST /authorize from the dashboard origin with the consent form fields. */
export function postConsent(auth: Record<string, string>, binding: string, form: Record<string, string>, origin: string | null = ORIGIN, path = "/authorize", e?: Env) {
  const cookie = [auth.cookie, binding].filter(Boolean).join("; ");
  const headers: Record<string, string> = { ...auth, "content-type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;
  return fetchW(path, { method: "POST", headers, body: new URLSearchParams(form).toString(), redirect: "manual" }, e);
}

export const token = (form: Record<string, string>, e?: Env) =>
  fetchW("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }, e);

/** Registers, approves and exchanges the code; returns the code too so a test can replay it. */
/** `clientId` reuses an already registered client (registered for `redirect`) instead of registering a new one; `env` runs it through the wrapper. */
export async function connectAgentFull(email: string, o: { write?: boolean; del?: boolean; redirect?: string; name?: string; clientId?: string; roleId?: string; env?: Env } = {}) {
  const redirect = o.redirect ?? CLAUDE_CB;
  const e = o.env;
  const clientId = o.clientId ?? (await registerClient(redirect, { name: o.name }, e)).clientId;
  const { verifier, challenge } = await pkce();
  const auth = await signInHeaders(email, o.roleId, e);
  const state = crypto.randomUUID();
  const page = await openConsent(authorizePath({
    response_type: "code", client_id: clientId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256",
  }), auth, e);
  if (page.res.status !== 200) throw new Error(`authorize page ${page.res.status}`);
  const form: Record<string, string> = { handle: page.handle, uid: page.uid, action: "approve", access: o.write ? "write" : "read" };
  if (o.del) form.del = "1";
  const done = await postConsent(auth, page.binding, form, originOf(e), "/authorize", e);
  if (done.status !== 302) throw new Error(`approve ${done.status}`);
  const back = new URL(done.headers.get("location")!);
  if (back.searchParams.get("state") !== state) throw new Error("state mismatch");
  const code = back.searchParams.get("code")!;
  const exchange = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier };
  const t = await token(exchange, e);
  if (t.status !== 200) throw new Error(`token ${t.status} ${await t.text()}`);
  const tok = await t.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  const row = await env.DB.prepare("SELECT id FROM agent_connections WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(clientId).first<{ id: string }>();
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresIn: tok.expires_in, connId: row!.id, clientId, exchange };
}

export async function connectAgent(email: string, o: { write?: boolean; del?: boolean; redirect?: string; roleId?: string; env?: Env } = {}):
  Promise<{ accessToken: string; refreshToken: string; connId: string; clientId: string }> {
  const { accessToken, refreshToken, connId, clientId } = await connectAgentFull(email, o);
  return { accessToken, refreshToken, connId, clientId };
}

/**
 * JSON-RPC over POST /mcp; an SSE answer is read from its first `data:` line. With `ctx` the worker runs in that execution
 * context, so a test can waitOnExecutionContext(ctx) for its waitUntil work (the tool_calls row).
 */
export async function mcpCall(token: string, method: string, params?: unknown, ctx?: ExecutionContext, e?: Env): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method: "POST",
    // The edge always sends Host; a test fetch does not, and the MCP handler checks it against DASHBOARD_HOST.
    headers: { host: new URL(originOf(e)).host, authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  };
  const r = !ctx ? await fetchW("/mcp", init, e)
    : e ? await wrapper(new Request(dashUrl(e, "/mcp"), init), e, ctx) : await worker.fetch(new Request(`${ORIGIN}/mcp`, init), env, ctx);
  const text = await r.text();
  const data = (r.headers.get("content-type") ?? "").includes("text/event-stream") ? /^data: ?(.*)$/m.exec(text)?.[1] ?? "" : text;
  let body: unknown = null;
  try { body = data ? JSON.parse(data) : null; } catch { body = data; }
  return { status: r.status, body };
}
