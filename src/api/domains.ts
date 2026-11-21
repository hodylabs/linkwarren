import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { canManageDomain, canUseDomain } from "../perm";
import { rowToDomain, type DomainRow, type UserRow } from "../types";
import { checkSlugShape } from "../validate";
import { destination, getDomain, loopField, purgeHost as purge, purgeMany } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const domains = new Hono<E>();

const forbidden = { error: "forbidden" } as const;
const notFound = { error: "not_found" } as const;
export const MAX_PENDING_PER_MEMBER = 3;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const createBody = z.strictObject({ host: z.string(), type: z.enum(["main", "shared", "private"]) });
const patchBody = z.strictObject({
  bareRedirect: z.string().nullable().optional(), notfoundRedirect: z.string().nullable().optional(),
  caseSensitive: z.boolean().optional(), noindex: z.boolean().optional(),
  reservedExtra: z.array(z.string()).max(100).optional(),
});
// 100 is D1's bind cap for the member lookup below.
const membersBody = z.strictObject({ userIds: z.array(z.string().min(1)).max(100) });

const exists = (id: string) => ({ sql: "EXISTS (SELECT 1 FROM domains WHERE id = ?)", binds: [id] });

/** Hostname check on the normalized host: dotted DNS labels, non-numeric TLD (rejects IPv4), at most 253 chars. */
export function hostError(host: string, dashboard: string, cnameTarget?: string): string | null {
  if (host === normalizeHost(dashboard)) return "dashboard_host";
  if (cnameTarget && host === normalizeHost(cnameTarget)) return "reserved_host";
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return "invalid_host";
  return null;
}

domains.get("/", async (c) => {
  const user = c.var.user;
  const members = new Set(
    (await c.env.DB.prepare("SELECT domain_id FROM domain_members WHERE user_id = ?").bind(user.id).all<{ domain_id: string }>())
      .results.map((r) => r.domain_id),
  );
  const counts = new Map(
    (await c.env.DB.prepare("SELECT domain_id, COUNT(*) n FROM links GROUP BY domain_id").all<{ domain_id: string; n: number }>())
      .results.map((r) => [r.domain_id, r.n]),
  );
  // shortcut: no pagination, the domain list is small; add a cursor if an instance ever hosts thousands.
  const items = (await c.env.DB.prepare("SELECT * FROM domains ORDER BY host").all()).results.map(rowToDomain)
    .filter((d) => canUseDomain(user, d, members.has(d.id)))
    .map((d) => ({ ...d, linkCount: counts.get(d.id) ?? 0, isMember: members.has(d.id) }));
  return c.json(items);
});

domains.post("/", async (c) => {
  const user = c.var.user;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { type } = body.data;
  const isOwner = user.role === "owner";
  if (!isOwner && type !== "private") return c.json(forbidden, 403);
  const host = normalizeHost(body.data.host.trim());
  const bad = hostError(host, c.env.DASHBOARD_HOST, c.env.CF_CNAME_TARGET);
  if (bad) return c.json({ error: bad }, 400);
  const d: DomainRow = {
    id: crypto.randomUUID(), host, type, status: isOwner ? "active" : "pending", ownerId: user.id,
    bareRedirect: null, notfoundRedirect: null, caseSensitive: false, noindex: true, reservedExtra: [],
    createdAt: Math.floor(Date.now() / 1000),
  };
  let res;
  try {
    // The cap is inside the INSERT so concurrent creates cannot both slip past it; the follow-ups key on this row's id.
    res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO domains (id,host,type,status,owner_id,created_at) SELECT ?,?,?,?,?,?
         WHERE ? = 'owner' OR (SELECT COUNT(*) FROM domains WHERE owner_id = ? AND status = 'pending') < ${MAX_PENDING_PER_MEMBER}`,
      ).bind(d.id, host, type, d.status, user.id, d.createdAt, user.role, user.id),
      c.env.DB.prepare("INSERT INTO domain_cf (domain_id, kind, updated_at) SELECT ?, 'manual', ? WHERE EXISTS (SELECT 1 FROM domains WHERE id = ?)")
        .bind(d.id, d.createdAt, d.id),
      auditStmt(c.env, { actorId: user.id, action: "domain.create", targetType: "domain", targetId: d.id,
        detail: { host, type, status: d.status } }, exists(d.id)),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "host_taken" }, 409);
    throw e;
  }
  if (res[0]!.meta.changes === 0) return c.json({ error: "pending_limit" }, 409);
  await purge(c.env, host); // clears a 60 s cached miss for this host
  return c.json(isOwner ? { ...d, ...(await loopField(c.env, host)) } : d, 201);
});

domains.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  if (Object.keys(b).length === 0) return c.json({ error: "no_changes" }, 400);
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  if (!canManageDomain(user, d)) return c.json(forbidden, 403);
  if (b.reservedExtra?.some((s) => !checkSlugShape(s).ok)) return c.json({ error: "invalid_reserved" }, 400);
  const target = async (raw: string | null | undefined, cur: string | null): Promise<{ v: string | null } | { err: string }> => {
    if (raw === undefined) return { v: cur };
    if (raw === null) return { v: null };
    const r = await destination(c.env, raw);
    return "error" in r ? { err: r.error } : { v: r.href };
  };
  const bare = await target(b.bareRedirect, d.bareRedirect), nf = await target(b.notfoundRedirect, d.notfoundRedirect);
  if ("err" in bare) return c.json({ error: bare.err }, 400);
  if ("err" in nf) return c.json({ error: nf.err }, 400);
  const next: DomainRow = {
    ...d, bareRedirect: bare.v, notfoundRedirect: nf.v, caseSensitive: b.caseSensitive ?? d.caseSensitive,
    noindex: b.noindex ?? d.noindex, reservedExtra: b.reservedExtra ?? d.reservedExtra,
  };
  // Only the keys present are written, so concurrent edits of different settings do not clobber each other.
  const cols: [string, unknown][] = [];
  if (b.bareRedirect !== undefined) cols.push(["bare_redirect", next.bareRedirect]);
  if (b.notfoundRedirect !== undefined) cols.push(["notfound_redirect", next.notfoundRedirect]);
  if (b.caseSensitive !== undefined) cols.push(["case_sensitive", next.caseSensitive ? 1 : 0]);
  if (b.noindex !== undefined) cols.push(["noindex", next.noindex ? 1 : 0]);
  if (b.reservedExtra !== undefined) cols.push(["reserved_extra", JSON.stringify(next.reservedExtra)]);
  // Turning case-sensitivity on changes which public URLs match: /Spring no longer reaches the link "spring".
  const flip = next.caseSensitive !== d.caseSensitive;
  // Optimistic guard: every statement below only applies while the case mode is still the one we read.
  // Turning case-sensitivity off is also refused (same snapshot) while a lock and a live link are case twins with different keys.
  const twin = `SELECT 1 FROM slug_locks l JOIN links k ON k.domain_id = l.domain_id AND lower(k.slug) = lower(l.slug_key) AND k.slug_key != l.slug_key WHERE l.domain_id = ?`;
  const unchanged = {
    sql: `EXISTS (SELECT 1 FROM domains WHERE id = ? AND case_sensitive = ?)${flip && !next.caseSensitive ? ` AND NOT EXISTS (${twin})` : ""}`,
    binds: [d.id, d.caseSensitive ? 1 : 0, ...(flip && !next.caseSensitive ? [d.id] : [])],
  };
  if (flip && !next.caseSensitive && (await c.env.DB.prepare(twin).bind(d.id).first())) return c.json({ error: "case_conflict" }, 409);
  const stmts = [
    auditStmt(c.env, { actorId: user.id, action: "domain.update", targetType: "domain", targetId: d.id,
      detail: { host: d.host, changed: Object.keys(b) } }, unchanged),
  ];
  // Rekey existing slug_keys to the new mode. Locks are never rekeyed (their checks are always case-insensitive).
  // A link case twin violates UNIQUE and rolls the whole batch back.
  if (flip) stmts.push(c.env.DB.prepare(
    `UPDATE links SET slug_key = ${next.caseSensitive ? "slug" : "lower(slug)"} WHERE domain_id = ? AND ${unchanged.sql}`,
  ).bind(d.id, ...unchanged.binds));
  // The guard is an uncorrelated EXISTS, so the row key must be in the outer predicate.
  stmts.push(c.env.DB.prepare(`UPDATE domains SET ${cols.map(([k]) => `${k}=?`).join(", ") || "id=id"} WHERE id = ? AND ${unchanged.sql}`)
    .bind(...cols.map(([, v]) => v), d.id, ...unchanged.binds));
  let res;
  try {
    res = await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "case_conflict" }, 409);
    throw e;
  }
  if (res[res.length - 1]!.meta.changes === 0) return c.json({ error: "conflict" }, 409);
  if (flip) {
    // Cached link entries sit under the old slug_key; drop both spellings for every link (errors swallowed).
    const slugs = (await c.env.DB.prepare("SELECT slug FROM links WHERE domain_id = ?").bind(d.id).all<{ slug: string }>()).results;
    const keys = [...new Set(slugs.flatMap((r) => [r.slug, r.slug.toLowerCase()]))];
    // shortcut: one KV delete per key, so a very large domain can hit the subrequest cap; the TTL (300 s) covers the rest.
    const job = purgeMany(c.env, d.id, keys);
    try { c.executionCtx.waitUntil(job); } catch { await job; }
  }
  await purge(c.env, d.host);
  return c.json(next);
});

/** approve: pending or disabled -> active; disable: any -> disabled. Both owner-only and idempotent. */
for (const [verb, to] of [["approve", "active"], ["disable", "disabled"]] as const) {
  domains.post(`/:id/${verb}`, async (c) => {
    const user = c.var.user;
    if (user.role !== "owner") return c.json(forbidden, 403);
    const d = await getDomain(c.env, c.req.param("id"));
    if (!d) return c.json(notFound, 404);
    if (d.status !== to) {
      // Audit first, both guarded on the status we read: a racing change writes neither a phantom audit nor a stale status.
      const at = { sql: "EXISTS (SELECT 1 FROM domains WHERE id = ? AND status = ?)", binds: [d.id, d.status] };
      const res = await c.env.DB.batch([
        auditStmt(c.env, { actorId: user.id, action: `domain.${verb}`, targetType: "domain", targetId: d.id,
          detail: { host: d.host, from: d.status } }, at),
        c.env.DB.prepare("UPDATE domains SET status = ? WHERE id = ? AND status = ?").bind(to, d.id, d.status),
      ]);
      if (res[1]!.meta.changes === 0) {
        const cur = await getDomain(c.env, d.id);
        if (!cur) return c.json(notFound, 404);
        return c.json(verb === "approve" && cur.status === "active" ? { ...cur, ...(await loopField(c.env, cur.host)) } : cur);
      }
      await purge(c.env, d.host);
    }
    return c.json(verb === "approve" ? { ...d, status: to, ...(await loopField(c.env, d.host)) } : { ...d, status: to });
  });
}

domains.put("/:id/members", async (c) => {
  const user = c.var.user;
  if (user.role !== "owner") return c.json(forbidden, 403);
  const body = membersBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  if (d.type === "main") return c.json({ error: "main_domain" }, 400);
  const ids = [...new Set(body.data.userIds)];
  if (ids.length) {
    const found = (await c.env.DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results.length;
    if (found !== ids.length) return c.json({ error: "unknown_user" }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM domain_members WHERE domain_id = ?").bind(d.id),
    ...ids.map((u) => c.env.DB.prepare(
      "INSERT INTO domain_members (domain_id, user_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)",
    ).bind(d.id, u, u)),
    auditStmt(c.env, { actorId: user.id, action: "domain.members", targetType: "domain", targetId: d.id,
      detail: { host: d.host, userIds: ids } }, exists(d.id)),
  ]);
  return c.json({ userIds: ids });
});
