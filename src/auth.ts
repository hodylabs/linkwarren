import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createMiddleware } from "hono/factory";
import { auditStmt } from "./audit";
import { displayName } from "./email";
import { readSession } from "./session";
import { getSettings } from "./settings";
import type { Env } from "./env";
import { ROLE_JOIN, USER_COLS } from "./roles";
import { rowToUser, type SessionRef, type UserRow } from "./types";
import { FULL_GRANT, type Grant } from "./principal";

// shortcut: remote JWKS cached per team URL for the isolate lifetime; jose refetches on unknown kid.
const remoteKeys = new Map<string, JWTVerifyGetKey>();

let warnedLocalKeys = false;

function defaultKeys(env: Env): JWTVerifyGetKey {
  if (env.ACCESS_JWKS_JSON) {
    if (!warnedLocalKeys) {
      warnedLocalKeys = true;
      console.warn("ACCESS_JWKS_JSON is set: using local test keys");
    }
    return createLocalJWKSet(JSON.parse(env.ACCESS_JWKS_JSON));
  }
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  let k = remoteKeys.get(url);
  if (!k) remoteKeys.set(url, (k = createRemoteJWKSet(new URL(url))));
  return k;
}

/** Verifies a Cloudflare Access JWT; any failure (signature, alg, iss, aud, exp, shape) yields null. */
export async function verifyAccess(token: string, env: Env, keys?: JWTVerifyGetKey): Promise<{ email: string } | null> {
  // jose skips the aud check when audience is undefined, so refuse to verify without both settings.
  if (!env.ACCESS_AUD?.trim() || !env.ACCESS_TEAM_DOMAIN?.trim()) return null;
  try {
    const { payload } = await jwtVerify(token, keys ?? defaultKeys(env), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    const email = payload.email;
    return typeof email === "string" && email.trim() ? { email: email.trim() } : null;
  } catch {
    return null;
  }
}

export const findUser = async (env: Env, email: string) => {
  const r = await env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.email = ?`).bind(email).first(); // email column is NOCASE
  return r ? rowToUser(r) : null;
};

/** First-run owner: one atomic conditional insert, so concurrent first sign-ins can never create two owners. */
export async function bootstrapOwner(env: Env, email: string): Promise<void> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, name, role, status, created_at) SELECT ?, ?, NULL, 'owner', 'active', ? WHERE NOT EXISTS (SELECT 1 FROM users)",
    ).bind(id, email, now),
    auditStmt(env, { actorId: id, action: "user.bootstrap", targetType: "user", targetId: id, detail: { email } },
      { sql: "EXISTS (SELECT 1 FROM users WHERE id = ?)", binds: [id] }),
  ]);
}

export type AuthMode = "app" | "access";

/** R2: unset or blank is app; "app" / "access" (trimmed, exact lowercase); anything else is null and fails closed. */
export function authMode(env: Env): AuthMode | null {
  const raw: unknown = env.AUTH_MODE; // a non-string var (number, boolean) is a misconfiguration too, not a crash
  if (raw != null && typeof raw !== "string") return null;
  const m = (raw ?? "").trim();
  return m === "" || m === "app" ? "app" : m === "access" ? "access" : null;
}

/** Maps a verified email to a usable user: owner bootstrap, guarded invited activation, re-read. Shared by both modes. */
export async function resolveUser(env: Env, email: string): Promise<{ user: UserRow } | { status: 403; error: "not_invited" | "disabled" }> {
  let user = await findUser(env, email);
  if (!user && env.OWNER_EMAIL && email.toLowerCase() === env.OWNER_EMAIL.trim().toLowerCase()) {
    await bootstrapOwner(env, email);
    user = await findUser(env, email);
  }
  if (!user) return { status: 403, error: "not_invited" };
  if (user.status === "disabled") return { status: 403, error: "disabled" };

  if (user.status === "invited") {
    // Audit first, guarded on still being invited, so a racing sign-in audits once.
    await env.DB.batch([
      auditStmt(env, { actorId: user.id, action: "user.activate", targetType: "user", targetId: user.id },
        { sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'invited')", binds: [user.id] }),
      env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'invited'").bind(user.id),
    ]);
    // Re-read: a concurrent disable may have landed, so trust the stored status, not the one we wrote.
    user = await findUser(env, email);
    if (!user || user.status !== "active") return { status: 403, error: user ? "disabled" : "not_invited" };
  }
  return { user };
}

type AuthFail = { status: 401 | 403; error: "unauthenticated" | "not_invited" | "disabled" };

/** One entry point for both modes; they never mix (app ignores the Access JWT, access ignores the session cookie). */
export async function authenticate(req: Request, env: Env): Promise<{ user: UserRow; session: SessionRef | null } | AuthFail> {
  const mode = authMode(env);
  if (mode === "access") {
    const token = req.headers.get("Cf-Access-Jwt-Assertion");
    const who = token ? await verifyAccess(token, env) : null;
    if (!who) return { status: 401, error: "unauthenticated" };
    const r = await resolveUser(env, who.email);
    return "user" in r ? { user: r.user, session: null } : r;
  }
  if (mode !== "app") return { status: 401, error: "unauthenticated" }; // callers answer misconfigured first
  const s = await readSession(req, env);
  if (!s) return { status: 401, error: "unauthenticated" };
  if (s.user.status === "disabled") return { status: 403, error: "disabled" };
  if (s.user.status !== "active") return { status: 401, error: "unauthenticated" };
  return s;
}

export const requireUser = createMiddleware<{ Bindings: Env; Variables: { user: UserRow; session: SessionRef | null; grant: Grant } }>(async (c, next) => {
  const mode = authMode(c.env);
  if (!mode) return c.json({ error: "misconfigured" }, 500);
  const r = await authenticate(c.req.raw, c.env);
  if ("status" in r) {
    // The signIn flag tells the dashboard to show its own sign-in instead of the Access text.
    if (r.status !== 401 || mode !== "app") return c.json({ error: r.error }, r.status);
    // /api/me also carries the instance name (already in every email's subject) so the invite page can say where you are invited.
    const name = c.req.path === "/api/me" ? (await getSettings(c.env)).name : null;
    return c.json({ error: r.error, signIn: "app", ...(name ? { name: displayName(name) } : {}) }, 401);
  }
  c.set("user", r.user);
  c.set("session", r.session);
  c.set("grant", FULL_GRANT);
  await next();
});
