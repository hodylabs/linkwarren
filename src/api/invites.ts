import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { cleanName } from "../names";
import { auditStmt } from "../audit";
import { emailConfigured, inviteEmail, sendEmail } from "../email";
import { dashUrl } from "../dash";
import type { Env } from "../env";
import { LIMITS, hitAll, limitKey } from "../limits";
import type { Grant } from "../principal";
import { getSettings } from "../settings";
import { actorCan, can, parsePerms, reaches, ROLE_JOIN, roleWithin, USER_COLS, within } from "../roles";
import { rowToUser, type UserListItem, type UserRow } from "../types";
import { parse } from "./signin";
import { and, peopleOk } from "./users";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Mounted at /api/users next to the user list (R1: no invite tokens; the invitee signs in by email link). */
export const invites = new Hono<E>();

export type InviteResult = { emailed: boolean; emailReason?: "not_configured" | "rejected" | "network" | "settings" | "too_many" };

// Per route, not invites.use("*"): a wildcard here would also guard the other /api/users routes.
const manager = createMiddleware<E>(async (c, next) => {
  if (!can(c.var.user, "people.manage")) return c.json({ error: "forbidden" }, 403);
  await next();
});
const above = { error: "role_above_you" } as const;

const inviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  roleId: z.string().min(1).max(64).default("member"),
  domainIds: z.array(z.string().max(64)).max(100).default([]),
  name: z.string().max(200).optional(),
});

type Invitee = { id: string; email: string; isOwner: boolean; roleName: string };

/** R12: the per-address minute, the invite hour and the invite UTC day, charged together or not at all. The day cap keeps
 * invites to 40 of Resend's free 100 mails a day (shared by all mail), so sign-in links keep the rest. */
const charge = async (env: Env, email: string) =>
  hitAll(env, [
    { key: await limitKey.invite(email), limit: LIMITS.inviteResend },
    { key: limitKey.inviteHour, limit: LIMITS.inviteHour },
    { key: limitKey.inviteDay, limit: LIMITS.inviteDay },
  ]);

/** The invite mail; the only link is <dashboard base>/join. Never throws. */
async function deliver(env: Env, inviter: UserRow, u: Invitee): Promise<InviteResult> {
  let name: string | null;
  try {
    name = (await getSettings(env)).name;
  } catch {
    console.warn("settings_read_failed");
    return { emailed: false, emailReason: "settings" };
  }
  const m = inviteEmail({ instanceName: name ?? "linkwarren", inviter: inviter.name || inviter.email, dashboardUrl: dashUrl(env, ""), roleName: u.roleName, isOwner: u.isOwner });
  const r = await sendEmail(env, { to: u.email, name, ...m });
  return r.ok ? { emailed: true } : { emailed: false, emailReason: r.reason };
}

invites.post("/invite", manager, async (c) => {
  const b = await parse(c, inviteBody);
  if (!b) return c.json({ error: "invalid_body" }, 400);
  const name = b.name === undefined || b.name.trim() === "" ? null : cleanName(b.name);
  if (name === null && b.name !== undefined && b.name.trim() !== "") return c.json({ error: "invalid_name" }, 400);
  const me = c.var.user;
  const ids = b.roleId === "owner" ? [] : [...new Set(b.domainIds)];
  // R4: granting shared domains is domain administration, so it needs domains.manage as well.
  if (ids.length && !can(me, "domains.manage")) return c.json({ error: "forbidden" }, 403);
  const [r, doms] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, perms FROM roles WHERE id = ?").bind(b.roleId).first<{ id: string; name: string; perms: string }>(),
    ids.length
      ? c.env.DB.prepare("SELECT id, host FROM domains WHERE type = 'shared' AND id IN (SELECT value FROM json_each(?)) ORDER BY host")
        .bind(JSON.stringify(ids)).all<{ id: string; host: string }>().then((x) => x.results)
      : [],
  ]);
  if (!r) return c.json({ error: "bad_role" }, 400);
  if (me.role !== "owner" && (r.id === "owner" || !within(parsePerms(r.perms), me))) return c.json(above, 403);
  if (doms.length !== ids.length) return c.json({ error: "bad_domain" }, 400);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const role = r.id === "owner" ? "owner" : "member", roleId = r.id === "owner" || r.id === "member" ? null : r.id;
  // The user row carries every re-check (the actor still manages people, the role is still within theirs, domains.manage
  // when granting domains, every granted domain is still shared); grants and audit follow it, so all of it commits or none.
  const g = and(actorCan(me.id, "people.manage"), roleWithin(r.id, me.id), ids.length > 0 && actorCan(me.id, "domains.manage"));
  const made = { sql: "EXISTS (SELECT 1 FROM users WHERE id = ?)", binds: [id] };
  let done: D1Result[];
  try {
    done = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO users (id, email, name, role, role_id, status, created_at) SELECT ?, ?, ?, ?, ?, 'invited', ?
        WHERE ${g.sql} AND (SELECT COUNT(*) FROM domains WHERE type = 'shared' AND id IN (SELECT value FROM json_each(?))) = ?`)
        .bind(id, b.email, name, role, roleId, now, ...g.binds, JSON.stringify(doms.map((d) => d.id)), doms.length),
      ...doms.map((d) => c.env.DB.prepare(`INSERT INTO domain_members (domain_id, user_id) SELECT ?, ? WHERE ${made.sql}`).bind(d.id, id, ...made.binds)),
      auditStmt(c.env, { actorId: me.id, action: "user.invite", targetType: "user", targetId: id,
        detail: { email: b.email, ...(name ? { name } : {}), role, roleId: r.id, roleName: r.name, domains: doms.map((d) => d.host) } }, made),
      c.env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.id = ?`).bind(id), // the answer's role name and perms
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "email_taken" }, 409);
    throw e;
  }
  if (!done[0]!.meta.changes) {
    const a = actorCan(me.id, "people.manage"), w = roleWithin(r.id, me.id), d = actorCan(me.id, "domains.manage");
    const x = await c.env.DB.prepare(`SELECT ${a.sql} a, ${w.sql} w, ${d.sql} d, EXISTS (SELECT 1 FROM roles WHERE id = ?) r`)
      .bind(...a.binds, ...w.binds, ...d.binds, r.id).first<{ a: number; w: number; d: number; r: number }>();
    if (!x?.a || (ids.length && !x.d)) return c.json({ error: "forbidden" }, 403);
    if (!x.r) return c.json({ error: "bad_role" }, 400); // deleted in between
    return x.w ? c.json({ error: "bad_domain" }, 400) : c.json(above, 403);
  }
  const user: UserListItem = {
    ...rowToUser(done.at(-1)!.results[0] as Record<string, unknown>), linkCount: 0, agentCount: 0,
    domains: doms.map((d) => ({ id: d.id, host: d.host, via: "member" as const })),
  };
  // The role as committed (a rename in between): the email says what the answer says.
  const u: Invitee = { id, email: b.email, isOwner: role === "owner", roleName: user.roleName };
  // The invite stands whatever happens to the mail.
  const res: InviteResult = !(await emailConfigured(c.env)) ? { emailed: false, emailReason: "not_configured" }
    : !(await charge(c.env, b.email)).ok ? { emailed: false, emailReason: "too_many" }
    : await deliver(c.env, me, u);
  return c.json({ user, ...res }, 201);
});

/** The user or a 404/409 response. */
async function invitedUser(env: Env, me: UserRow, id: string) {
  const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.id = ?`).bind(id).first();
  if (!row) return { ok: false, error: "not_found", status: 404 } as const;
  const t = rowToUser(row);
  if (t.status !== "invited") return { ok: false, error: "not_invited_state", status: 409 } as const;
  if (!reaches(me, t)) return { ok: false, error: "role_above_you", status: 403 } as const;
  return { ok: true, u: { id: t.id, email: t.email, isOwner: t.role === "owner", roleName: t.roleName } } as const;
}

const stillInvited = (id: string) => ({ sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'invited')", binds: [id] });

invites.post("/:id/resend", manager, async (c) => {
  const f = await invitedUser(c.env, c.var.user, c.req.param("id"));
  if (!f.ok) return c.json({ error: f.error }, f.status);
  const { u } = f;
  if (!(await emailConfigured(c.env))) return c.json({ error: "email_not_configured" }, 409);
  const hit = await charge(c.env, u.email);
  if (!hit.ok) return c.json({ error: hit.key === limitKey.inviteHour ? "too_many" : "too_soon" }, 429);
  const res = await deliver(c.env, c.var.user, u);
  // Guarded on the row existing, not on still being invited: a mail that went out is audited even if they signed in meanwhile.
  await auditStmt(c.env, { actorId: c.var.user.id, action: "user.invite_resend", targetType: "user", targetId: u.id, detail: { email: u.email, emailed: res.emailed } },
    { sql: "EXISTS (SELECT 1 FROM users WHERE id = ?)", binds: [u.id] }).run();
  return c.json(res);
});

invites.delete("/:id/invite", manager, async (c) => {
  const f = await invitedUser(c.env, c.var.user, c.req.param("id"));
  if (!f.ok) return c.json({ error: f.error }, f.status);
  const { u } = f;
  const me = c.var.user.id;
  const g = and(stillInvited(u.id), peopleOk(me, u.id));
  // Every statement is guarded on still being invited (a sign-in that activates them in between wins and nothing is
  // deleted) and on the actor still managing people within reach of the invitee (R4).
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: c.var.user.id, action: "user.revoke", targetType: "user", targetId: u.id, detail: { email: u.email } }, g),
    c.env.DB.prepare(`DELETE FROM domain_members WHERE user_id = ? AND ${g.sql}`).bind(u.id, ...g.binds),
    // login_tokens keeps the address as typed at sign-in, so match it without case.
    c.env.DB.prepare(`DELETE FROM login_tokens WHERE email = ? COLLATE NOCASE AND ${g.sql}`).bind(u.email, ...g.binds),
    c.env.DB.prepare(`DELETE FROM users WHERE id = ? AND ${g.sql}`).bind(u.id, ...g.binds),
  ]);
  if (!res[3]!.meta.changes) {
    const a = actorCan(me, "people.manage");
    if (!(await c.env.DB.prepare(`SELECT ${a.sql} a`).bind(...a.binds).first<{ a: number }>())?.a) return c.json({ error: "forbidden" }, 403);
    const again = await invitedUser(c.env, c.var.user, u.id);
    return again.ok ? c.json({ error: "not_invited_state" }, 409) : c.json({ error: again.error }, again.status);
  }
  return c.json({});
});
