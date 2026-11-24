// S14 routes: sign-in with Google, GitHub or OIDC (start, callback, providers), Settings > Sign-in, and the person's own
// connected sign-ins. Library side (config, discovery, token checks): src/sso.ts.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { findUser, resolveUser } from "../auth";
import { dash, dashUrl } from "../dash";
import { UNSAFE } from "../email";
import type { Env } from "../env";
import { LIMITS, blocked, hit, limitKey } from "../limits";
import type { Grant } from "../principal";
import { ROLE_JOIN, USER_COLS, requirePerm, roleWithin, type Guard } from "../roles";
import { deleteSecretStmts, getSecret, putSecretStmts, secretsReady } from "../secrets";
import { createSession, ipPrefix, newSecret, safeNext, sha256Hex } from "../session";
import {
  DEFAULT_LABEL, PROVIDERS, SECRET_OF, SsoError, authorizeUrl, discover, domainEnforced, emailDomain, identify, isProvider, issuerOk,
  pkceChallenge, ready, redirectUri, ssoConfig, ssoKey, ssoRequired, stateCookie, type Provider, type Who,
} from "../sso";
import { rowToUser, type SessionRef, type UserRow } from "../types";
import { holds } from "./domains";
import { parse } from "./signin";
import { ACTOR_OK } from "./users";

type E = { Bindings: Env; Variables: { user: UserRow; session: SessionRef | null; grant: Grant } };
const STATE_TTL = 600;
const nowS = () => Math.floor(Date.now() / 1000);
const invalid = { error: "invalid_body" } as const;
const notFound = { error: "not_found" } as const;
const forbidden = { error: "forbidden" } as const;

/** Public: mounted at /auth/sso after the /auth router, so its POST-only, exact-Origin, JSON, no-store guard applies here too. */
export const ssoAuth = new Hono<{ Bindings: Env }>();

ssoAuth.post("/providers", async (c) => {
  if (!(await parse(c, z.strictObject({})))) return c.json(invalid, 400);
  const cfg = await ssoConfig(c.env);
  const items = (await Promise.all(PROVIDERS.map((p) => ready(c.env, cfg, p)))).filter((r) => r !== null).map((r) => ({ id: r.provider, label: r.label }));
  return c.json({ items });
});

ssoAuth.post("/:provider/start", async (c) => {
  const b = await parse(c, z.strictObject({ next: z.string().max(2048).optional() }));
  if (!b) return c.json(invalid, 400);
  const p = c.req.param("provider"), env = c.env;
  if (!isProvider(p)) return c.json(notFound, 404);
  // R11: every start writes a state row, so a per-range budget of its own bounds anonymous writes.
  const ip = ipPrefix(c.req.header("cf-connecting-ip") ?? null);
  if (!(await hit(env, limitKey.ssoStart(ip), LIMITS.ssoStart))) return c.json({ error: "too_many" }, 429);
  const r = await ready(env, await ssoConfig(env), p);
  if (!r) return c.json(notFound, 404);
  const secret = newSecret(), verifier = newSecret(), nonce = newSecret();
  let url: string;
  try {
    url = await authorizeUrl(env, r, { state: secret, nonce, challenge: await pkceChallenge(verifier) });
  } catch (e) {
    if (e instanceof SsoError) return c.json({ error: "sso_failed" }, 502);
    throw e;
  }
  const d = dash(env)!, now = nowS();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sso_states WHERE rowid IN (SELECT rowid FROM sso_states WHERE expires_at <= ? LIMIT 100)").bind(now),
    env.DB.prepare("INSERT INTO sso_states (id_hash, provider, verifier, nonce, next, ip_prefix, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(await sha256Hex(secret), p, verifier, nonce, safeNext(b.next, d.origin, d.prefix), ip, now, now + STATE_TTL),
  ]);
  const ck = stateCookie(env);
  c.header("Set-Cookie", `${ck.name}=${secret}; Path=${ck.path}; Max-Age=${STATE_TTL}; Secure; HttpOnly; SameSite=Lax`);
  return c.json({ url });
});

/** The value of cookie `name` when it has the secret shape; the first one wins, as readCookie does. */
function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
    }
  }
  return null;
}

type Code = "sso_failed" | "not_invited" | "disabled" | "sso_required" | "email_unverified" | "too_many";

/**
 * GET /auth/sso/:provider/callback (R1). Registered in app.ts before the POST-only /auth guard. Always clears the state
 * cookie; answers a 302 to `next` or to /sign-in?error=<code> (R13, never the provider's text).
 */
export async function ssoCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const ck = stateCookie(env);
  c.header("Set-Cookie", `${ck.name}=; Path=${ck.path}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`, { append: true });
  const back = (code: Code) => c.redirect(dashUrl(env, `/sign-in?error=${code}`), 302);
  const failKey = limitKey.fail(ipPrefix(c.req.header("cf-connecting-ip") ?? null));
  // R11: a blocked range is refused before the state claim and any outbound fetch.
  if (await blocked(env, failKey, LIMITS.failIp)) return back("too_many");
  const failed = async (code: Code) => {
    await hit(env, failKey, LIMITS.failIp);
    return back(code);
  };
  const p = c.req.param("provider") ?? "";
  const cookie = cookieValue(c.req.raw, ck.name);
  const code = c.req.query("code");
  // The state parameter must be the cookie's own secret (login CSRF), and the row is claimed once (R3).
  if (!isProvider(p) || !cookie || c.req.query("state") !== cookie) return failed("sso_failed");
  const now = nowS();
  const st = await env.DB.prepare("UPDATE sso_states SET used_at = ? WHERE id_hash = ? AND provider = ? AND used_at IS NULL AND expires_at > ? RETURNING verifier, nonce, next")
    .bind(now, await sha256Hex(cookie), p, now).first<{ verifier: string; nonce: string; next: string }>();
  // A provider `error` (the person cancelled) arrives without a code: the state is spent all the same.
  if (!st || !code || code.length > 2048) return failed("sso_failed");
  const r = await ready(env, await ssoConfig(env), p);
  if (!r) return failed("sso_failed");
  let who: Who;
  try {
    who = await identify(env, r, code, st.verifier, st.nonce);
  } catch (e) {
    if (e instanceof SsoError) return failed(e.code);
    throw e;
  }
  const m = await matchPerson(env, p, who, r.issuer);
  if ("error" in m) return failed(m.error);
  const s = await createSession(env, c.req.raw, m.user, p, m.joined);
  if (!s.started(await env.DB.batch(s.stmts))) return failed("disabled"); // disabled after the match
  c.header("Set-Cookie", s.setCookie, { append: true });
  return c.redirect(dashUrl(env, st.next), 302); // stored after safeNext: an inner path
}

/**
 * R6 matching, then R7: (provider, subject) first, else the verified email of a person with no identity for this provider yet,
 * else a domain auto-join. Enforcement is decided before anyone is created or bound, so a refusal writes nothing.
 */
async function matchPerson(env: Env, p: Provider, who: Who, issuer: string | null): Promise<{ user: UserRow; joined: boolean } | { error: Code }> {
  // OIDC: the issuer the token was checked against must still be the configured one, both to match a bound identity and
  // to bind a new one, so a callback that overlaps an issuer change can neither match nor bind across issuers.
  const same = p === "oidc" ? { sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [ssoKey("oidc", "issuer"), JSON.stringify(issuer)] } : { sql: "1", binds: [] };
  const bound = await env.DB.prepare(`SELECT ${USER_COLS} FROM sso_identities i JOIN users u ON u.id = i.user_id ${ROLE_JOIN} WHERE i.provider = ? AND i.subject = ? AND ${same.sql}`)
    .bind(p, who.subject, ...same.binds).first();
  let user = bound ? rowToUser(bound) : await findUser(env, who.email);
  // Never rebind: a person already linked to another account at this provider is not this one.
  if (!bound && user && (await env.DB.prepare("SELECT 1 FROM sso_identities WHERE user_id = ? AND provider = ?").bind(user.id, p).first())) return { error: "not_invited" };
  if (user?.status === "disabled") return { error: "disabled" };
  if (p !== "oidc" && (await ssoRequired(env, user ?? { role: "member", email: who.email }))) return { error: "sso_required" };
  const now = nowS();
  let joined = false;
  if (!user) {
    const domain = emailDomain(who.email);
    const role = (await env.DB.prepare("SELECT join_role_id FROM email_domains WHERE domain = ? AND join_role_id IS NOT NULL").bind(domain).first<{ join_role_id: string }>())?.join_role_id;
    if (!role) return { error: "not_invited" };
    const id = crypto.randomUUID();
    // Re-checked in the insert: the auto-join still gives this role, and nobody took the address meanwhile.
    await env.DB.prepare(`INSERT INTO users (id, email, name, role, role_id, status, created_at) SELECT ?, ?, NULL, 'member', ?, 'active', ?
      WHERE EXISTS (SELECT 1 FROM email_domains WHERE domain = ? AND join_role_id = ?) AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`)
      .bind(id, who.email, role === "member" ? null : role, now, domain, role, who.email).run();
    user = await findUser(env, who.email);
    if (!user) return { error: "not_invited" };
    joined = user.id === id;
  }
  if (bound) {
    await env.DB.prepare("UPDATE sso_identities SET email = ?, last_used_at = ? WHERE provider = ? AND subject = ?").bind(who.email, now, p, who.subject).run();
  } else {
    await env.DB.prepare(`INSERT INTO sso_identities (provider, subject, user_id, email, created_at, last_used_at) SELECT ?,?,?,?,?,? WHERE ${same.sql} ON CONFLICT DO NOTHING`)
      .bind(p, who.subject, user.id, who.email, now, now, ...same.binds).run();
    const own = await env.DB.prepare("SELECT user_id FROM sso_identities WHERE provider = ? AND subject = ?").bind(p, who.subject).first<{ user_id: string }>();
    if (own?.user_id !== user.id) return { error: "not_invited" }; // a racing sign-in bound it elsewhere
  }
  const r = await resolveUser(env, user.email); // activates an invited person, re-reads the status
  if (!("user" in r)) return { error: r.error };
  if (r.user.id !== user.id) return { error: "not_invited" };
  return { user: r.user, joined };
}

// ---- Settings > Sign-in: read with perm settings, every write owner only (R14). Mounted at /api/settings, app mode only. ----

export const ssoSettings = new Hono<E>();
ssoSettings.use("*", requirePerm("settings"));

async function settingsBody(env: Env) {
  const [cfg, set, domains] = await Promise.all([
    ssoConfig(env),
    Promise.all(PROVIDERS.map(async (p) => !!(await getSecret(env, SECRET_OF[p])))),
    env.DB.prepare("SELECT domain, join_role_id, enforce_sso FROM email_domains ORDER BY domain").all<{ domain: string; join_role_id: string | null; enforce_sso: number }>(),
  ]);
  return {
    redirectUris: { google: redirectUri(env, "google"), github: redirectUri(env, "github"), oidc: redirectUri(env, "oidc") },
    google: { ...cfg.google, secretSet: set[0] },
    github: { ...cfg.github, secretSet: set[1] },
    oidc: { enabled: cfg.oidc.enabled, issuer: cfg.oidc.issuer, clientId: cfg.oidc.clientId, label: cfg.oidc.label ?? DEFAULT_LABEL, secretSet: set[2] },
    emailDomains: domains.results.map((d) => ({ domain: d.domain, joinRoleId: d.join_role_id, enforceSso: !!d.enforce_sso })),
    secretsReady: secretsReady(env),
  };
}

ssoSettings.get("/sso", async (c) => c.json(await settingsBody(c.env)));

const providerBody = z.strictObject({
  enabled: z.boolean().optional(),
  clientId: z.string().max(1024).optional(),
  clientSecret: z.string().max(4096).optional(),
  issuer: z.string().max(2048).optional(),
  label: z.string().max(400).optional(),
});
const PRINTABLE = /^[\x21-\x7e]+$/;

ssoSettings.put("/sso/:provider", async (c) => {
  const p = c.req.param("provider"), env = c.env, me = c.var.user;
  if (!isProvider(p)) return c.json(notFound, 404);
  // Owner only: whoever sets the issuer and secret can sign in as anyone whose email that IdP vouches for.
  if (me.role !== "owner") return c.json(forbidden, 403);
  const parsed = providerBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid, 400); // zod issues are never echoed: they would carry the secret
  const b = parsed.data;
  if (p !== "oidc" && (b.issuer !== undefined || b.label !== undefined)) return c.json(invalid, 400);
  if (!Object.values(b).some((v) => v !== undefined)) return c.json({ error: "no_changes" }, 400);
  const clientId = b.clientId?.trim();
  if (clientId && (clientId.length > 256 || !PRINTABLE.test(clientId))) return c.json({ error: "bad_client_id" }, 400);
  const secret = b.clientSecret?.trim();
  if (secret && (secret.length > 512 || !PRINTABLE.test(secret))) return c.json(invalid, 400);
  if (secret && !secretsReady(env)) return c.json({ error: "secrets_key_missing" }, 409);
  const issuer = b.issuer?.trim();
  if (issuer && !issuerOk(issuer)) return c.json({ error: "bad_issuer" }, 400);
  const label = b.label === undefined ? undefined : b.label.replace(UNSAFE, "").trim();
  if (label && [...label].length > 40) return c.json(invalid, 400);
  const cfg = await ssoConfig(env);
  // R5: discovery is checked on every save that sets the issuer or turns OIDC on.
  const useIssuer = issuer === undefined ? cfg.oidc.issuer : issuer || null;
  if (p === "oidc" && useIssuer && (issuer || b.enabled === true)) {
    try {
      await discover(env, useIssuer, true);
    } catch (e) {
      if (e instanceof SsoError) return c.json({ error: "sso_discovery_failed" }, 400);
      throw e;
    }
  }
  const g: Guard = { sql: ACTOR_OK, binds: [me.id] };
  const now = nowS();
  const put = (field: "enabled" | "clientId" | "issuer" | "label", v: unknown) => v === null || v === ""
    ? env.DB.prepare(`DELETE FROM settings WHERE key = ? AND ${g.sql}`).bind(ssoKey(p, field), ...g.binds)
    : env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE ${g.sql}
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(ssoKey(p, field), JSON.stringify(v), now, me.id, ...g.binds);
  const fields: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const set = (field: "enabled" | "clientId" | "issuer" | "label", v: unknown) => { fields.push(field); stmts.push(put(field, v)); };
  if (b.enabled !== undefined) set("enabled", b.enabled);
  if (clientId !== undefined) set("clientId", clientId);
  if (issuer !== undefined) set("issuer", issuer);
  if (label !== undefined) set("label", label);
  if (secret !== undefined) {
    fields.push("clientSecret");
    stmts.push(...(secret ? await putSecretStmts(env, me.id, SECRET_OF[p], secret, g) : deleteSecretStmts(env, me.id, SECRET_OF[p], g)));
  }
  // A new issuer is a new namespace of subjects: identities bound under the old one must never match a stranger there.
  if (p === "oidc" && issuer !== undefined && (issuer || null) !== cfg.oidc.issuer)
    stmts.push(env.DB.prepare(`DELETE FROM sso_identities WHERE provider = 'oidc' AND ${g.sql}`).bind(...g.binds));
  stmts.push(auditStmt(env, { actorId: me.id, action: "sso.settings", targetType: "settings", targetId: `sso.${p}`, detail: { provider: p, fields } }, g));
  const res = await env.DB.batch(stmts);
  if (!res.at(-1)!.meta.changes) return c.json(forbidden, 403); // no longer an active owner: nothing was written
  return c.json(await settingsBody(env));
});

// Lowercase hostname, at least two labels, letters or punycode as the last one, at most 253 characters (R8).
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const MAX_DOMAINS = 50;
const domainBody = z.strictObject({ joinRoleId: z.string().min(1).max(64).nullable(), enforceSso: z.boolean() });

ssoSettings.put("/email-domains/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase(), env = c.env, me = c.var.user;
  if (me.role !== "owner") return c.json(forbidden, 403); // R14
  if (!DOMAIN.test(domain)) return c.json({ error: "bad_domain" }, 400);
  const parsed = domainBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid, 400);
  const { joinRoleId, enforceSso } = parsed.data;
  if (joinRoleId === "owner") return c.json({ error: "owner_role" }, 400);
  const role = joinRoleId ? await env.DB.prepare("SELECT name FROM roles WHERE id = ?").bind(joinRoleId).first<{ name: string }>() : null;
  if (joinRoleId && !role) return c.json({ error: "bad_role" }, 400);
  // R14: owners only, re-checked in SQL; roleWithin stays as the backstop should the gate ever widen.
  const may: Guard = { sql: ACTOR_OK, binds: [me.id] }, within = joinRoleId ? roleWithin(joinRoleId, me.id) : null;
  const room = "((SELECT COUNT(*) FROM email_domains) < ? OR EXISTS (SELECT 1 FROM email_domains WHERE domain = ?))";
  const g: Guard = { sql: `${may.sql}${within ? ` AND ${within.sql}` : ""} AND ${room}`, binds: [...may.binds, ...(within?.binds ?? []), MAX_DOMAINS, domain] };
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO email_domains (domain, join_role_id, enforce_sso, updated_at, updated_by) SELECT ?,?,?,?,? WHERE ${g.sql}
      ON CONFLICT(domain) DO UPDATE SET join_role_id = excluded.join_role_id, enforce_sso = excluded.enforce_sso, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(domain, joinRoleId, enforceSso ? 1 : 0, nowS(), me.id, ...g.binds),
    auditStmt(env, { actorId: me.id, action: "email_domain.set", targetType: "email_domain", targetId: domain, detail: { domain, joinRoleId, joinRoleName: role?.name ?? null, enforceSso } }, { sql: "changes() > 0", binds: [] }),
  ]);
  if (!res[0]!.meta.changes) {
    if (!(await holds(env, may)) || (within && !(await holds(env, within)))) return c.json(forbidden, 403);
    return c.json({ error: "too_many" }, 409);
  }
  return c.json(await settingsBody(env));
});

ssoSettings.delete("/email-domains/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase(), env = c.env, me = c.var.user;
  if (me.role !== "owner") return c.json(forbidden, 403); // R14
  const may: Guard = { sql: ACTOR_OK, binds: [me.id] };
  const [, del] = await env.DB.batch([
    auditStmt(env, { actorId: me.id, action: "email_domain.delete", targetType: "email_domain", targetId: domain, detail: { domain } },
      { sql: `EXISTS (SELECT 1 FROM email_domains WHERE domain = ?) AND ${may.sql}`, binds: [domain, ...may.binds] }),
    env.DB.prepare(`DELETE FROM email_domains WHERE domain = ? AND ${may.sql}`).bind(domain, ...may.binds),
  ]);
  if (!del!.meta.changes) return (await holds(env, may)) ? c.json(notFound, 404) : c.json(forbidden, 403);
  return c.json(await settingsBody(env));
});

// ---- The signed-in person's connected sign-ins. Mounted at /api/account (app mode only, behind requireUser). ----

export const ssoAccount = new Hono<E>();

ssoAccount.get("/identities", async (c) => {
  const rows = await c.env.DB.prepare("SELECT provider, email, created_at, last_used_at FROM sso_identities WHERE user_id = ? ORDER BY provider")
    .bind(c.var.user.id).all<{ provider: Provider; email: string; created_at: number; last_used_at: number | null }>();
  return c.json({ items: rows.results.map((r) => ({ provider: r.provider, email: r.email, createdAt: r.created_at, lastUsedAt: r.last_used_at })) });
});

ssoAccount.delete("/identities/:provider", async (c) => {
  const p = c.req.param("provider"), env = c.env, uid = c.var.user.id;
  if (!isProvider(p)) return c.json(notFound, 404);
  if (p === "oidc" && (await domainEnforced(env, c.var.user.email))) return c.json({ error: "sso_required" }, 403);
  const [, del] = await env.DB.batch([
    auditStmt(env, { actorId: uid, action: "identity.unlink", targetType: "user", targetId: uid, detail: { provider: p } },
      { sql: "EXISTS (SELECT 1 FROM sso_identities WHERE user_id = ? AND provider = ?)", binds: [uid, p] }),
    env.DB.prepare("DELETE FROM sso_identities WHERE user_id = ? AND provider = ?").bind(uid, p),
  ]);
  return del!.meta.changes ? c.body(null, 204) : c.json(notFound, 404);
});
