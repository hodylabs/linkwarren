import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { ABSOLUTE, clearCookie, deviceLabel, endSessionStmt } from "../session";
import type { PasskeyItem, SessionItem, SessionRef, UserRow } from "../types";
import { MAX_PASSKEYS, PasskeyError, registrationOptions, verifyRegistration } from "../webauthn";
import { parse } from "./signin";

type E = { Bindings: Env; Variables: { user: UserRow; session: SessionRef | null } };
/** The signed-in person's own account (app mode only, behind requireUser): passkeys, sessions, sign out. */
export const account = new Hono<E>();

const limit = { error: "passkey_limit" } as const;
const passkeyFailed = { error: "passkey_failed" } as const;

account.post("/passkeys/options", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id = ?").bind(c.var.user.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PASSKEYS) return c.json(limit, 409);
  const o = await registrationOptions(c.env, c.var.user);
  return o ? c.json(o) : c.json({ error: "too_many_attempts" }, 429);
});

// Control, zero-width, line-separator and bidi characters (ALM, ZWSP/ZWNJ/ZWJ, LRM/RLM, embeddings, word joiner and invisibles, isolates, BOM).
const HIDDEN = "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff";
const renameBody = z.strictObject({ name: z.string() });
const nowS = () => Math.floor(Date.now() / 1000);
/** The one name sanitizer (registration and rename): strips hidden characters (a name like "evil\u202Eexe" would display reversed), collapses whitespace, 1-40 characters or null. */
const cleanName = (raw: string): string | null => {
  const n = raw.replace(new RegExp(`[${HIDDEN}]`, "g"), "").replace(/\s+/g, " ").trim();
  return n && n.length <= 40 ? n : null;
};
const addBody = z.strictObject({ response: z.unknown(), name: z.string().optional() });

account.post("/passkeys", async (c) => {
  const b = await parse(c, addBody);
  if (!b) return c.json({ error: "invalid_body" }, 400);
  const given = b.name === undefined ? undefined : cleanName(b.name);
  if (given === null) return c.json({ error: "invalid_name" }, 400);
  const env = c.env, user = c.var.user;
  let k;
  try {
    k = await verifyRegistration(env, user, b.response);
  } catch (err) {
    if (!(err instanceof PasskeyError)) throw err;
    return c.json(passkeyFailed, 400);
  }
  const label = deviceLabel(c.req.header("user-agent") ?? null);
  const name = given ?? (label ? `Passkey on ${label}`.slice(0, 40) : "Passkey");
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  // The limit is re-checked inside the INSERT (two option fetches at 9 cannot make 11); a known credential id is skipped, not thrown.
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO passkeys (id, credential_id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) < ${MAX_PASSKEYS}
       ON CONFLICT(credential_id) DO NOTHING`,
    ).bind(id, k.credentialId, user.id, k.publicKey, k.counter, JSON.stringify(k.transports), k.deviceType, k.backedUp ? 1 : 0, name, now, user.id),
    auditStmt(env, { actorId: user.id, action: "passkey.add", targetType: "passkey", targetId: id, detail: { name } },
      { sql: "EXISTS (SELECT 1 FROM passkeys WHERE id = ?)", binds: [id] }),
  ]);
  if (!ins!.meta.changes) {
    const dup = await env.DB.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").bind(k.credentialId).first();
    return dup ? c.json(passkeyFailed, 400) : c.json(limit, 409);
  }
  const item: PasskeyItem = { id, name, createdAt: now, lastUsedAt: null, backedUp: k.backedUp };
  return c.json(item, 201);
});

const notFound = { error: "not_found" } as const;

account.get("/", async (c) => {
  const uid = c.var.user.id, now = nowS(), cur = c.var.session?.id;
  const [p, s] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare("SELECT id, name, created_at, last_used_at, backed_up FROM passkeys WHERE user_id = ? ORDER BY created_at, id").bind(uid),
    c.env.DB.prepare(
      "SELECT id, method, created_at, last_seen_at, device, ip_prefix FROM sessions WHERE user_id = ? AND expires_at > ? AND created_at > ? ORDER BY created_at DESC, id",
    ).bind(uid, now, now - ABSOLUTE),
  ]);
  const passkeys: PasskeyItem[] = p!.results.map((r) => ({ id: r.id as string, name: r.name as string, createdAt: r.created_at as number, lastUsedAt: r.last_used_at as number | null, backedUp: !!r.backed_up }));
  const sessions: SessionItem[] = s!.results.map((r) => ({
    id: r.id as string, current: r.id === cur, method: r.method as "email" | "passkey", createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number, device: r.device as string | null, ipPrefix: r.ip_prefix as string | null,
  }));
  return c.json({ passkeys, sessions });
});

account.patch("/passkeys/:id", async (c) => {
  const b = await parse(c, renameBody);
  const name = b && cleanName(b.name);
  if (!name) return c.json({ error: "invalid_name" }, 400);
  const id = c.req.param("id"), uid = c.var.user.id;
  const own = { sql: "EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?)", binds: [id, uid] };
  const [, upd] = await c.env.DB.batch<Record<string, unknown>>([
    auditStmt(c.env, { actorId: uid, action: "passkey.rename", targetType: "passkey", targetId: id, detail: { name } }, own),
    c.env.DB.prepare("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING id, name, created_at, last_used_at, backed_up").bind(name, id, uid),
  ]);
  const r = upd!.results[0];
  if (!r) return c.json(notFound, 404);
  const item: PasskeyItem = { id: r.id as string, name: r.name as string, createdAt: r.created_at as number, lastUsedAt: r.last_used_at as number | null, backedUp: !!r.backed_up };
  return c.json(item);
});

account.delete("/passkeys/:id", async (c) => {
  const id = c.req.param("id"), uid = c.var.user.id;
  const [, del] = await c.env.DB.batch([
    auditStmt(c.env, { actorId: uid, action: "passkey.remove", targetType: "passkey", targetId: id },
      { sql: "EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?)", binds: [id, uid] }),
    c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(id, uid),
  ]);
  return del!.meta.changes ? c.body(null, 204) : c.json(notFound, 404);
});

/** Ends one of the person's own sessions; the guard keeps the audit and the delete on the same (id, owner) row. */
const endOwn = (env: Env, uid: string, id: string, action: string): D1PreparedStatement[] => {
  const own = { sql: "user_id = ?", binds: [uid] };
  return [
    auditStmt(env, { actorId: uid, action, targetType: "session", targetId: id }, { sql: "EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = ?)", binds: [id, uid] }),
    endSessionStmt(env, { id }, own),
  ];
};

account.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const [, del] = await c.env.DB.batch(endOwn(c.env, c.var.user.id, id, "session.end"));
  if (!del!.meta.changes) return c.json(notFound, 404);
  if (id === c.var.session?.id) c.header("Set-Cookie", clearCookie());
  return c.body(null, 204);
});

account.post("/sign-out", async (c) => {
  const id = c.var.session?.id;
  if (id) await c.env.DB.batch(endOwn(c.env, c.var.user.id, id, "auth.sign_out"));
  c.header("Set-Cookie", clearCookie());
  return c.body(null, 204);
});

account.post("/sign-out-everywhere", async (c) => {
  const uid = c.var.user.id;
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").bind(uid).first<{ n: number }>();
  await c.env.DB.batch([
    auditStmt(c.env, { actorId: uid, action: "auth.sign_out_all", targetType: "user", targetId: uid, detail: { count: n?.n ?? 0 } },
      { sql: "EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)", binds: [uid] }),
    endSessionStmt(c.env, { userId: uid }),
  ]);
  c.header("Set-Cookie", clearCookie());
  return c.body(null, 204);
});
