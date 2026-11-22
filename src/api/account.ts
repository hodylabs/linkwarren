import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { deviceLabel } from "../session";
import type { PasskeyItem, UserRow } from "../types";
import { MAX_PASSKEYS, PasskeyError, registrationOptions, verifyRegistration } from "../webauthn";
import { parse } from "./signin";

type E = { Bindings: Env; Variables: { user: UserRow } };
/** The signed-in person's own account (app mode only, behind requireUser). This task: passkey registration. */
export const account = new Hono<E>();

const limit = { error: "passkey_limit" } as const;
const passkeyFailed = { error: "passkey_failed" } as const;

account.post("/passkeys/options", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id = ?").bind(c.var.user.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PASSKEYS) return c.json(limit, 409);
  const o = await registrationOptions(c.env, c.var.user);
  return o ? c.json(o) : c.json({ error: "too_many_attempts" }, 429);
});

const addBody = z.strictObject({
  response: z.unknown(),
  // No control, line-separator or bidi characters: a name like "evil\u202Eexe" would display reversed.
  name: z.string().trim().max(40).regex(/^[^\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]*$/).optional(),
});

account.post("/passkeys", async (c) => {
  const b = await parse(c, addBody);
  if (!b) return c.json({ error: "invalid_body" }, 400);
  const env = c.env, user = c.var.user;
  let k;
  try {
    k = await verifyRegistration(env, user, b.response);
  } catch (err) {
    if (!(err instanceof PasskeyError)) throw err;
    return c.json(passkeyFailed, 400);
  }
  const label = deviceLabel(c.req.header("user-agent") ?? null);
  const name = b.name || (label ? `Passkey on ${label}` : "Passkey");
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
