import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createMiddleware } from "hono/factory";
import { auditStmt } from "./audit";
import type { Env } from "./env";
import { rowToUser, type UserRow } from "./types";

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

const findUser = async (env: Env, email: string) => {
  const r = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first(); // email column is NOCASE
  return r ? rowToUser(r) : null;
};

/** First-run owner: one atomic conditional insert, so concurrent first sign-ins can never create two owners. */
async function bootstrapOwner(env: Env, email: string): Promise<void> {
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

export const requireUser = createMiddleware<{ Bindings: Env; Variables: { user: UserRow } }>(async (c, next) => {
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  const who = token ? await verifyAccess(token, c.env) : null;
  if (!who) return c.json({ error: "unauthenticated" }, 401);

  let user = await findUser(c.env, who.email);
  if (!user && c.env.OWNER_EMAIL && who.email.toLowerCase() === c.env.OWNER_EMAIL.trim().toLowerCase()) {
    await bootstrapOwner(c.env, who.email);
    user = await findUser(c.env, who.email);
  }
  if (!user) return c.json({ error: "not_invited" }, 403);
  if (user.status === "disabled") return c.json({ error: "disabled" }, 403);

  if (user.status === "invited") {
    // Audit first, guarded on still being invited, so a racing sign-in audits once.
    await c.env.DB.batch([
      auditStmt(c.env, { actorId: user.id, action: "user.activate", targetType: "user", targetId: user.id },
        { sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'invited')", binds: [user.id] }),
      c.env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'invited'").bind(user.id),
    ]);
    user = { ...user, status: "active" };
  }
  c.set("user", user);
  await next();
});
