import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { dash } from "../dash";
import type { Env } from "../env";
import { canManageDomain, canUseDomain } from "../perm";
import { actor, type Grant } from "../principal";
import { actorCan, type Guard } from "../roles";
import { newShareToken, shareHash } from "../share";
import { LINK_SELECT, rowToDomain, rowToLink, type DomainRow, type UserRow } from "../types";
import { canEditLink, editGuard } from "./links";
import { parse } from "./signin";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/**
 * S13 R7: share pages of one link or one domain. Creating, listing and revoking need the right to edit the link (canEditLink)
 * or to manage the domain (canManageDomain), checked on every route and re-checked in each write's batch. The token is answered
 * once, by POST; only its hash is stored, and lists never carry it. Creating and revoking are audit-logged (never the token).
 */
export const shares = new Hono<E>();

/** Active shares per link or domain: each one is an unguessable URL, so a few are plenty. */
export const MAX_SHARES = 10;
export type ShareItem = { id: string; scope: "link" | "domain"; scopeId: string; createdAt: number; createdBy: string };
const notFound = { error: "not_found" } as const;
const forbidden = { error: "forbidden" } as const;
type Target = { scope: "link" | "domain"; scopeId: string; domainId: string; guard: Guard };

/** The target and the guard its writes re-check; 404 when unknown or not usable, 403 when usable but not editable. */
async function target(c: Context<E>, scope: "link" | "domain", id: string): Promise<Target | { status: 403 | 404 }> {
  const user = c.var.user, only = c.var.grant.domains;
  if (scope === "domain") {
    const [dr, mr] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id),
      c.env.DB.prepare("SELECT 1 FROM domain_members WHERE domain_id = ? AND user_id = ?").bind(id, user.id),
    ]);
    const row = dr!.results[0] as Record<string, unknown> | undefined;
    if (!row) return { status: 404 };
    const d = rowToDomain(row);
    if (only && !only.includes(d.id)) return { status: 404 };
    if (!canManageDomain(user, d)) return { status: canUseDomain(user, d, mr!.results.length > 0, only) ? 403 : 404 };
    return { scope, scopeId: d.id, domainId: d.id, guard: manageGuard(user, d) };
  }
  const [lr, dr, mr] = await c.env.DB.batch([
    c.env.DB.prepare(`${LINK_SELECT} WHERE id = ?`).bind(id),
    c.env.DB.prepare("SELECT d.* FROM links l JOIN domains d ON d.id = l.domain_id WHERE l.id = ?").bind(id),
    c.env.DB.prepare("SELECT 1 FROM links l JOIN domain_members m ON m.domain_id = l.domain_id WHERE l.id = ? AND m.user_id = ?").bind(id, user.id),
  ]);
  const lrow = lr!.results[0] as Record<string, unknown> | undefined, drow = dr!.results[0] as Record<string, unknown> | undefined;
  if (!lrow || !drow) return { status: 404 };
  const link = rowToLink(lrow), domain = rowToDomain(drow), member = mr!.results.length > 0;
  if (!canUseDomain(user, domain, member, only)) return { status: 404 };
  if (link.forwardTo || !canEditLink(user, link, domain, member, only)) return { status: 403 };
  // The link must still be on the same domain at write time, so a share never covers a domain the check did not see.
  const g = editGuard(user, link, domain);
  const u = useGuard(user.id, domain.id);
  return { scope, scopeId: link.id, domainId: domain.id, guard: { sql: `(${g.sql}) AND EXISTS (SELECT 1 FROM links WHERE id = ? AND domain_id = ?) AND ${u.sql}`, binds: [...g.binds, link.id, domain.id, ...u.binds] } };
}

/** SQL twin of canUseDomain (src/perm.ts) at write time; the grant's domain list was already checked and cannot change mid-request. */
const useGuard = (userId: string, domainId: string): Guard => ({
  sql: `EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active' AND (u.role = 'owner' OR EXISTS (
          SELECT 1 FROM domains d WHERE d.id = ? AND d.status != 'disabled' AND (d.type = 'main'
            OR (d.type IN ('shared', 'private') AND EXISTS (SELECT 1 FROM domain_members m WHERE m.domain_id = d.id AND m.user_id = u.id))
            OR (d.type = 'private' AND d.owner_id = u.id)))))`,
  binds: [userId, domainId],
});

/** SQL twin of canManageDomain: an active owner, the domain's active owner, or domains.manage. */
const manageGuard = (user: UserRow, d: DomainRow): Guard => {
  const m = actorCan(user.id, "domains.manage");
  return {
    sql: `(EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND (role = 'owner' OR EXISTS (SELECT 1 FROM domains WHERE id = ? AND owner_id = ?))) OR ${m.sql})`,
    binds: [user.id, d.id, user.id, ...m.binds],
  };
};

const toItem = (r: Record<string, unknown>): ShareItem =>
  ({ id: String(r.id), scope: r.scope as "link" | "domain", scopeId: String(r.scope_id), createdAt: Number(r.created_at), createdBy: String(r.created_by) });

const createBody = z.strictObject({ scope: z.enum(["link", "domain"]), id: z.string().min(1).max(64) });

shares.post("/", async (c) => {
  const b = await parse(c, createBody);
  if (!b) return c.json({ error: "invalid_body" }, 400);
  const t = await target(c, b.scope, b.id);
  if ("status" in t) return c.json(t.status === 404 ? notFound : forbidden, t.status);
  const id = crypto.randomUUID(), token = newShareToken(), now = Math.floor(Date.now() / 1000);
  // The cap and the right are checked inside the INSERT; the audit row is written only when the share was.
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO share_links (id, token_hash, scope, scope_id, domain_id, created_by, created_at) SELECT ?,?,?,?,?,?,?
       WHERE (SELECT COUNT(*) FROM share_links WHERE scope = ? AND scope_id = ? AND revoked_at IS NULL) < ${MAX_SHARES} AND ${t.guard.sql}`,
    ).bind(id, await shareHash(token), t.scope, t.scopeId, t.domainId, c.var.user.id, now, t.scope, t.scopeId, ...t.guard.binds),
    auditStmt(c.env, { ...actor(c), action: "share.create", targetType: t.scope, targetId: t.scopeId, detail: { share: id } },
      { sql: "EXISTS (SELECT 1 FROM share_links WHERE id = ?)", binds: [id] }),
  ]);
  if (!ins!.meta.changes) {
    const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM share_links WHERE scope = ? AND scope_id = ? AND revoked_at IS NULL").bind(t.scope, t.scopeId).first<{ n: number }>();
    return (n?.n ?? 0) >= MAX_SHARES ? c.json({ error: "share_limit" }, 409) : c.json(forbidden, 403);
  }
  const item: ShareItem = { id, scope: t.scope, scopeId: t.scopeId, createdAt: now, createdBy: c.var.user.id };
  // Shown once: the token is not stored, so it can never be read back.
  return c.json({ ...item, url: `${dash(c.env)!.base}/share/${token}` }, 201);
});

shares.get("/", async (c) => {
  const link = c.req.query("link"), domain = c.req.query("domain");
  if (!link === !domain) return c.json({ error: "invalid_query" }, 400);
  const scope = link ? "link" : "domain", id = (link ?? domain)!;
  if (id.length > 64) return c.json(notFound, 404);
  const t = await target(c, scope, id);
  if ("status" in t) return c.json(t.status === 404 ? notFound : forbidden, t.status);
  const r = await c.env.DB.prepare(
    "SELECT id, scope, scope_id, created_at, created_by FROM share_links WHERE scope = ? AND scope_id = ? AND domain_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id",
  ).bind(t.scope, t.scopeId, t.domainId).all();
  return c.json({ items: r.results.map(toItem) });
});

shares.delete("/:id", async (c) => {
  const s = await c.env.DB.prepare("SELECT scope, scope_id FROM share_links WHERE id = ? AND revoked_at IS NULL").bind(c.req.param("id"))
    .first<{ scope: "link" | "domain"; scope_id: string }>();
  if (!s) return c.json(notFound, 404);
  // The same right as creating one, on the share's own link or domain (never just knowing the share's id).
  const t = await target(c, s.scope, s.scope_id);
  if ("status" in t) return c.json(t.status === 404 ? notFound : forbidden, t.status);
  const id = c.req.param("id"), now = Math.floor(Date.now() / 1000);
  const [, upd] = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "share.revoke", targetType: t.scope, targetId: t.scopeId, detail: { share: id } },
      { sql: `EXISTS (SELECT 1 FROM share_links WHERE id = ? AND revoked_at IS NULL) AND ${t.guard.sql}`, binds: [id, ...t.guard.binds] }),
    c.env.DB.prepare(`UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND ${t.guard.sql}`).bind(now, id, ...t.guard.binds),
  ]);
  return upd!.meta.changes ? c.body(null, 204) : c.json(forbidden, 403);
});
