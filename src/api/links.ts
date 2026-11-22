import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { hashPassword, iterationsOf } from "../password";
import { passwordRule } from "../password-rule";
import { canManageDomain, canUseDomain, usableDomains } from "../perm";
import { actor, type Grant } from "../principal";
import { rowToLink, toApiLink, type LinkRow, type Route, type UserRow } from "../types";
import { checkSlug, slugKey } from "../validate";
import { allHosts, destination, getDomain, isMember, purge } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const links = new Hono<E>();

const PAGE = 50;
const forbidden = { error: "forbidden" } as const;

const times = {
  startsAt: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
};
const code = z.union([z.literal(301), z.literal(302)]);
const routeInput = z.strictObject({
  countries: z.array(z.string()).max(50).optional(),
  devices: z.array(z.enum(["mobile", "tablet", "desktop"])).max(3).optional(),
  url: z.string(),
});
type RouteInput = z.infer<typeof routeInput>;
const rules = {
  // A string sets, null clears, absent keeps. Length is checked by passwordRule (code points); 1024 units only caps the work
  // (a longer one is answered password_long, see bodyError).
  password: z.string().max(1024).nullable().optional(),
  // Replaces the whole list; [] clears it.
  routes: z.array(routeInput).max(10).optional(),
};
const createBody = z.strictObject({
  domainId: z.string().min(1), slug: z.string(), url: z.string(),
  redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times, ...rules,
});
const patchBody = z.strictObject({
  url: z.string().optional(), redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times, ...rules,
});

/** Countries two ASCII letters (raw, then upper-cased; never XX or T1, they never match), deduped; each url checked like the main destination. */
export async function validateRoutes(env: Env, input: RouteInput[]): Promise<{ routes: Route[] } | { error: "bad_route"; index: number; reason: string }> {
  const routes: Route[] = [];
  // One host read for every route of the request.
  const hosts = input.length ? await allHosts(env) : [];
  for (const [index, r] of input.entries()) {
    const raw = r.countries ?? [];
    // Raw check first: "ß".toUpperCase() is "SS", which must not pass as a code.
    if (raw.some((c) => !/^[A-Za-z]{2}$/.test(c))) return { error: "bad_route", index, reason: "route_country" };
    const countries = [...new Set(raw.map((c) => c.toUpperCase()))];
    if (countries.includes("XX")) return { error: "bad_route", index, reason: "route_country" };
    const devices = [...new Set(r.devices ?? [])];
    if (!countries.length && !devices.length) return { error: "bad_route", index, reason: "route_empty" };
    const dest = await destination(env, r.url, [], hosts);
    if ("error" in dest) return { error: "bad_route", index, reason: dest.error };
    routes.push({ countries, devices, url: dest.href });
  }
  return { routes };
}

/** Undefined: keep. Null: clear. Otherwise the new hash (hashed here, before any batch, outside the revision race window). */
async function passwordInput(env: Env, raw: string | null | undefined): Promise<{ hash: string | null | undefined } | { error: string }> {
  if (raw === undefined || raw === null) return { hash: raw };
  const p = passwordRule(raw);
  if (!p.ok) return { error: p.reason };
  return { hash: await hashPassword(p.value, iterationsOf(env)) };
}

/** invalid_body, or password_long when an over-long password is the only problem (zod caps it at 1024 units). */
function bodyError(e: z.ZodError): string {
  return e.issues.every((i) => i.code === "too_big" && i.path.length === 1 && i.path[0] === "password") ? "password_long" : "invalid_body";
}

const hasLock = async (env: Env, domainId: string, key: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?)").bind(domainId, key).first());

const badWindow = (s: number | null, x: number | null) => s !== null && x !== null && x <= s;

links.get("/check", async (c) => {
  const user = c.var.user;
  const domain = await getDomain(c.env, c.req.query("domain") ?? "");
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  const slug = c.req.query("slug") ?? "";
  const s = checkSlug(slug, domain.reservedExtra);
  if (!s.ok) return c.json(s.reason === "reserved" ? { status: "reserved" } : { status: "invalid", reason: s.reason === "too_long" ? "slug_too_long" : s.reason });
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
    if (!canUseDomain(user, d, await isMember(c.env, d.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
    where.push("domain_id = ?");
    binds.push(want);
  } else if (user.role !== "owner" || c.var.grant.domains) {
    // An unrestricted owner can use every domain; everyone else (a restricted owner too) needs the authorization subquery.
    const u = usableDomains(user.id, c.var.grant.domains);
    where.push(`domain_id IN (${u.sql})`);
    binds.push(...u.binds);
  }
  const q = c.req.query("q");
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    // D1 caps LIKE patterns at 50 bytes.
    if (new TextEncoder().encode(like).length > 50) return c.json({ error: "q_too_long" }, 400);
    where.push("(slug LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const status = c.req.query("status");
  if (status !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    const windows = {
      active: ["(starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)", [now, now]],
      scheduled: ["starts_at > ?", [now]],
      expired: ["expires_at <= ?", [now]],
    } as const;
    // Own keys only: "constructor" or "__proto__" must not reach the prototype.
    if (!Object.hasOwn(windows, status)) return c.json({ error: "bad_status" }, 400);
    const w = windows[status as keyof typeof windows];
    where.push(`(${w[0]})`);
    binds.push(...w[1]);
  }
  if (c.req.query("mine") === "1") { where.push("created_by = ?"); binds.push(user.id); }
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
  return c.json({ items: items.map(toApiLink), next: rows.length > PAGE ? `${items[items.length - 1]!.createdAt}.${items[items.length - 1]!.id}` : null });
});

links.post("/", async (c) => {
  const user = c.var.user;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: bodyError(body.error) }, 400);
  const b = body.data;
  const domain = await getDomain(c.env, b.domainId);
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  const s = checkSlug(b.slug, domain.reservedExtra);
  if (!s.ok) return c.json({ error: s.reason === "too_long" ? "slug_too_long" : s.reason }, 400);
  const dest = await destination(c.env, b.url);
  if ("error" in dest) return c.json({ error: dest.error }, 400);
  const startsAt = b.startsAt ?? null, expiresAt = b.expiresAt ?? null;
  if (badWindow(startsAt, expiresAt)) return c.json({ error: "bad_window" }, 400);
  const redirectCode = b.redirectCode ?? 302;
  if (b.password != null && redirectCode === 301) return c.json({ error: "password_301" }, 400);
  const rt = await validateRoutes(c.env, b.routes ?? []);
  if ("error" in rt) return c.json(rt, 400);

  const key = slugKey(b.slug, domain.caseSensitive);
  if (await hasLock(c.env, domain.id, key)) return c.json({ error: "locked" }, 409);
  const pw = await passwordInput(c.env, b.password);
  if ("error" in pw) return c.json({ error: pw.error }, 400);
  const passwordHash = pw.hash ?? null;
  const now = Math.floor(Date.now() / 1000);
  const link: LinkRow = {
    id: crypto.randomUUID(), domainId: domain.id, slug: b.slug, slugKey: key, url: dest.href,
    redirectCode, startsAt, expiresAt, passQuery: b.passQuery ?? true,
    passwordHash, routes: rt.routes,
    createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now,
  };
  try {
    // The lock check is repeated inside the insert so a delete racing this request cannot be bypassed.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,password_hash,routes,created_by,updated_by,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?))`,
      ).bind(link.id, domain.id, link.slug, key, link.url, link.redirectCode, startsAt, expiresAt, link.passQuery ? 1 : 0,
        passwordHash, JSON.stringify(link.routes), user.id, user.id, now, now, domain.id, key),
      auditStmt(c.env, { ...actor(c), action: "link.create", targetType: "link", targetId: link.id,
        detail: { host: domain.host, slug: link.slug, url: link.url, ...(passwordHash ? { protection: "set" } : {}), ...(link.routes.length ? { routes: link.routes.length } : {}) } },
      { sql: "EXISTS (SELECT 1 FROM links WHERE id = ?)", binds: [link.id] }),
    ]);
    if (res[0]!.meta.changes === 0) return c.json({ error: "locked" }, 409);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "taken" }, 409);
    throw e;
  }
  await purge(c.env, domain.id, key);
  return c.json(toApiLink(link), 201);
});

/** Loads a link and enforces edit rights: domain use, and (creator or domain manager). */
async function editable(c: { env: Env; var: { user: UserRow; grant: Grant } }, id: string) {
  const user = c.var.user;
  const row = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(id).first();
  if (!row) return { status: 404 as const };
  const link = rowToLink(row);
  const domain = await getDomain(c.env, link.domainId);
  if (!domain) return { status: 404 as const };
  const ok = canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)
    && (link.createdBy === user.id || canManageDomain(user, domain));
  return ok ? { link, domain } : { status: 403 as const };
}

links.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: bodyError(body.error) }, 400);
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
  let routes = link.routes;
  if (b.routes !== undefined) {
    const rt = await validateRoutes(c.env, b.routes);
    if ("error" in rt) return c.json(rt, 400);
    routes = rt.routes;
  }
  // R4 and the window are checked on the merged next state; the write below only lands on the row read here.
  const protectedNext = b.password === undefined ? link.passwordHash !== null : b.password !== null;
  if (protectedNext && (b.redirectCode ?? link.redirectCode) === 301) return c.json({ error: "password_301" }, 400);
  if (badWindow(b.startsAt === undefined ? link.startsAt : b.startsAt, b.expiresAt === undefined ? link.expiresAt : b.expiresAt))
    return c.json({ error: "bad_window" }, 400);
  const pw = await passwordInput(c.env, b.password);
  if ("error" in pw) return c.json({ error: pw.error }, 400);
  const next: LinkRow = {
    ...link, url, redirectCode: b.redirectCode ?? link.redirectCode, passQuery: b.passQuery ?? link.passQuery,
    passwordHash: pw.hash === undefined ? link.passwordHash : pw.hash, routes,
    startsAt: b.startsAt === undefined ? link.startsAt : b.startsAt,
    expiresAt: b.expiresAt === undefined ? link.expiresAt : b.expiresAt,
    // updated_at is the revision: always move it forward, even within the same second.
    updatedBy: user.id, updatedAt: Math.max(Math.floor(Date.now() / 1000), link.updatedAt + 1),
  };
  const cols: [string, unknown][] = [];
  if (b.url !== undefined) cols.push(["url", next.url]);
  if (b.redirectCode !== undefined) cols.push(["redirect_code", next.redirectCode]);
  if (b.startsAt !== undefined) cols.push(["starts_at", next.startsAt]);
  if (b.expiresAt !== undefined) cols.push(["expires_at", next.expiresAt]);
  if (b.passQuery !== undefined) cols.push(["pass_query", next.passQuery ? 1 : 0]);
  if (b.password !== undefined) cols.push(["password_hash", next.passwordHash]);
  if (b.routes !== undefined) cols.push(["routes", JSON.stringify(next.routes)]);
  // R13: protection only when it changed (a new password is always a change), never the password or its hash.
  const protection = pw.hash ? "set" : pw.hash === null && link.passwordHash !== null ? "cleared" : undefined;
  cols.push(["updated_by", user.id], ["updated_at", next.updatedAt]);
  // Audit first, only while the row is still the revision read, so a lost race writes neither.
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "link.update", targetType: "link", targetId: link.id,
      detail: { host: domain.host, slug: link.slug, url: next.url, ...(protection ? { protection } : {}), ...(b.routes !== undefined ? { routes: next.routes.length } : {}) } },
    { sql: "EXISTS (SELECT 1 FROM links WHERE id = ? AND updated_at = ?)", binds: [link.id, link.updatedAt] }),
    c.env.DB.prepare(`UPDATE links SET ${cols.map(([k]) => `${k}=?`).join(", ")} WHERE id=? AND updated_at=?`)
      .bind(...cols.map(([, v]) => v), link.id, link.updatedAt),
  ]);
  if (res[1]!.meta.changes === 0) {
    const gone = !(await c.env.DB.prepare("SELECT 1 FROM links WHERE id = ?").bind(link.id).first());
    return gone ? c.json({ error: "not_found" }, 404) : c.json({ error: "conflict" }, 409);
  }
  await purge(c.env, link.domainId, link.slugKey);
  return c.json(toApiLink(next));
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
    auditStmt(c.env, { ...actor(c), action: "link.delete", targetType: "link", targetId: link.id,
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
  // Audit first, in the same batch, from the rows the DELETE removes; HAVING skips it when no lock matches (lost race).
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail)
       SELECT ?, ?, NULL, 'lock.release', 'lock', ?, json_object('domainId', ?, 'slugKeys', json_group_array(slug_key))
       FROM slug_locks WHERE ${match} HAVING COUNT(*) > 0`,
    ).bind(Math.floor(Date.now() / 1000), user.id, `${domainId}/${key}`, domainId, domainId, key),
    c.env.DB.prepare(`DELETE FROM slug_locks WHERE ${match}`).bind(domainId, key),
  ]);
  if (res[1]!.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  await purge(c.env, domainId, key);
  return c.body(null, 204);
});
