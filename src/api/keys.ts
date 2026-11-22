import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { hashKey, newKey } from "../keys";
import { usableDomains } from "../perm";
import { actor, type Grant } from "../principal";
import { rowToKey, type UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const keys = new Hono<E>();

const MAX_ACTIVE = 20;
const KEY_COLS = "k.id, k.user_id, k.name, k.prefix, k.can_write, k.can_delete, k.domain_ids, k.created_at, k.last_used_at, k.expires_at";
const createBody = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]{1,40}$/),
  write: z.boolean(),
  del: z.boolean(),
  domainIds: z.array(z.string().min(1).max(64)).max(50),
  expiresInDays: z.number().int().min(1).max(365),
});

// Active = not revoked (an expired key still counts and keeps its name until revoked; it is listed with its expiresAt).
keys.get("/", async (c) => {
  const u = c.var.user;
  const all = u.role === "owner" && c.req.query("all") === "1";
  const rows = all
    ? await c.env.DB.prepare(`SELECT ${KEY_COLS}, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.revoked_at IS NULL ORDER BY k.created_at, k.id`).all()
    : await c.env.DB.prepare(`SELECT ${KEY_COLS} FROM api_keys k WHERE k.user_id = ? AND k.revoked_at IS NULL ORDER BY k.created_at, k.id`).bind(u.id).all();
  return c.json({ items: rows.results.map((r) => rowToKey(r, all)) });
});

keys.post("/", async (c) => {
  const u = c.var.user;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  if (b.del && !b.write) return c.json({ error: "del_needs_write" }, 400);
  const domainIds = [...new Set(b.domainIds)];
  if (domainIds.length) {
    // Unknown ids are refused the same way as other people's domains: no existence oracle.
    const q = usableDomains(u.id, c.var.grant.domains);
    const ok = new Set((await c.env.DB.prepare(q.sql).bind(...q.binds).all<{ id: string }>()).results.map((r) => r.id));
    if (!domainIds.every((d) => ok.has(d))) return c.json({ error: "forbidden" }, 403);
  }
  const { secret, prefix } = newKey();
  const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000), expiresAt = now + b.expiresInDays * 86400;
  try {
    // The cap is checked inside the insert, so parallel creates cannot pass it together.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO api_keys (id,user_id,name,prefix,hash,can_write,can_delete,domain_ids,expires_at,created_at)
         SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL) < ?`,
      ).bind(id, u.id, b.name, prefix, await hashKey(secret), b.write ? 1 : 0, b.del ? 1 : 0, JSON.stringify(domainIds), expiresAt, now, u.id, MAX_ACTIVE),
      auditStmt(c.env, { ...actor(c), action: "key.create", targetType: "api_key", targetId: id,
        detail: { name: b.name, prefix, write: b.write, del: b.del, domainIds } },
        { sql: "EXISTS (SELECT 1 FROM api_keys WHERE id = ?)", binds: [id] }),
    ]);
    if (!res[0]!.meta.changes) return c.json({ error: "too_many_keys" }, 409);
  } catch (e) {
    if (/UNIQUE/.test(String(e))) return c.json({ error: "name_taken" }, 409);
    throw e;
  }
  const key = rowToKey({ id, user_id: u.id, name: b.name, prefix, can_write: b.write ? 1 : 0, can_delete: b.del ? 1 : 0,
    domain_ids: JSON.stringify(domainIds), created_at: now, last_used_at: null, expires_at: expiresAt });
  return c.json({ key, secret }, 201);
});

// Own key, or the owner for anyone's. Someone else's key answers 404 like an unknown one.
keys.delete("/:id", async (c) => {
  const u = c.var.user;
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT user_id, name, prefix FROM api_keys WHERE id = ? AND revoked_at IS NULL AND (user_id = ? OR ? = 1)")
    .bind(id, u.id, u.role === "owner" ? 1 : 0).first<{ user_id: string; name: string; prefix: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id),
    // changes() is the UPDATE's own count: a parallel revoke in the same second writes no second row.
    auditStmt(c.env, { ...actor(c), action: "key.revoke", targetType: "api_key", targetId: id,
      detail: { name: row.name, prefix: row.prefix, userId: row.user_id } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND revoked_at = ?)", binds: [id, now] }),
  ]);
  if (!res[0]!.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
