import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { canManageDomain, canUseDomain, usableDomainsSql } from "../perm";
import { rowToLink, type LinkRow, type UserRow } from "../types";
import { checkSlug, slugKey } from "../validate";
import { destination, getDomain, isMember, purge } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const links = new Hono<E>();

const PAGE = 50;
const forbidden = { error: "forbidden" } as const;

const times = {
  startsAt: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
};
const code = z.union([z.literal(301), z.literal(302)]);
const createBody = z.strictObject({
  domainId: z.string().min(1), slug: z.string(), url: z.string(),
  redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times,
});
const patchBody = z.strictObject({
  url: z.string().optional(), redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times,
});

const hasLock = async (env: Env, domainId: string, key: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?)").bind(domainId, key).first());

const badWindow = (s: number | null, x: number | null) => s !== null && x !== null && x <= s;

links.get("/check", async (c) => {
  const user = c.var.user;
  const domain = await getDomain(c.env, c.req.query("domain") ?? "");
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id))) return c.json(forbidden, 403);
  const slug = c.req.query("slug") ?? "";
  const s = checkSlug(slug, domain.reservedExtra);
  if (!s.ok) return c.json(s.reason === "reserved" ? { status: "reserved" } : { status: "invalid", reason: s.reason });
  const key = slugKey(slug, domain.caseSensitive);
  if (await hasLock(c.env, domain.id, key)) return c.json({ status: "locked" });
  const taken = await c.env.DB.prepare("SELECT 1 FROM links WHERE domain_id = ? AND slug_key = ?").bind(domain.id, key).first();
  return c.json({ status: taken ? "taken" : "available" });
});

links.get("/", async (c) => {
  const user = c.var.user;
  const where: string[] = [], binds: unknown[] = [];
  const want = c.req.query("domain");
  if (want) {
    const d = await getDomain(c.env, want);
    if (!d) return c.json({ error: "not_found" }, 404);
    if (!canUseDomain(user, d, await isMember(c.env, d.id, user.id))) return c.json(forbidden, 403);
    where.push("domain_id = ?");
    binds.push(want);
  } else if (user.role !== "owner") {
    // The owner can use every domain, so only members need the authorization subquery.
    where.push(`domain_id IN (${usableDomainsSql})`);
    binds.push(user.id);
  }
  const q = c.req.query("q");
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    // D1 caps LIKE patterns at 50 bytes.
    if (new TextEncoder().encode(like).length > 50) return c.json({ error: "q_too_long" }, 400);
    where.push("(slug LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const cursor = c.req.query("cursor");
  if (cursor !== undefined) {
    const dot = cursor.indexOf(".");
    const at = Number(cursor.slice(0, dot)), id = cursor.slice(dot + 1);
    if (dot < 1 || !Number.isInteger(at) || !id) return c.json({ error: "bad_cursor" }, 400);
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(at, at, id);
  }
  const rows = (await c.env.DB.prepare(
    `SELECT * FROM links ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`,
  ).bind(...binds).all()).results.map(rowToLink);
  const items = rows.slice(0, PAGE);
  return c.json({ items, next: rows.length > PAGE ? `${items[items.length - 1]!.createdAt}.${items[items.length - 1]!.id}` : null });
});

links.post("/", async (c) => {
  const user = c.var.user;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  const domain = await getDomain(c.env, b.domainId);
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id))) return c.json(forbidden, 403);
  const s = checkSlug(b.slug, domain.reservedExtra);
  if (!s.ok) return c.json({ error: s.reason === "too_long" ? "slug_too_long" : s.reason }, 400);
  const dest = await destination(c.env, b.url);
  if ("error" in dest) return c.json({ error: dest.error }, 400);
  const startsAt = b.startsAt ?? null, expiresAt = b.expiresAt ?? null;
  if (badWindow(startsAt, expiresAt)) return c.json({ error: "bad_window" }, 400);

  const key = slugKey(b.slug, domain.caseSensitive);
  if (await hasLock(c.env, domain.id, key)) return c.json({ error: "locked" }, 409);
  const now = Math.floor(Date.now() / 1000);
  const link: LinkRow = {
    id: crypto.randomUUID(), domainId: domain.id, slug: b.slug, slugKey: key, url: dest.href,
    redirectCode: b.redirectCode ?? 302, startsAt, expiresAt, passQuery: b.passQuery ?? true,
    createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now,
  };
  try {
    // The lock check is repeated inside the insert so a delete racing this request cannot be bypassed.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,created_by,updated_by,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?))`,
      ).bind(link.id, domain.id, link.slug, key, link.url, link.redirectCode, startsAt, expiresAt, link.passQuery ? 1 : 0,
        user.id, user.id, now, now, domain.id, key),
      auditStmt(c.env, { actorId: user.id, action: "link.create", targetType: "link", targetId: link.id,
        detail: { host: domain.host, slug: link.slug, url: link.url } },
      { sql: "EXISTS (SELECT 1 FROM links WHERE id = ?)", binds: [link.id] }),
    ]);
    if (res[0]!.meta.changes === 0) return c.json({ error: "locked" }, 409);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "taken" }, 409);
    throw e;
  }
  await purge(c.env, domain.id, key);
  return c.json(link, 201);
});

/** Loads a link and enforces edit rights: domain use, and (creator or domain manager). */
async function editable(c: { env: Env; var: { user: UserRow } }, id: string) {
  const user = c.var.user;
  const row = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(id).first();
  if (!row) return { status: 404 as const };
  const link = rowToLink(row);
  const domain = await getDomain(c.env, link.domainId);
  if (!domain) return { status: 404 as const };
  const ok = canUseDomain(user, domain, await isMember(c.env, domain.id, user.id))
    && (link.createdBy === user.id || canManageDomain(user, domain));
  return ok ? { link, domain } : { status: 403 as const };
}

links.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  let url = link.url;
  if (b.url !== undefined) {
    const dest = await destination(c.env, b.url);
    if ("error" in dest) return c.json({ error: dest.error }, 400);
    url = dest.href;
  }
  const next: LinkRow = {
    ...link, url, redirectCode: b.redirectCode ?? link.redirectCode, passQuery: b.passQuery ?? link.passQuery,
    startsAt: b.startsAt === undefined ? link.startsAt : b.startsAt,
    expiresAt: b.expiresAt === undefined ? link.expiresAt : b.expiresAt,
    // updated_at is the revision: always move it forward, even within the same second.
    updatedBy: user.id, updatedAt: Math.max(Math.floor(Date.now() / 1000), link.updatedAt + 1),
  };
  // The write below only lands on the row read here, so this window is the one that gets stored.
  if (badWindow(next.startsAt, next.expiresAt)) return c.json({ error: "bad_window" }, 400);
  const cols: [string, unknown][] = [];
  if (b.url !== undefined) cols.push(["url", next.url]);
  if (b.redirectCode !== undefined) cols.push(["redirect_code", next.redirectCode]);
  if (b.startsAt !== undefined) cols.push(["starts_at", next.startsAt]);
  if (b.expiresAt !== undefined) cols.push(["expires_at", next.expiresAt]);
  if (b.passQuery !== undefined) cols.push(["pass_query", next.passQuery ? 1 : 0]);
  cols.push(["updated_by", user.id], ["updated_at", next.updatedAt]);
  // Audit first, only while the row is still the revision read, so a lost race writes neither.
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: user.id, action: "link.update", targetType: "link", targetId: link.id,
      detail: { host: domain.host, slug: link.slug, url: next.url } },
    { sql: "EXISTS (SELECT 1 FROM links WHERE id = ? AND updated_at = ?)", binds: [link.id, link.updatedAt] }),
    c.env.DB.prepare(`UPDATE links SET ${cols.map(([k]) => `${k}=?`).join(", ")} WHERE id=? AND updated_at=?`)
      .bind(...cols.map(([, v]) => v), link.id, link.updatedAt),
  ]);
  if (res[1]!.meta.changes === 0) {
    const gone = !(await c.env.DB.prepare("SELECT 1 FROM links WHERE id = ?").bind(link.id).first());
    return gone ? c.json({ error: "not_found" }, 404) : c.json({ error: "conflict" }, 409);
  }
  await purge(c.env, link.domainId, link.slugKey);
  return c.json(next);
});

links.delete("/:id", async (c) => {
  const user = c.var.user;
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  // Lock and audit run before the DELETE and only while the link still exists, so a racing second delete writes neither.
  const here = { sql: "EXISTS (SELECT 1 FROM links WHERE id = ?)", binds: [link.id] };
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM links WHERE id = ?)",
    ).bind(link.domainId, link.slugKey, Math.floor(Date.now() / 1000), user.id, link.id),
    auditStmt(c.env, { actorId: user.id, action: "link.delete", targetType: "link", targetId: link.id,
      detail: { host: domain.host, slug: link.slug, url: link.url } }, here),
    c.env.DB.prepare("DELETE FROM links WHERE id = ?").bind(link.id),
  ]);
  if (res[2]!.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await purge(c.env, link.domainId, link.slugKey);
  return c.body(null, 204);
});

export const locks = new Hono<E>();

locks.delete("/:domainId/:slugKey", async (c) => {
  const user = c.var.user;
  if (user.role !== "owner") return c.json(forbidden, 403);
  const { domainId, slugKey: raw } = c.req.param();
  const domain = await getDomain(c.env, domainId);
  if (!domain) return c.json({ error: "not_found" }, 404);
  const key = slugKey(raw, domain.caseSensitive);
  const match = "domain_id = ? AND lower(slug_key) = lower(?)";
  const keys = (await c.env.DB.prepare(`SELECT slug_key FROM slug_locks WHERE ${match}`).bind(domainId, key).all<{ slug_key: string }>()).results.map((r) => r.slug_key);
  if (keys.length === 0) return c.json({ error: "not_found" }, 404);
  // Audit first, only while a lock still matches, so concurrent releases write one row.
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: user.id, action: "lock.release", targetType: "lock", targetId: `${domainId}/${key}`,
      detail: { domainId, slugKeys: keys } }, { sql: `EXISTS (SELECT 1 FROM slug_locks WHERE ${match})`, binds: [domainId, key] }),
    c.env.DB.prepare(`DELETE FROM slug_locks WHERE ${match}`).bind(domainId, key),
  ]);
  if (res[1]!.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await purge(c.env, domainId, key);
  return c.body(null, 204);
});
