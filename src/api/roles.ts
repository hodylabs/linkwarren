import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { UNSAFE } from "../email";
import type { Env } from "../env";
import type { Grant } from "../principal";
import { can, parsePerms, PERMS, type Perm } from "../roles";
import type { UserRow } from "../types";
import { ACTOR_OK } from "./users";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Dashboard session only. Owners create, edit and delete roles (R4); owners and people.manage holders list them (R11). */
export const roles = new Hono<E>();

export type RoleItem = { id: string; name: string; perms: Perm[]; builtin: "owner" | "member" | null; people: number };
type RoleRow = { id: string; name: string; perms: string; builtin: number; people: number };

const forbidden = { error: "forbidden" } as const;
const notFound = { error: "not_found" } as const;
const MAX_CUSTOM = 20;
/** Owner first, Member second, then custom roles by name; `people` counts everyone whose effective role it is. */
const LIST = `SELECT r.id, r.name, r.perms, r.builtin, COALESCE(p.n, 0) people FROM roles r
  LEFT JOIN (SELECT COALESCE(role_id, role) k, COUNT(*) n FROM users GROUP BY k) p ON p.k = r.id
  WHERE ? IS NULL OR r.id = ? ORDER BY CASE r.id WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, r.name, r.id`;
const toItem = (r: RoleRow): RoleItem => ({
  id: r.id, name: r.name, people: r.people,
  perms: r.id === "owner" ? [...PERMS] : parsePerms(r.perms),
  builtin: r.builtin ? (r.id as "owner" | "member") : null,
});
const rawList = async (env: Env, id: string | null = null) => (await env.DB.prepare(LIST).bind(id, id).all<RoleRow>()).results;
const list = async (env: Env, id: string | null = null) => (await rawList(env, id)).map(toItem);

/** S7 UNSAFE characters out, NFC, trimmed, 1 to 40 code points; null when that leaves nothing usable. */
const cleanName = (raw: string): string | null => {
  const n = raw.replace(UNSAFE, "").normalize("NFC").trim();
  const len = [...n].length;
  return len >= 1 && len <= 40 ? n : null;
};
/** Known keys only, stored once each in R2 order; null when any key is unknown. */
const cleanPerms = (raw: string[]): Perm[] | null =>
  raw.every((p) => (PERMS as readonly string[]).includes(p)) ? PERMS.filter((p) => raw.includes(p)) : null;
const taken = (all: RoleItem[], name: string, self: string | null) =>
  all.some((r) => r.id !== self && r.name.toLowerCase() === name.toLowerCase());
// SQL twin of `taken` for the batch (NOCASE column; the JS check above also catches non-ASCII case).
const FREE = "NOT EXISTS (SELECT 1 FROM roles WHERE name = ? AND id != ?)";
/** The ids of everyone on role `?`, as a JSON array in id order: compared before and inside the delete batch. */
const HOLDERS = "SELECT json_group_array(id) FROM (SELECT id FROM users WHERE role_id = ? ORDER BY id)";

const invalid = (c: { json: (b: unknown, s: 400) => Response }) => c.json({ error: "invalid_body" }, 400);
const createBody = z.strictObject({ name: z.string().max(200), perms: z.array(z.string()).max(PERMS.length) });
const patchBody = z.strictObject({ name: z.string().max(200).optional(), perms: z.array(z.string()).max(PERMS.length).optional() });
const deleteBody = z.strictObject({ moveTo: z.string().max(200).optional() });

roles.get("/", async (c) => {
  const me = c.var.user;
  if (me.role !== "owner" && !can(me, "people.manage")) return c.json(forbidden, 403);
  return c.json(await list(c.env));
});

roles.post("/", async (c) => {
  const me = c.var.user, env = c.env;
  if (me.role !== "owner") return c.json(forbidden, 403);
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return invalid(c);
  const name = cleanName(body.data.name);
  if (!name) return c.json({ error: "bad_name" }, 400);
  const perms = cleanPerms(body.data.perms);
  if (!perms) return c.json({ error: "bad_perms" }, 400);
  const all = await list(env);
  if (taken(all, name, null)) return c.json({ error: "name_taken" }, 409);
  if (all.filter((r) => !r.builtin).length >= MAX_CUSTOM) return c.json({ error: "too_many_roles" }, 409);
  const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000), json = JSON.stringify(perms);
  const COUNT_OK = `(SELECT COUNT(*) FROM roles WHERE builtin = 0) < ${MAX_CUSTOM}`;
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO roles (id, name, perms, builtin, created_at, updated_at, updated_by) SELECT ?, ?, ?, 0, ?, ?, ?
      WHERE ${ACTOR_OK} AND ${COUNT_OK} AND ${FREE}`).bind(id, name, json, now, now, me.id, me.id, name, id),
    auditStmt(env, { actorId: me.id, action: "role.create", targetType: "role", targetId: id, detail: { name, perms } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM roles WHERE id = ?)", binds: [id] }),
    // Read in the same batch, so the answer is the row this batch wrote, not whatever a later request left.
    env.DB.prepare(LIST).bind(id, id),
  ]);
  if (!res[0]!.meta.changes) {
    const w = await env.DB.prepare(`SELECT ${ACTOR_OK} a, ${COUNT_OK} c, ${FREE} f`).bind(me.id, name, id).first<{ a: number; c: number; f: number }>();
    if (!w?.a) return c.json(forbidden, 403);
    if (!w.f) return c.json({ error: "name_taken" }, 409);
    if (!w.c) return c.json({ error: "too_many_roles" }, 409);
    return c.json({ error: "changed" }, 409);
  }
  return c.json(toItem(res[2]!.results[0] as RoleRow), 201);
});

roles.patch("/:id", async (c) => {
  const me = c.var.user, env = c.env;
  if (me.role !== "owner") return c.json(forbidden, 403);
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return invalid(c);
  if (body.data.name === undefined && body.data.perms === undefined) return c.json({ error: "no_changes" }, 400);
  const id = c.req.param("id");
  if (id === "owner") return c.json({ error: "owner_fixed" }, 409);
  const name = body.data.name === undefined ? undefined : cleanName(body.data.name);
  if (name === null) return c.json({ error: "bad_name" }, 400);
  const perms = body.data.perms === undefined ? undefined : cleanPerms(body.data.perms);
  if (perms === null) return c.json({ error: "bad_perms" }, 400);
  // One read: the new values, the audit diff and the conflict guard all come from this same row.
  const raws = await rawList(env), pre = raws.find((r) => r.id === id);
  if (!pre) return c.json(notFound, 404);
  const all = raws.map(toItem), cur = toItem(pre);
  const newName = name ?? cur.name, newPerms = perms ?? cur.perms;
  if (taken(all, newName, id)) return c.json({ error: "name_taken" }, 409);
  const added = newPerms.filter((p) => !cur.perms.includes(p)), removed = cur.perms.filter((p) => !newPerms.includes(p));
  const renamed = newName !== cur.name;
  if (!renamed && !added.length && !removed.length) return c.json(cur);
  const now = Math.floor(Date.now() / 1000);
  // The row still holds what was read (exact bytes, so `added`/`removed` and `from` are exact): a concurrent edit gets 409 changed.
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE roles SET name = ?, perms = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND name = ? COLLATE BINARY AND perms = ? AND ${ACTOR_OK} AND ${FREE}`)
      .bind(newName, JSON.stringify(newPerms), now, me.id, id, pre.name, pre.perms, me.id, newName, id),
    auditStmt(env, { actorId: me.id, action: "role.update", targetType: "role", targetId: id,
      detail: { name: newName, ...(renamed ? { from: cur.name } : {}), added, removed } },
    { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM roles WHERE id = ? AND updated_at = ? AND updated_by = ?)", binds: [id, now, me.id] }),
    env.DB.prepare(LIST).bind(id, id),
  ]);
  if (!res[0]!.meta.changes) {
    const w = await env.DB.prepare(`SELECT ${ACTOR_OK} a, EXISTS (SELECT 1 FROM roles WHERE id = ?) e, ${FREE} f`).bind(me.id, id, newName, id).first<{ a: number; e: number; f: number }>();
    if (!w?.a) return c.json(forbidden, 403);
    if (!w.e) return c.json(notFound, 404);
    if (!w.f) return c.json({ error: "name_taken" }, 409);
    return c.json({ error: "changed" }, 409);
  }
  return c.json(toItem(res[2]!.results[0] as RoleRow));
});

roles.delete("/:id", async (c) => {
  const me = c.var.user, env = c.env;
  if (me.role !== "owner") return c.json(forbidden, 403);
  const text = await c.req.text();
  let raw: unknown = {};
  if (text) { try { raw = JSON.parse(text); } catch { raw = null; } }
  const body = deleteBody.safeParse(raw);
  if (!body.success) return invalid(c);
  const id = c.req.param("id"), moveTo = body.data.moveTo;
  const pre = await env.DB.prepare(`SELECT r.name, r.builtin, (SELECT COUNT(*) FROM users WHERE role_id = r.id) n, (${HOLDERS}) ids,
    (SELECT name FROM roles WHERE id = ? AND id NOT IN ('owner', r.id)) target FROM roles r WHERE r.id = ?`)
    .bind(id, moveTo ?? null, id).first<{ name: string; builtin: number; n: number; ids: string; target: string | null }>();
  if (!pre) return c.json(notFound, 404);
  if (pre.builtin) return c.json({ error: "builtin" }, 409);
  if (moveTo !== undefined && !pre.target) return c.json({ error: "bad_move_to" }, 400);
  if (moveTo === undefined && pre.n) return c.json({ error: "role_in_use", people: pre.n }, 409);
  const stmts: D1PreparedStatement[] = [];
  // The move runs only while the role is as read (same row, same name) and holds exactly the people read (same ids, not
  // just the same count), and the delete only when that move moved them all (changes() is the UPDATE's own count) and
  // nobody is left: any change in the window writes nothing and answers 409 changed.
  const SRC = "EXISTS (SELECT 1 FROM roles WHERE id = ? AND builtin = 0 AND name = ? COLLATE BINARY)";
  if (moveTo !== undefined) {
    stmts.push(env.DB.prepare(`UPDATE users SET role_id = ? WHERE role_id = ? AND id IN (SELECT value FROM json_each(?)) AND (${HOLDERS}) = ?
      AND ${SRC} AND ${ACTOR_OK} AND EXISTS (SELECT 1 FROM roles WHERE id = ? AND id NOT IN ('owner', ?))`)
      .bind(moveTo === "member" ? null : moveTo, id, pre.ids, id, pre.ids, id, pre.name, me.id, moveTo, id));
  }
  stmts.push(
    env.DB.prepare(`DELETE FROM roles WHERE id = ? AND builtin = 0 AND name = ? COLLATE BINARY AND ${ACTOR_OK}
      AND NOT EXISTS (SELECT 1 FROM users WHERE role_id = ?)${moveTo !== undefined ? " AND changes() = ?" : ""}`)
      .bind(id, pre.name, me.id, id, ...(moveTo !== undefined ? [pre.n] : [])),
    auditStmt(env, { actorId: me.id, action: "role.delete", targetType: "role", targetId: id, detail: { name: pre.name, movedTo: pre.n ? pre.target : null, people: pre.n } },
      { sql: "changes() > 0 AND NOT EXISTS (SELECT 1 FROM roles WHERE id = ?)", binds: [id] }),
  );
  const res = await env.DB.batch(stmts);
  if (!res[stmts.length - 2]!.meta.changes) {
    const w = await env.DB.prepare(`SELECT ${ACTOR_OK} a, EXISTS (SELECT 1 FROM roles WHERE id = ?) e, EXISTS (SELECT 1 FROM roles WHERE id = ?) t`)
      .bind(me.id, id, moveTo ?? null).first<{ a: number; e: number; t: number }>();
    if (!w?.a) return c.json(forbidden, 403);
    if (!w.e) return c.json(notFound, 404);
    if (moveTo !== undefined && !w.t) return c.json({ error: "bad_move_to" }, 400);
    return c.json({ error: "changed" }, 409);
  }
  return c.json({ moved: pre.n });
});
