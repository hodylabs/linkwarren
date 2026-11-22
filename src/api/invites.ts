import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { auditStmt } from "../audit";
import { emailConfigured, inviteEmail, sendEmail } from "../email";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { LIMITS, hitAll, limitKey } from "../limits";
import type { Grant } from "../principal";
import { getSettings } from "../settings";
import type { UserListItem, UserRow } from "../types";
import { parse } from "./signin";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Mounted at /api/users next to the user list (R1: no invite tokens; the invitee signs in by email link). */
export const invites = new Hono<E>();

export type InviteResult = { emailed: boolean; emailReason?: "not_configured" | "rejected" | "network" | "too_many" };

// Per route, not invites.use("*"): a wildcard here would also guard the other /api/users routes.
const owner = createMiddleware<E>(async (c, next) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
});

const inviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(["member", "owner"]),
  domainIds: z.array(z.string().max(64)).max(100).default([]),
});

type Invitee = { id: string; email: string; role: "owner" | "member" };

/** R12: the per-invitee minute and the instance hour, charged together or not at all. */
const charge = (env: Env, id: string) => hitAll(env, [{ key: limitKey.invite(id), limit: LIMITS.inviteResend }, { key: limitKey.inst, limit: LIMITS.instance }]);

/** The invite mail; the only link is https://<DASHBOARD_HOST>/. Never throws. */
async function deliver(env: Env, inviter: UserRow, u: Invitee): Promise<InviteResult> {
  const m = inviteEmail({ instanceName: (await getSettings(env)).name ?? "linkwarren", inviter: inviter.name || inviter.email, dashboardHost: normalizeHost(env.DASHBOARD_HOST), role: u.role });
  const r = await sendEmail(env, { to: u.email, ...m });
  return r.ok ? { emailed: true } : { emailed: false, emailReason: r.reason };
}

invites.post("/invite", owner, async (c) => {
  const b = await parse(c, inviteBody);
  if (!b) return c.json({ error: "invalid_body" }, 400);
  const ids = b.role === "owner" ? [] : [...new Set(b.domainIds)];
  const doms = ids.length
    ? (await c.env.DB.prepare("SELECT id, host FROM domains WHERE type = 'shared' AND id IN (SELECT value FROM json_each(?)) ORDER BY host")
      .bind(JSON.stringify(ids)).all<{ id: string; host: string }>()).results
    : [];
  if (doms.length !== ids.length) return c.json({ error: "bad_domain" }, 400);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, NULL, ?, 'invited', ?)").bind(id, b.email, b.role, now),
      ...doms.map((d) => c.env.DB.prepare("INSERT INTO domain_members (domain_id, user_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)").bind(d.id, id, id)),
      auditStmt(c.env, { actorId: c.var.user.id, action: "user.invite", targetType: "user", targetId: id, detail: { email: b.email, role: b.role, domains: doms.map((d) => d.host) } }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "email_taken" }, 409);
    throw e;
  }
  const user: UserListItem = {
    id, email: b.email, name: null, role: b.role, status: "invited", createdAt: now, linkCount: 0, agentCount: 0,
    domains: doms.map((d) => ({ id: d.id, host: d.host, via: "member" as const })),
  };
  const u = { id, email: b.email, role: b.role };
  // The invite stands whatever happens to the mail.
  const res: InviteResult = !(await emailConfigured(c.env)) ? { emailed: false, emailReason: "not_configured" }
    : !(await charge(c.env, id)).ok ? { emailed: false, emailReason: "too_many" }
    : await deliver(c.env, c.var.user, u);
  return c.json({ user, ...res }, 201);
});

/** The user or a 404/409 response. */
async function invitedUser(env: Env, id: string) {
  const u = await env.DB.prepare("SELECT id, email, role, status FROM users WHERE id = ?").bind(id).first<Invitee & { status: string }>();
  if (!u) return { ok: false, error: "not_found", status: 404 } as const;
  if (u.status !== "invited") return { ok: false, error: "not_invited_state", status: 409 } as const;
  return { ok: true, u } as const;
}

const stillInvited = (id: string) => ({ sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'invited')", binds: [id] });

invites.post("/:id/resend", owner, async (c) => {
  const f = await invitedUser(c.env, c.req.param("id"));
  if (!f.ok) return c.json({ error: f.error }, f.status);
  const { u } = f;
  if (!(await emailConfigured(c.env))) return c.json({ error: "email_not_configured" }, 409);
  const hit = await charge(c.env, u.id);
  if (!hit.ok) return c.json({ error: hit.key === limitKey.inst ? "too_many" : "too_soon" }, 429);
  const res = await deliver(c.env, c.var.user, u);
  await auditStmt(c.env, { actorId: c.var.user.id, action: "user.invite_resend", targetType: "user", targetId: u.id, detail: { email: u.email, emailed: res.emailed } }, stillInvited(u.id)).run();
  return c.json(res);
});

invites.delete("/:id/invite", owner, async (c) => {
  const f = await invitedUser(c.env, c.req.param("id"));
  if (!f.ok) return c.json({ error: f.error }, f.status);
  const { u } = f;
  const g = stillInvited(u.id);
  // Every statement is guarded on still being invited: a sign-in that activates them in between wins and nothing is deleted.
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: c.var.user.id, action: "user.revoke", targetType: "user", targetId: u.id, detail: { email: u.email } }, g),
    c.env.DB.prepare(`DELETE FROM domain_members WHERE user_id = ? AND ${g.sql}`).bind(u.id, ...g.binds),
    // login_tokens keeps the address as typed at sign-in, so match it without case.
    c.env.DB.prepare(`DELETE FROM login_tokens WHERE email = ? COLLATE NOCASE AND ${g.sql}`).bind(u.email, ...g.binds),
    c.env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'invited'").bind(u.id),
  ]);
  if (!res[3]!.meta.changes) {
    const again = await invitedUser(c.env, u.id);
    return again.ok ? c.json({ error: "not_invited_state" }, 409) : c.json({ error: again.error }, again.status);
  }
  return c.json({});
});
