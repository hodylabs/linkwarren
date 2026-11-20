import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { invalidateHost } from "../cache";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { canManageDomain, canUseDomain } from "../perm";
import { rowToDomain, type DomainRow, type UserRow } from "../types";
import { checkDestination, checkSlugShape } from "../validate";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const domains = new Hono<E>();

const forbidden = { error: "forbidden" } as const;
const notFound = { error: "not_found" } as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const createBody = z.strictObject({ host: z.string(), type: z.enum(["main", "shared", "private"]) });
const patchBody = z.strictObject({
  bareRedirect: z.string().nullable().optional(), notfoundRedirect: z.string().nullable().optional(),
  caseSensitive: z.boolean().optional(), noindex: z.boolean().optional(),
  reservedExtra: z.array(z.string()).max(100).optional(),
});
// 100 is D1's bind cap for the member lookup below.
const membersBody = z.strictObject({ userIds: z.array(z.string().min(1)).max(100) });

const getDomain = async (env: Env, id: string): Promise<DomainRow | null> => {
  const r = await env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first();
  return r ? rowToDomain(r) : null;
};
const isMember = async (env: Env, domainId: string, userId: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM domain_members WHERE domain_id = ? AND user_id = ?").bind(domainId, userId).first());
const allHosts = async (env: Env) =>
  (await env.DB.prepare("SELECT host FROM domains").all<{ host: string }>()).results.map((r) => r.host);

// A failed purge must not turn a committed write into a 500; entries expire by TTL anyway.
const purge = (env: Env, host: string) =>
  invalidateHost(env, host).catch((e) => console.warn("cache invalidate failed", String(e)));
const exists = (id: string) => ({ sql: "EXISTS (SELECT 1 FROM domains WHERE id = ?)", binds: [id] });

/** Hostname check on the normalized host: dotted DNS labels, non-numeric TLD (rejects IPv4), at most 253 chars. */
function hostError(host: string, dashboard: string): string | null {
  if (host === normalizeHost(dashboard)) return "dashboard_host";
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
  const bad = hostError(host, c.env.DASHBOARD_HOST);
  if (bad) return c.json({ error: bad }, 400);
  const d: DomainRow = {
    id: crypto.randomUUID(), host, type, status: isOwner ? "active" : "pending", ownerId: user.id,
    bareRedirect: null, notfoundRedirect: null, caseSensitive: false, noindex: true, reservedExtra: [],
    createdAt: Math.floor(Date.now() / 1000),
  };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,?)")
        .bind(d.id, host, type, d.status, user.id, d.createdAt),
      auditStmt(c.env, { actorId: user.id, action: "domain.create", targetType: "domain", targetId: d.id,
        detail: { host, type, status: d.status } }, exists(d.id)),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "host_taken" }, 409);
    throw e;
  }
  await purge(c.env, host); // clears a 60 s cached miss for this host
  return c.json(d, 201);
});

domains.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  if (!canManageDomain(user, d)) return c.json(forbidden, 403);
  if (b.reservedExtra?.some((s) => !checkSlugShape(s).ok)) return c.json({ error: "invalid_reserved" }, 400);
  const hosts = await allHosts(c.env);
  const target = (raw: string | null | undefined, cur: string | null): { v: string | null } | { err: string } => {
    if (raw === undefined) return { v: cur };
    if (raw === null) return { v: null };
    const r = checkDestination(raw, hosts);
    return r.ok ? { v: r.url.href } : { err: r.reason };
  };
  const bare = target(b.bareRedirect, d.bareRedirect), nf = target(b.notfoundRedirect, d.notfoundRedirect);
  if ("err" in bare) return c.json({ error: bare.err }, 400);
  if ("err" in nf) return c.json({ error: nf.err }, 400);
  const next: DomainRow = {
    ...d, bareRedirect: bare.v, notfoundRedirect: nf.v, caseSensitive: b.caseSensitive ?? d.caseSensitive,
    noindex: b.noindex ?? d.noindex, reservedExtra: b.reservedExtra ?? d.reservedExtra,
  };
  const stmts = [
    c.env.DB.prepare("UPDATE domains SET bare_redirect=?, notfound_redirect=?, case_sensitive=?, noindex=?, reserved_extra=? WHERE id=?")
      .bind(next.bareRedirect, next.notfoundRedirect, next.caseSensitive ? 1 : 0, next.noindex ? 1 : 0, JSON.stringify(next.reservedExtra), d.id),
    auditStmt(c.env, { actorId: user.id, action: "domain.update", targetType: "domain", targetId: d.id,
      detail: { host: d.host, changed: Object.keys(b) } }, exists(d.id)),
  ];
  if (next.caseSensitive !== d.caseSensitive) {
    // Existing slug_keys follow the old mode. Rekeying runs in the same batch; a case twin violates UNIQUE and rolls it all back.
    if (next.caseSensitive) stmts.push(c.env.DB.prepare("UPDATE links SET slug_key = slug WHERE domain_id = ?").bind(d.id));
    else stmts.push(
      c.env.DB.prepare("UPDATE links SET slug_key = lower(slug) WHERE domain_id = ?").bind(d.id),
      c.env.DB.prepare("UPDATE OR IGNORE slug_locks SET slug_key = lower(slug_key) WHERE domain_id = ?").bind(d.id),
      c.env.DB.prepare("DELETE FROM slug_locks WHERE domain_id = ? AND slug_key != lower(slug_key)").bind(d.id),
    );
  }
  try {
    const res = await c.env.DB.batch(stmts);
    if (res[0]!.meta.changes === 0) return c.json(notFound, 404);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "case_conflict" }, 409);
    throw e;
  }
  // shortcut: cached link entries under the old slug_key expire by TTL (max 300 s); KV cannot be listed by domain cheaply.
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
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE domains SET status = ? WHERE id = ?").bind(to, d.id),
        auditStmt(c.env, { actorId: user.id, action: `domain.${verb}`, targetType: "domain", targetId: d.id,
          detail: { host: d.host, from: d.status } }, exists(d.id)),
      ]);
      await purge(c.env, d.host);
    }
    return c.json({ ...d, status: to });
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
