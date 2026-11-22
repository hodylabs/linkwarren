import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/index";
import { SESSION_COOKIE, createSession } from "../../src/session";
import type { UserRow } from "../../src/types";
import { ORIGIN, dash } from "./access";
import { fakeResend } from "./resend";

/** Inserts an active user and signs them in; returns the cookie value and the `cookie` request header. */
export async function signedIn(email = "a@example.com", o: Partial<UserRow> = {}) {
  const user: UserRow = { id: crypto.randomUUID(), email, name: null, role: "member", status: "active", createdAt: 1, ...o };
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',?)")
    .bind(user.id, user.email, user.role, user.createdAt).run();
  const { setCookie, stmts } = await createSession(env, new Request("https://dash.test/auth/email/verify"), user, "email");
  await env.DB.batch(stmts);
  // Sessions start only for active people; a non-active fixture is a person whose status changed after sign-in.
  if (user.status !== "active") await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(user.status, user.id).run();
  const value = /^[^=]+=([^;]*)/.exec(setCookie)![1]!;
  return { user, value, setCookie, cookie: `${SESSION_COOKIE}=${value}` };
}

/**
 * Signs `email` in through the real email flow (POST /auth/email, the mailed token, POST /auth/email/verify) and returns the
 * `cookie` request header. Inserts an active member first when the address is unknown. Leaves the fakeResend fetch stub
 * installed; restore it with vi.restoreAllMocks().
 */
export async function signInApp(email: string): Promise<string> {
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) SELECT ?,?,'member','active',1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)")
    .bind(crypto.randomUUID(), email, email).run();
  const fake = fakeResend();
  const ctx = createExecutionContext();
  const ask = await worker.fetch(new Request(`${ORIGIN}/auth/email`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email }),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  if (ask.status !== 202) throw new Error(`sign-in request ${ask.status}`);
  const r = await dash("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fake.tokenFrom() }) });
  if (r.status !== 200) throw new Error(`sign-in verify ${r.status}`);
  return /^([^;]*)/.exec(r.headers.get("set-cookie") ?? "")![1]!;
}

/** `init` with the session cookie header added, for dash() calls. */
export const withCookie = (cookie: string, init: RequestInit = {}): RequestInit =>
  ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });
