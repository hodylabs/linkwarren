import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { clearCookie, endSessionStmt } from "../session";
import { actorCan, can, parsePerms, personWithin, reaches, ROLE_JOIN, roleWithin, USER_COLS, within, type Guard } from "../roles";
import { rowToUser, type UserListItem, type UserRow } from "../types";
import type { Grant } from "../principal";
import { purgeHost } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Dashboard session only (never under /api/v1, never a Bearer key). Owners and people.manage holders (R4: only on people within their role). */
export const users = new Hono<E>();

const forbidden = { error: "forbidden" } as const;
const notFound = { error: "not_found" } as const;
const above = { error: "role_above_you" } as const;
const BY_ID = `SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.id = ?`;
export const and = (...g: (Guard | false)[]): Guard => {
  const parts = g.filter((x): x is Guard => !!x);
  return { sql: parts.map((x) => `(${x.sql})`).join(" AND "), binds: parts.flatMap((x) => x.binds) };
};
/** R4: the acting owner is still an active owner (bind the actor). */
export const ACTOR_OK = "EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND status = 'active')";
/** R4: an active owner other than the target remains (bind the target). */
export const OTHER_OWNER = "(SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active' AND id != ?) >= 1";
const SHARED = "type IN ('main','shared')";
/** R4 in the batch: the actor still holds people.manage and the target's current role is still within theirs (an owner: anyone). */
export const peopleOk = (actorId: string, targetId: string): Guard => and(actorCan(actorId, "people.manage"), personWithin(targetId, actorId));
/** Why a guarded write wrote nothing: a = still a people manager, w = target still within, n = the new role still within. */
async function refusal(env: Env, actorId: string, targetId: string, roleId: string | null = null) {
  const a = actorCan(actorId, "people.manage"), w = personWithin(targetId, actorId), n = roleWithin(roleId ?? "", actorId);
  return (await env.DB.prepare(`SELECT ${a.sql} a, ${w.sql} w, ${n.sql} n`).bind(...a.binds, ...w.binds, ...n.binds).first<{ a: number; w: number; n: number }>())!;
}

/** Best effort after a committed D1 write: the per-call checks already refuse the person, this only clears OAUTH_KV. */
async function revokeGrants(env: Env, userId: string): Promise<void> {
  try {
    const oauth = env.OAUTH_PROVIDER;
    if (!oauth) throw new Error("no oauth helpers");
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(userId, { cursor });
      for (const g of page.items) await oauth.revokeGrant(g.id, userId);
      cursor = page.cursor;
    } while (cursor);
  } catch (err) {
    console.error("grant revoke failed", err instanceof Error ? err.name : "unknown");
  }
}

/** The list rows, or only `id`'s row. */
async function userItems(env: Env, id: string | null = null): Promise<UserListItem[]> {
  const [u, counts, agentCounts, access] = await Promise.all([
    env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE ? IS NULL OR u.id = ? ORDER BY u.created_at, u.id`).bind(id, id).all(),
    env.DB.prepare("SELECT created_by, COUNT(*) n FROM links WHERE ? IS NULL OR created_by = ? GROUP BY created_by").bind(id, id).all<{ created_by: string; n: number }>(),
    env.DB.prepare("SELECT user_id, COUNT(*) n FROM agent_connections WHERE revoked_at IS NULL AND (? IS NULL OR user_id = ?) GROUP BY user_id").bind(id, id).all<{ user_id: string; n: number }>(),
    // Owned domains first (via='owner'), then grants; the per-user loop below keeps the first sighting so owner rows win.
    env.DB.prepare(
      `SELECT * FROM (SELECT owner_id uid, id, host, 'owner' via, 0 rk FROM domains
       UNION ALL SELECT m.user_id, d.id, d.host, 'member', 1 FROM domain_members m JOIN domains d ON d.id = m.domain_id)
       WHERE ? IS NULL OR uid = ? ORDER BY uid, rk, host`,
    ).bind(id, id).all<{ uid: string; id: string; host: string; via: "owner" | "member" }>(),
  ]);
  const n = new Map(counts.results.map((r) => [r.created_by, r.n]));
  const ac = new Map(agentCounts.results.map((r) => [r.user_id, r.n]));
  const doms = new Map<string, UserListItem["domains"]>();
  for (const a of access.results) {
    const list = doms.get(a.uid) ?? [];
    if (!list.some((d) => d.id === a.id)) list.push({ id: a.id, host: a.host, via: a.via });
    doms.set(a.uid, list);
  }
  return u.results.map((r) => {
    const x = rowToUser(r);
    return { ...x, linkCount: n.get(x.id) ?? 0, agentCount: ac.get(x.id) ?? 0, domains: doms.get(x.id) ?? [] };
  });
}

users.get("/", async (c) => {
  // R11: domain managers need the list for the domain members editor.
  if (!can(c.var.user, "people.manage") && !can(c.var.user, "domains.manage")) return c.json(forbidden, 403);
  // shortcut: no pagination, the user table is small (same as domains); add a cursor if it grows.
  return c.json({ items: await userItems(c.env) });
});

users.delete("/:id/sessions", async (c) => {
  const me = c.var.user;
  if (!can(me, "people.manage")) return c.json(forbidden, 403);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(BY_ID).bind(id).first();
  if (!row) return c.json(notFound, 404);
  // An owner may sign themselves out everywhere here; anyone else uses their own account screen (R4 self rule).
  if (id === me.id && me.role !== "owner") return c.json({ error: "self" }, 409);
  if (!reaches(me, rowToUser(row))) return c.json(above, 403);
  const g = peopleOk(me.id, id);
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: me.id, action: "session.end_all", targetType: "user", targetId: id, count: { sql: "SELECT COUNT(*) FROM sessions WHERE user_id = ?", binds: [id] } },
      and({ sql: "EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)", binds: [id] }, g)),
    endSessionStmt(c.env, { userId: id }, g),
  ]);
  if (!res[1]!.meta.changes) {
    const w = await refusal(c.env, me.id, id);
    if (!w.a) return c.json(forbidden, 403);
    if (!w.w) return c.json(above, 403);
  }
  if (id === me.id) c.header("Set-Cookie", clearCookie());
  return c.body(null, 204);
});

const patchBody = z.strictObject({ roleId: z.string().min(1).max(64).optional(), status: z.enum(["active", "disabled"]).optional() });
type RoleRow = { id: string; name: string; perms: string };

users.patch("/:id", async (c) => {
  const me = c.var.user, env = c.env;
  if (!can(me, "people.manage")) return c.json(forbidden, 403);
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { roleId, status } = body.data;
  if (!roleId && !status) return c.json({ error: "no_changes" }, 400);
  const id = c.req.param("id");
  if (id === me.id) return c.json({ error: "self" }, 409);
  const [row, nr] = await Promise.all([
    env.DB.prepare(BY_ID).bind(id).first(),
    roleId ? env.DB.prepare("SELECT id, name, perms FROM roles WHERE id = ?").bind(roleId).first<RoleRow>() : null,
  ]);
  if (roleId && !nr) return c.json({ error: "bad_role" }, 400);
  if (!row) return c.json(notFound, 404);
  const t = rowToUser(row);
  // R4: never on an owner or a person above you, never to Owner or a role above you (owners: anyone, anything).
  if (!reaches(me, t)) return c.json(above, 403);
  const next = nr && nr.id !== t.roleId ? { id: nr.id, name: nr.name, perms: nr.id === "owner" ? null : parsePerms(nr.perms) } : null;
  if (next && me.role !== "owner" && (next.id === "owner" || !within(next.perms!, me))) return c.json(above, 403);
  if ((status === "disabled" && t.status === "disabled") || (status === "active" && t.status !== "disabled")) return c.json({ error: "bad_state" }, 409);
  if (!next && !status) return c.json({ user: (await userItems(env, id))[0] });
  // R13: owner is role 'owner' with role_id NULL (cleared in the same statement, or the 0011 trigger aborts); Member is
  // role_id NULL; a custom role is role 'member' with its id.
  const newRole = next ? (next.id === "owner" ? "owner" : "member") : t.role;
  const curRoleId = t.role === "member" && t.roleId !== "member" ? t.roleId : null;
  const newRoleId = next ? (next.id === "owner" || next.id === "member" ? null : next.id) : curRoleId;
  const demote = t.role === "owner" && newRole !== "owner";
  const losesOwner = t.role === "owner" && (demote || status === "disabled");
  const moved = demote
    ? (await env.DB.prepare(`SELECT host FROM domains WHERE owner_id = ? AND ${SHARED} ORDER BY host`).bind(id).all<{ host: string }>()).results.map((r) => r.host)
    : [];
  // The target still holds what was read (so `from` is exact), the actor still manages people and still reaches both the
  // target and the new role (R4), and removing owner rights never leaves zero active owners (S7 R4).
  const g = and(
    { sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND role_id IS ? AND status = ?)", binds: [id, t.role, curRoleId, t.status] },
    peopleOk(me.id, id),
    !!next && roleWithin(next.id, me.id),
    losesOwner && { sql: OTHER_OWNER, binds: [id] },
    // None outside the read list (still true once the batch has moved them), so the audit's list is complete.
    // json_each keeps it at two binds whatever the domain count (D1 caps a statement at 100 bound values).
    demote && { sql: `NOT EXISTS (SELECT 1 FROM domains WHERE owner_id = ? AND ${SHARED} AND host NOT IN (SELECT value FROM json_each(?)))`, binds: [id, JSON.stringify(moved)] },
  );
  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];
  if (next) stmts.push(auditStmt(env, { actorId: me.id, action: "user.role", targetType: "user", targetId: id,
    detail: { email: t.email, from: t.roleName, to: next.name, fromId: t.roleId, toId: next.id, movedDomains: moved } }, g));
  if (status) stmts.push(auditStmt(env, { actorId: me.id, action: status === "disabled" ? "user.disable" : "user.enable", targetType: "user", targetId: id, detail: { email: t.email } }, g));
  // R5: a member never owns a main or shared domain.
  if (demote) stmts.push(env.DB.prepare(`UPDATE domains SET owner_id = ? WHERE owner_id = ? AND ${SHARED} AND ${g.sql}`).bind(me.id, id, ...g.binds));
  if (status === "disabled") {
    // D1 marks first: sessions end and agent connections are revoked in the same batch; OAUTH_KV is cleared after commit.
    // Unused email links go too, or a re-enable within their 15 minutes would revive one.
    stmts.push(endSessionStmt(env, { userId: id }, g),
      env.DB.prepare(`DELETE FROM login_tokens WHERE email = ? COLLATE NOCASE AND ${g.sql}`).bind(t.email, ...g.binds),
      env.DB.prepare(`UPDATE agent_connections SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${g.sql}`).bind(now, id, ...g.binds));
  }
  stmts.push(env.DB.prepare(`UPDATE users SET role = ?, role_id = ?, status = ? WHERE id = ? AND ${g.sql}`).bind(newRole, newRoleId, status ?? t.status, id, ...g.binds));
  const res = await env.DB.batch(stmts);
  if (!res[res.length - 1]!.meta.changes) {
    const [w, x] = await Promise.all([
      refusal(env, me.id, id, next?.id ?? null),
      env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM users WHERE id = ?) e, ${OTHER_OWNER} o`).bind(id, id).first<{ e: number; o: number }>(),
    ]);
    if (!w.a) return c.json(forbidden, 403);
    if (!x?.e) return c.json(notFound, 404);
    if (!w.w || (next && !w.n)) return c.json(above, 403);
    if (losesOwner && !x.o) return c.json({ error: "last_owner" }, 409);
    return c.json({ error: "changed" }, 409);
  }
  if (status === "disabled") await revokeGrants(env, id);
  await Promise.all(moved.map((h) => purgeHost(env, h)));
  return c.json({ user: (await userItems(env, id))[0] });
});

users.delete("/:id", async (c) => {
  const me = c.var.user, env = c.env;
  if (!can(me, "people.manage")) return c.json(forbidden, 403);
  const id = c.req.param("id");
  if (id === me.id) return c.json({ error: "self" }, 409);
  const to = c.req.query("transferTo") || me.id;
  const [pr, tr, doms, ln] = await Promise.all([
    env.DB.prepare(BY_ID).bind(id).first(),
    env.DB.prepare(BY_ID).bind(to).first(),
    env.DB.prepare("SELECT host, type FROM domains WHERE owner_id = ? ORDER BY host").bind(id).all<{ host: string; type: string }>(),
    env.DB.prepare("SELECT COUNT(*) n FROM links WHERE created_by = ?").bind(id).first<{ n: number }>(),
  ]);
  if (!pr) return c.json(notFound, 404);
  const p = rowToUser(pr), t = tr ? rowToUser(tr) : null;
  if (!reaches(me, p)) return c.json(above, 403);
  if (to === id || !t || t.status !== "active") return c.json({ error: "bad_transfer" }, 400);
  const needsOwner = doms.results.some((d) => d.type !== "private");
  if (needsOwner && t.role !== "owner") return c.json({ error: "transfer_needs_owner" }, 400);
  const hosts = doms.results.map((d) => d.host);
  // R5 stays exact either way: an owner target must still be an owner, a member target only takes private domains.
  const g = and(
    { sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = ?)", binds: [id, p.role, p.status] },
    { sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active'${t.role === "owner" ? " AND role = 'owner'" : ""})`, binds: [to] },
    t.role !== "owner" && { sql: `NOT EXISTS (SELECT 1 FROM domains WHERE owner_id = ? AND ${SHARED})`, binds: [id] },
    peopleOk(me.id, id),
    p.role === "owner" && p.status === "active" && { sql: OTHER_OWNER, binds: [id] },
  );
  const q = (sql: string, ...a: unknown[]) => env.DB.prepare(`${sql} AND ${g.sql}`).bind(...a, ...g.binds);
  // R13: api_keys and agent_connections reference users(id) without cascade, so they go before the user row.
  // shortcut: `links` and `domains` in the audit detail are read just before the batch; a link the person makes in that window moves but is not counted.
  const res = await env.DB.batch([
    auditStmt(env, { actorId: me.id, action: "user.remove", targetType: "user", targetId: id,
      detail: { email: p.email, role: p.role, transferTo: to, links: ln?.n ?? 0, domains: hosts } }, g),
    q("UPDATE links SET created_by = ? WHERE created_by = ?", to, id),
    q("UPDATE domains SET owner_id = ? WHERE owner_id = ?", to, id),
    q("DELETE FROM domain_members WHERE user_id = ?", id),
    q("DELETE FROM api_keys WHERE user_id = ?", id),
    q("DELETE FROM agent_connections WHERE user_id = ?", id),
    q("DELETE FROM login_tokens WHERE email = ? COLLATE NOCASE", p.email),
    q("DELETE FROM users WHERE id = ?", id),
  ]);
  if (!res[res.length - 1]!.meta.changes) {
    const [r, w] = await Promise.all([refusal(env, me.id, id), env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM users WHERE id = ?) e, EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active') t,
       EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'owner') tOwner, EXISTS (SELECT 1 FROM domains WHERE owner_id = ? AND ${SHARED}) needs, ${OTHER_OWNER} o`,
    ).bind(id, to, to, id, id).first<{ e: number; t: number; tOwner: number; needs: number; o: number }>()]);
    if (!r.a) return c.json(forbidden, 403);
    if (!w?.e) return c.json(notFound, 404);
    if (!r.w) return c.json(above, 403);
    if (!w.t) return c.json({ error: "bad_transfer" }, 400);
    if (w.needs && !w.tOwner) return c.json({ error: "transfer_needs_owner" }, 400);
    if (!w.o) return c.json({ error: "last_owner" }, 409);
    return c.json({ error: "changed" }, 409);
  }
  await revokeGrants(env, id);
  await Promise.all(hosts.map((h) => purgeHost(env, h)));
  return c.json({});
});
