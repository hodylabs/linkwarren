import { env } from "cloudflare:workers";
import { SESSION_COOKIE, createSession } from "../../src/session";
import type { UserRow } from "../../src/types";

/** Inserts an active user and signs them in; returns the cookie value and the `cookie` request header. */
export async function signedIn(email = "a@example.com", o: Partial<UserRow> = {}) {
  const user: UserRow = { id: crypto.randomUUID(), email, name: null, role: "member", status: "active", createdAt: 1, ...o };
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,?)")
    .bind(user.id, user.email, user.role, user.status, user.createdAt).run();
  const { setCookie, stmts } = await createSession(env, new Request("https://dash.test/auth/email/verify"), user, "email");
  await env.DB.batch(stmts);
  const value = /^[^=]+=([^;]*)/.exec(setCookie)![1]!;
  return { user, value, setCookie, cookie: `${SESSION_COOKIE}=${value}` };
}
