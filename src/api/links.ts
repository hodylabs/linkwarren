import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { reservedSlugs } from "../dash";
import type { Env } from "../env";
import { hashPassword, iterationsOf } from "../password";
import { passwordRule } from "../password-rule";
import { parseSettings, settingsQ } from "../settings";
import { canUseDomain, usableDomains } from "../perm";
import { actorCan, can, type Guard } from "../roles";
import { actor, type Grant } from "../principal";
import { LINK_SELECT, ROUTE_DEVICES, rowToDomain, rowToLink, toApiLink, toListLink, type DomainRow, type LinkRow, type Route, type UserRow } from "../types";
import { checkLinkName, checkSlug, slugKey } from "../validate";
import { checkVcard, emptyVcard, PHONE_TYPES, PHOTO_B64_MAX, VCARD_MAX, VCARD_URL, vcardData, type VCard } from "../vcard";
import { bulk } from "./bulk";
import { allHosts, destination, domainQ, getDomain, hostsQ, isMember, memberQ, purge } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const links = new Hono<E>();

const PAGE = 50;
const forbidden = { error: "forbidden" } as const;

export const times = {
  startsAt: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
};
export const code = z.union([z.literal(301), z.literal(302)]);
const routeInput = z.strictObject({
  countries: z.array(z.string().max(1024)).max(50).optional(),
  devices: z.array(z.enum(ROUTE_DEVICES)).max(ROUTE_DEVICES.length).optional(),
  url: z.string().max(8192),
});
type RouteInput = z.infer<typeof routeInput>;
export const rules = {
  // A string sets, null clears, absent keeps. Length is checked by passwordRule (code points); 1024 units only caps the work
  // (a longer one is answered password_long, see bodyError).
  password: z.string().max(1024).nullable().optional(),
  // Replaces the whole list; [] clears it.
  routes: z.array(routeInput).max(10).optional(),
};
const text = (n: number) => z.string().max(n).default("");
/** S9 card fields: shape and every cap (the photo's before it is decoded); checkVcard (src/vcard.ts) does the rest. A field left out is empty. */
export const vcardSchema = z.strictObject({
  firstName: text(VCARD_MAX.firstName), lastName: text(VCARD_MAX.lastName), org: text(VCARD_MAX.org), title: text(VCARD_MAX.title),
  phones: z.array(z.strictObject({ type: z.enum(PHONE_TYPES).default("cell"), number: z.string().max(VCARD_MAX.phone) })).max(VCARD_MAX.rows).default([]),
  emails: z.array(z.string().max(VCARD_MAX.email)).max(VCARD_MAX.rows).default([]),
  websites: z.array(z.string().max(VCARD_MAX.website)).max(VCARD_MAX.rows).default([]),
  address: z.strictObject({
    street: text(VCARD_MAX.street), city: text(VCARD_MAX.city), region: text(VCARD_MAX.region),
    postalCode: text(VCARD_MAX.postalCode), country: text(VCARD_MAX.country),
  }).default(() => emptyVcard().address),
  note: text(VCARD_MAX.note),
  photo: z.string().max(PHOTO_B64_MAX).nullable().default(null),
});
const kind = { kind: z.enum(["url", "vcard"]).optional(), vcard: vcardSchema.optional() };
// S12: the optional name. The zod cap only bounds the work; checkLinkName (trim, 100 characters, no control characters) decides.
export const nameField = { name: z.string().max(1000).nullable().optional() };
const createBody = z.strictObject({
  // Caps well above the real limits (2048-char URLs, short slugs), so those keep their own error codes. url: required unless kind is vcard.
  domainId: z.string().min(1).max(64), slug: z.string().max(1024), url: z.string().max(8192).optional(),
  redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times, ...rules, ...kind, ...nameField,
});
const patchBody = z.strictObject({
  url: z.string().max(8192).optional(), redirectCode: code.optional(), passQuery: z.boolean().optional(), ...times, ...rules, ...kind, ...nameField,
});

/** A refused body: bad_vcard with the field when every problem is in the card, else bodyError's code. */
export function badBody(e: z.ZodError): { error: string; field?: string } {
  const p = e.issues[0]?.path ?? [];
  if (!e.issues.every((i) => i.path[0] === "vcard")) return { error: bodyError(e) };
  // phones.0.number -> phones.0, the same names checkVcard uses.
  return { error: "bad_vcard", field: p.slice(1).filter((x) => x !== "number" && x !== "type").join(".") || "vcard" };
}

/** The card checked, or the API error. */
export const cardOf = (v: z.output<typeof vcardSchema>): { vcard: VCard } | { error: "bad_vcard"; field: string } => {
  const r = checkVcard(v);
  return r.ok ? { vcard: r.vcard } : { error: "bad_vcard", field: r.field };
};

/** Countries two ASCII letters (raw, then upper-cased; never XX or T1, they never match), deduped; each url checked like the main destination. */
export async function validateRoutes(env: Env, input: RouteInput[], known?: string[]): Promise<{ routes: Route[] } | { error: "bad_route"; index: number; reason: string }> {
  const routes: Route[] = [];
  // One host read for every route of the request (none when the caller already read them).
  const hosts = input.length ? (known ?? await allHosts(env)) : [];
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
export async function passwordInput(env: Env, raw: string | null | undefined): Promise<{ hash: string | null | undefined } | { error: string }> {
  if (raw === undefined || raw === null) return { hash: raw };
  const p = passwordRule(raw);
  if (!p.ok) return { error: p.reason };
  return { hash: await hashPassword(p.value, iterationsOf(env)) };
}

/** invalid_body, or password_long when an over-long password is the only problem (zod caps it at 1024 units). */
export function bodyError(e: z.ZodError): string {
  return e.issues.every((i) => i.code === "too_big" && i.path.length === 1 && i.path[0] === "password") ? "password_long" : "invalid_body";
}

const lockQ = (env: Env, domainId: string, key: string) =>
  env.DB.prepare("SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?)").bind(domainId, key);
export const hasLock = async (env: Env, domainId: string, key: string) => !!(await lockQ(env, domainId, key).first());

export const badWindow = (s: number | null, x: number | null) => s !== null && x !== null && x <= s;

links.get("/check", async (c) => {
  const user = c.var.user;
  const domain = await getDomain(c.env, c.req.query("domain") ?? "");
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  const slug = c.req.query("slug") ?? "";
  const s = checkSlug(slug, [...domain.reservedExtra, ...reservedSlugs(c.env, domain.host)]);
  if (!s.ok) return c.json(s.reason === "reserved" ? { status: "reserved" } : { status: "invalid", reason: s.reason === "too_long" ? "slug_too_long" : s.reason });
  const key = slugKey(slug, domain.caseSensitive);
  if (await hasLock(c.env, domain.id, key)) return c.json({ status: "locked" });
  const taken = await c.env.DB.prepare("SELECT 1 FROM links WHERE domain_id = ? AND slug_key = ?").bind(domain.id, key).first();
  return c.json({ status: taken ? "taken" : "available" });
});

// R12 read routes, after /check (Hono matches in registration order) and by-slug before /:id.
links.get("/by-slug", async (c) => {
  const user = c.var.user;
  const domain = await getDomain(c.env, c.req.query("domain") ?? "");
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  const slug = c.req.query("slug") ?? "";
  if (!slug) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(`${LINK_SELECT} WHERE domain_id = ? AND slug_key = ?`).bind(domain.id, slugKey(slug, domain.caseSensitive)).first();
  return row ? c.json(toApiLink(rowToLink(row))) : c.json({ error: "not_found" }, 404);
});

links.get("/:id", async (c) => {
  const user = c.var.user;
  const row = await c.env.DB.prepare(`${LINK_SELECT} WHERE id = ?`).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  const link = rowToLink(row);
  const domain = await getDomain(c.env, link.domainId);
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  return c.json(toApiLink(link));
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
    // A card's url is one placeholder for every card: it matches by its name and organization instead. S12: the link's own name too.
    where.push(`(slug LIKE ? ESCAPE '\\' OR links.name LIKE ? ESCAPE '\\' OR (kind = 'url' AND url LIKE ? ESCAPE '\\')
      OR (kind = 'vcard' AND (coalesce(json_extract(vcards.data, '$.firstName'), '') || ' ' || coalesce(json_extract(vcards.data, '$.lastName'), '')
        || ' ' || coalesce(json_extract(vcards.data, '$.org'), '')) LIKE ? ESCAPE '\\'))`);
    binds.push(like, like, like, like);
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
    const head = cursor.slice(0, dot), at = Number(head), id = cursor.slice(dot + 1);
    // Digits only: Number() alone would take 1e3, -5, 0x10 or padded spaces.
    if (dot < 1 || !/^\d{1,15}$/.test(head) || !id) return c.json({ error: "bad_cursor" }, 400);
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(at, at, id);
  }
  const rows = (await c.env.DB.prepare(
    `${LINK_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`,
  ).bind(...binds).all()).results.map(rowToLink);
  const items = rows.slice(0, PAGE);
  return c.json({ items: items.map(toListLink), next: rows.length > PAGE ? `${items[items.length - 1]!.createdAt}.${items[items.length - 1]!.id}` : null });
});

// No POST /:id exists, so nothing shadows this.
links.post("/bulk", bulk);

links.post("/", async (c) => {
  const user = c.var.user;
  if (!can(user, "links.create")) return c.json(forbidden, 403);
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(badBody(body.error), 400);
  const b = body.data;
  // A vCard link needs its card and has no destination; any other link needs its url.
  const isCard = b.kind === "vcard";
  if (isCard !== (b.vcard !== undefined) || (!isCard && b.url === undefined)) return c.json({ error: "invalid_body" }, 400);
  const nm = checkLinkName(b.name ?? null);
  if (!nm.ok) return c.json({ error: "bad_link_name" }, 400);
  // Every pre-read in one batch, judged below in the old order. Slugs are ASCII, so lower(slug) = lower(slugKey(slug, *)).
  const [dr, mr, hr, lr, sr] = await c.env.DB.batch([
    domainQ(c.env, b.domainId), memberQ(c.env, b.domainId, user.id), hostsQ(c.env), lockQ(c.env, b.domainId, b.slug), settingsQ(c.env),
  ]);
  const domain = dr!.results[0] ? rowToDomain(dr!.results[0] as Record<string, unknown>) : null;
  if (!domain) return c.json({ error: "not_found" }, 404);
  if (!canUseDomain(user, domain, mr!.results.length > 0, c.var.grant.domains)) return c.json(forbidden, 403);
  const s = checkSlug(b.slug, [...domain.reservedExtra, ...reservedSlugs(c.env, domain.host)]);
  if (!s.ok) return c.json({ error: s.reason === "too_long" ? "slug_too_long" : s.reason }, 400);
  const hosts = (hr!.results as { host: string }[]).map((r) => r.host);
  if (isCard && b.url !== undefined) return c.json({ error: "vcard_url" }, 400);
  // S9: a contact card has no password or routing (refused); its redirect code and query rule are ignored (it never redirects).
  if (isCard && (b.password != null || b.routes?.length)) return c.json({ error: "vcard_rule" }, 400);
  const card = isCard ? cardOf(b.vcard!) : null;
  if (card && "error" in card) return c.json(card, 400);
  const dest = card ? { href: VCARD_URL } : await destination(c.env, b.url!, [], hosts);
  if ("error" in dest) return c.json({ error: dest.error }, 400);
  const startsAt = b.startsAt ?? null, expiresAt = b.expiresAt ?? null;
  if (badWindow(startsAt, expiresAt)) return c.json({ error: "bad_window" }, 400);
  // Instance defaults (read in the batch above) fill only what the request left out; a password link never defaults to 301.
  const d = parseSettings(sr!.results as { key: string; value: string }[]);
  const redirectCode = card ? 302 : b.redirectCode ?? (b.password != null ? 302 : d.linkRedirectCode);
  if (b.password != null && redirectCode === 301) return c.json({ error: "password_301" }, 400);
  const rt = await validateRoutes(c.env, b.routes ?? [], hosts);
  if ("error" in rt) return c.json(rt, 400);

  const key = slugKey(b.slug, domain.caseSensitive);
  if (lr!.results.length) return c.json({ error: "locked" }, 409);
  const pw = await passwordInput(c.env, b.password);
  if ("error" in pw) return c.json({ error: pw.error }, 400);
  const passwordHash = pw.hash ?? null;
  const now = Math.floor(Date.now() / 1000);
  const link: LinkRow = {
    id: crypto.randomUUID(), domainId: domain.id, slug: b.slug, slugKey: key, url: dest.href, name: nm.name,
    redirectCode, startsAt, expiresAt, passQuery: b.passQuery ?? d.linkPassQuery,
    passwordHash, routes: rt.routes, forwardTo: null, kind: card ? "vcard" : "url", ...(card ? { vcard: card.vcard } : {}),
    createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now,
  };
  const may = actorCan(user.id, "links.create");
  try {
    // The lock check and the permission are repeated inside the insert so a delete or a role edit racing this request cannot be bypassed.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO links (id,domain_id,slug,slug_key,url,name,redirect_code,starts_at,expires_at,pass_query,password_hash,routes,kind,created_by,updated_by,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?)) AND ${may.sql}`,
      ).bind(link.id, domain.id, link.slug, key, link.url, link.name, link.redirectCode, startsAt, expiresAt, link.passQuery ? 1 : 0,
        passwordHash, JSON.stringify(link.routes), link.kind, user.id, user.id, now, now, domain.id, key, ...may.binds),
      // The card only with its link (a fresh id, so it exists only if the insert above ran).
      ...(card ? [c.env.DB.prepare("INSERT INTO vcards (link_id, data, photo) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM links WHERE id = ?)")
        .bind(link.id, vcardData(card.vcard), card.vcard.photo, link.id)] : []),
      // Never the card's contents in the audit log: only that it is one.
      auditStmt(c.env, { ...actor(c), action: "link.create", targetType: "link", targetId: link.id,
        detail: { host: domain.host, slug: link.slug, url: link.url, ...(card ? { kind: "vcard" } : {}), ...(passwordHash ? { protection: "set" } : {}), ...(link.routes.length ? { routes: link.routes.length } : {}) } },
      { sql: "EXISTS (SELECT 1 FROM links WHERE id = ?)", binds: [link.id] }),
    ]);
    if (res[0]!.meta.changes === 0) return await stillCan(c.env, may) ? c.json({ error: "locked" }, 409) : c.json(forbidden, 403);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "taken" }, 409);
    throw e;
  }
  await purge(c.env, domain.id, key);
  return c.json(toApiLink(link), 201);
});

/** After a guarded write changed nothing: does the guard still hold (so the cause was something else)? */
const stillCan = async (env: Env, g: Guard) => !!(await env.DB.prepare(`SELECT ${g.sql} ok`).bind(...g.binds).first<{ ok: number }>())?.ok;

/**
 * Which R9 path lets `user` edit `link` (domain use aside): "none" needs no permission (an owner, the domain's owner), "own"
 * is the creator with links.create, "any" is links.editAny, null is no right at all. The write re-checks it (editGuard).
 */
export type EditRight = "none" | "own" | "any";
export function editRight(user: UserRow, link: LinkRow, domain: DomainRow): EditRight | null {
  if (user.role === "owner" || domain.ownerId === user.id) return "none";
  if (link.createdBy === user.id && can(user, "links.create")) return "own";
  return can(user, "links.editAny") ? "any" : null;
}

/** The edit rule (R9): domain use (narrowed by the grant's domains), and (owner, domain owner, creator with links.create, or links.editAny). Shared with the bulk route. */
export const canEditLink = (user: UserRow, link: LinkRow, domain: DomainRow, member: boolean, only: readonly string[] | null): boolean =>
  canUseDomain(user, domain, member, only) && editRight(user, link, domain) !== null;

/**
 * What a write's edit right is re-checked from (liveEdit): `c` 1 when the actor created the link, `d` the link's domain id
 * when the actor owned that domain at read time (else null: a domain-owner path gained in flight is not taken, fail closed).
 */
export type EditFacts = { c: 0 | 1; d: string | null };
export const editFacts = (user: UserRow, link: LinkRow, domain: DomainRow): EditFacts =>
  ({ c: link.createdBy === user.id ? 1 : 0, d: domain.ownerId === user.id ? domain.id : null });

/**
 * The R9 right as it stands at write time, from SQL expressions for the facts (`c`, `d`): the actor is an active owner, holds
 * links.editAny, created the link and holds links.create, or (active) still owns the domain. Never the right read earlier, so a
 * demotion or role edit in flight cannot keep a path it removed. The row-free checks come first: only a domain owner's rows
 * reach the per-row probe.
 */
export const liveEdit = (userId: string, c: string, d: string, dBinds: unknown[] = []): Guard => {
  const cr = actorCan(userId, "links.create"), a = actorCan(userId, "links.editAny");
  return {
    sql: `(EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = 'owner') OR ${a.sql} OR (${c} = 1 AND ${cr.sql})
      OR (${d} IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM domains WHERE id = ${d} AND owner_id = ?)))`,
    binds: [userId, ...a.binds, ...cr.binds, ...dBinds, userId, ...dBinds, userId],
  };
};

/** The SQL re-check of the edit rule for a single link's write batch (domain use is checked by the caller). */
export const editGuard = (user: UserRow, link: LinkRow, domain: DomainRow): Guard => {
  const f = editFacts(user, link, domain);
  return liveEdit(user.id, String(f.c), "?", [f.d]);
};

/** Loads a link and enforces edit rights (canEditLink); `withHosts` also reads the active hosts in the same batch. */
async function editable(c: { env: Env; var: { user: UserRow; grant: Grant } }, id: string, withHosts = false) {
  const user = c.var.user;
  // The link, its domain and the membership in one batch (the last two found through the link).
  const [lr, dr, mr, hr] = await c.env.DB.batch([
    c.env.DB.prepare(`${LINK_SELECT} WHERE id = ?`).bind(id),
    c.env.DB.prepare("SELECT d.* FROM links l JOIN domains d ON d.id = l.domain_id WHERE l.id = ?").bind(id),
    c.env.DB.prepare("SELECT 1 FROM links l JOIN domain_members m ON m.domain_id = l.domain_id WHERE l.id = ? AND m.user_id = ?").bind(id, user.id),
    ...(withHosts ? [hostsQ(c.env)] : []),
  ]);
  const hosts = hr ? (hr.results as { host: string }[]).map((r) => r.host) : undefined;
  const row = lr!.results[0] as Record<string, unknown> | undefined;
  if (!row) return { status: 404 as const };
  const link = rowToLink(row);
  const d = dr!.results[0] as Record<string, unknown> | undefined;
  if (!d) return { status: 404 as const };
  const domain = rowToDomain(d);
  return canEditLink(user, link, domain, mr!.results.length > 0, c.var.grant.domains) ? { link, domain, hosts } : { status: 403 as const };
}

links.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(badBody(body.error), 400);
  const b = body.data;
  const found = await editable(c, c.req.param("id"), b.url !== undefined || !!b.routes?.length);
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain, hosts } = found;
  const g = editGuard(user, link, domain);
  // A forwarder is never edited: it can only be deleted.
  if (link.forwardTo) return c.json({ error: "forwarder" }, 409);
  // S9: the kind is fixed at creation. A card's url never changes and it takes no password or routing; only a card takes `vcard`.
  const isCard = link.kind === "vcard";
  if (b.kind !== undefined && b.kind !== link.kind) return c.json({ error: "kind_change" }, 400);
  if (isCard && b.url !== undefined) return c.json({ error: "vcard_url" }, 400);
  if (isCard && (b.password != null || b.routes?.length)) return c.json({ error: "vcard_rule" }, 400);
  if (!isCard && b.vcard !== undefined) return c.json({ error: "not_vcard" }, 400);
  const card = b.vcard === undefined ? null : cardOf(b.vcard);
  if (card && "error" in card) return c.json(card, 400);
  const nm = b.name === undefined ? null : checkLinkName(b.name);
  if (nm && !nm.ok) return c.json({ error: "bad_link_name" }, 400);
  let url = link.url;
  if (b.url !== undefined) {
    const dest = await destination(c.env, b.url, [], hosts);
    if ("error" in dest) return c.json({ error: dest.error }, 400);
    url = dest.href;
  }
  let routes = link.routes;
  if (b.routes !== undefined) {
    const rt = await validateRoutes(c.env, b.routes, hosts);
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
    ...link, url, name: nm?.ok ? nm.name : link.name, redirectCode: b.redirectCode ?? link.redirectCode, passQuery: b.passQuery ?? link.passQuery,
    passwordHash: pw.hash === undefined ? link.passwordHash : pw.hash, routes, ...(card ? { vcard: card.vcard } : {}),
    startsAt: b.startsAt === undefined ? link.startsAt : b.startsAt,
    expiresAt: b.expiresAt === undefined ? link.expiresAt : b.expiresAt,
    // updated_at is the revision: always move it forward, even within the same second.
    updatedBy: user.id, updatedAt: Math.max(Math.floor(Date.now() / 1000), link.updatedAt + 1),
  };
  const cols: [string, unknown][] = [];
  if (b.url !== undefined) cols.push(["url", next.url]);
  if (b.name !== undefined) cols.push(["name", next.name]);
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
  const same = { sql: `EXISTS (SELECT 1 FROM links WHERE id = ? AND updated_at = ?) AND ${g.sql}`, binds: [link.id, link.updatedAt, ...g.binds] };
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "link.update", targetType: "link", targetId: link.id,
      detail: { host: domain.host, slug: link.slug, url: next.url, ...(isCard ? { kind: "vcard" } : {}), ...(protection ? { protection } : {}), ...(b.routes !== undefined ? { routes: next.routes.length } : {}) } },
    same),
    // The card under the same guard as the audit, before the row's revision moves (an upsert: a missing card row is rewritten).
    ...(card ? [c.env.DB.prepare(`INSERT INTO vcards (link_id, data, photo) SELECT ?,?,? WHERE ${same.sql}
      ON CONFLICT(link_id) DO UPDATE SET data = excluded.data, photo = excluded.photo`).bind(link.id, vcardData(card.vcard), card.vcard.photo, ...same.binds)] : []),
    c.env.DB.prepare(`UPDATE links SET ${cols.map(([k]) => `${k}=?`).join(", ")} WHERE id=? AND updated_at=? AND ${g.sql}`)
      .bind(...cols.map(([, v]) => v), link.id, link.updatedAt, ...g.binds),
  ]);
  if (res[res.length - 1]!.meta.changes === 0) return lost(c, link.id, g);
  await purge(c.env, link.domainId, link.slugKey);
  return c.json(toApiLink(next));
});

/**
 * Deleting a link deletes every forwarder aimed at it and locks their slugs, so a printed QR code for an old
 * address never lands on an unrelated link. `parents`: JSON array of `{ t: link id, ... }`; `guard` reads
 * `j.value` (its binds come last) and must hold only while that link is still there to delete and the actor may delete it. Lock, audit (one row per forwarder) and delete, in that
 * order, before the parent's own DELETE in the same batch; the DELETE returns the cache keys to purge. Index probes only
 * (links_forward_to).
 */
export function forwarderDeletes(env: Env, who: { actorId: string; via: string | null }, now: number, parents: string, g: Guard): D1PreparedStatement[] {
  const guard = g.sql;
  const of = `FROM json_each(?) j JOIN links f ON f.forward_to = json_extract(j.value,'$.t')`;
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT f.domain_id, f.slug_key, ?, ? ${of} WHERE ${guard}`)
      .bind(now, who.actorId, parents, ...g.binds),
    env.DB.prepare(
      `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail)
       SELECT ?, ?, ?, 'link.delete', 'link', f.id, json_object('host', d.host, 'slug', f.slug, 'url', f.url, 'forwarderOf', f.forward_to)
       ${of} JOIN domains d ON d.id = f.domain_id WHERE ${guard}`,
    ).bind(now, who.actorId, who.via, parents, ...g.binds),
    env.DB.prepare(`DELETE FROM links WHERE forward_to IN (SELECT json_extract(j.value,'$.t') FROM json_each(?) j WHERE ${guard}) RETURNING domain_id, slug_key`)
      .bind(parents, ...g.binds),
  ];
}

/** A guarded PATCH or DELETE that changed nothing: the link is gone (404), the permission is (403), or it changed (409). */
async function lost(c: Context<E>, id: string, g: Guard) {
  const r = await c.env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM links WHERE id = ?) still, ${g.sql} ok`).bind(id, ...g.binds).first<{ still: number; ok: number }>();
  return !r?.still ? c.json({ error: "not_found" }, 404) : !r.ok ? c.json(forbidden, 403) : c.json({ error: "conflict" }, 409);
}

/** Purges the cache keys a forwarderDeletes DELETE returned. */
export const purgeReturned = (env: Env, r: D1Result) =>
  Promise.all(r.results.map((x) => purge(env, (x as { domain_id: string }).domain_id, (x as { slug_key: string }).slug_key)));

links.delete("/:id", async (c) => {
  const user = c.var.user;
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  const g = editGuard(user, link, domain);
  // Every write runs only while the link is still the revision read (same address, same updated_at): a racing second delete or
  // a move in between writes nothing, so a moved link's new address is never left unlocked.
  const rev = "id = ? AND domain_id = ? AND slug_key = ? AND updated_at = ?", revBinds = [link.id, link.domainId, link.slugKey, link.updatedAt];
  const here = { sql: `EXISTS (SELECT 1 FROM links WHERE ${rev}) AND ${g.sql}`, binds: [...revBinds, ...g.binds] };
  const now = Math.floor(Date.now() / 1000);
  const parent = JSON.stringify([{ t: link.id, d: link.domainId, s: link.slugKey, u: link.updatedAt }]);
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT ?,?,?,? WHERE ${here.sql}`)
      .bind(link.domainId, link.slugKey, now, user.id, ...here.binds),
    auditStmt(c.env, { ...actor(c), action: "link.delete", targetType: "link", targetId: link.id,
      detail: { host: domain.host, slug: link.slug, url: link.url } }, here),
    ...forwarderDeletes(c.env, actor(c), now, parent, {
      sql: `EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND domain_id = json_extract(j.value,'$.d') AND slug_key = json_extract(j.value,'$.s') AND updated_at = json_extract(j.value,'$.u')) AND ${g.sql}`,
      binds: g.binds,
    }),
    c.env.DB.prepare(`DELETE FROM links WHERE ${rev} AND ${g.sql}`).bind(...revBinds, ...g.binds),
  ]);
  if (res[5]!.meta.changes === 0) return lost(c, link.id, g);
  await Promise.all([purge(c.env, link.domainId, link.slugKey), purgeReturned(c.env, res[4]!)]);
  return c.body(null, 204);
});

/** S13 QR print labels: at most this many per link. */
export const QR_LABELS_MAX = 20;
const labelBody = z.strictObject({ label: z.string().max(1000) });
const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A print code: 6 random characters from [a-z0-9], unbiased (bytes 252 and up are drawn again). */
export function labelCode(): string {
  let s = "";
  while (s.length < 6) for (const b of crypto.getRandomValues(new Uint8Array(8))) if (b < 252 && s.length < 6) s += CODE_CHARS[b % 36];
  return s;
}
/** The link-name rule (trimmed, 100 characters, no control characters), and never empty. */
const labelOf = (raw: string): string | null => {
  const r = checkLinkName(raw);
  return r.ok ? r.name : null;
};
type LabelRow = { id: string; code: string; label: string; created_at: number };
const labelItem = (r: LabelRow) => ({ id: r.id, code: r.code, label: r.label, createdAt: r.created_at });
const labelQ = (env: Env, linkId: string, id: string) =>
  env.DB.prepare("SELECT id, code, label, created_at FROM qr_labels WHERE id = ? AND link_id = ?").bind(id, linkId).first<LabelRow>();

// Every label route needs the right to edit the link (editable), and every write re-checks it in SQL (editGuard).
links.get("/:id/qr-labels", async (c) => {
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const rows = await c.env.DB.prepare("SELECT id, code, label, created_at FROM qr_labels WHERE link_id = ? ORDER BY created_at, id").bind(found.link.id).all<LabelRow>();
  return c.json({ items: rows.results.map(labelItem) });
});

links.post("/:id/qr-labels", async (c) => {
  const body = labelBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const label = labelOf(body.data.label);
  if (!label) return c.json({ error: "bad_label" }, 400);
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  if (link.forwardTo) return c.json({ error: "forwarder" }, 409);
  const g = editGuard(c.var.user, link, domain);
  const now = Math.floor(Date.now() / 1000);
  // A code already on this link is drawn again (36^6 codes, at most 20 per link: practically never twice).
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = crypto.randomUUID(), code = labelCode();
    // The cap, the code's uniqueness and the edit right are all checked in the same statement as the write.
    const may = {
      sql: `EXISTS (SELECT 1 FROM links WHERE id = ?) AND (SELECT COUNT(*) FROM qr_labels WHERE link_id = ?) < ${QR_LABELS_MAX}
        AND NOT EXISTS (SELECT 1 FROM qr_labels WHERE link_id = ? AND code = ?) AND ${g.sql}`,
      binds: [link.id, link.id, link.id, code, ...g.binds],
    };
    const res = await c.env.DB.batch([
      auditStmt(c.env, { ...actor(c), action: "qr_label.create", targetType: "link", targetId: link.id, detail: { host: domain.host, slug: link.slug, code, label } }, may),
      c.env.DB.prepare(`INSERT INTO qr_labels (id, link_id, code, label, created_at, created_by) SELECT ?,?,?,?,?,? WHERE ${may.sql}`)
        .bind(id, link.id, code, label, now, c.var.user.id, ...may.binds),
    ]);
    if (res[1]!.meta.changes) return c.json(labelItem({ id, code, label, created_at: now }), 201);
    const st = await c.env.DB.prepare("SELECT COUNT(*) AS n, EXISTS (SELECT 1 FROM qr_labels WHERE link_id = ?1 AND code = ?2) AS dup FROM qr_labels WHERE link_id = ?1")
      .bind(link.id, code).first<{ n: number; dup: number }>();
    if (st?.dup) continue;
    if ((st?.n ?? 0) >= QR_LABELS_MAX) return c.json({ error: "too_many_labels" }, 409);
    return lost(c, link.id, g);
  }
  return c.json({ error: "conflict" }, 409);
});

links.patch("/:id/qr-labels/:labelId", async (c) => {
  const body = labelBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const label = labelOf(body.data.label);
  if (!label) return c.json({ error: "bad_label" }, 400);
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  const row = await labelQ(c.env, link.id, c.req.param("labelId"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const g = editGuard(c.var.user, link, domain);
  const may = { sql: `EXISTS (SELECT 1 FROM qr_labels WHERE id = ? AND link_id = ?) AND ${g.sql}`, binds: [row.id, link.id, ...g.binds] };
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "qr_label.rename", targetType: "link", targetId: link.id, detail: { host: domain.host, slug: link.slug, code: row.code, label, from: row.label } }, may),
    c.env.DB.prepare(`UPDATE qr_labels SET label = ? WHERE id = ? AND link_id = ? AND ${g.sql}`).bind(label, row.id, link.id, ...g.binds),
  ]);
  if (!res[1]!.meta.changes) return (await labelQ(c.env, link.id, row.id)) ? lost(c, link.id, g) : c.json({ error: "not_found" }, 404);
  return c.json(labelItem({ ...row, label }));
});

links.delete("/:id/qr-labels/:labelId", async (c) => {
  const found = await editable(c, c.req.param("id"));
  if ("status" in found) return c.json({ error: found.status === 404 ? "not_found" : "forbidden" }, found.status);
  const { link, domain } = found;
  const row = await labelQ(c.env, link.id, c.req.param("labelId"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const g = editGuard(c.var.user, link, domain);
  const may = { sql: `EXISTS (SELECT 1 FROM qr_labels WHERE id = ? AND link_id = ?) AND ${g.sql}`, binds: [row.id, link.id, ...g.binds] };
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "qr_label.delete", targetType: "link", targetId: link.id, detail: { host: domain.host, slug: link.slug, code: row.code, label: row.label } }, may),
    c.env.DB.prepare(`DELETE FROM qr_labels WHERE id = ? AND link_id = ? AND ${g.sql}`).bind(row.id, link.id, ...g.binds),
  ]);
  if (!res[1]!.meta.changes) return (await labelQ(c.env, link.id, row.id)) ? lost(c, link.id, g) : c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

export const locks = new Hono<E>();

locks.delete("/:domainId/:slugKey", async (c) => {
  const user = c.var.user;
  if (!can(user, "links.editAny")) return c.json(forbidden, 403);
  const { domainId, slugKey: raw } = c.req.param();
  const domain = await getDomain(c.env, domainId);
  // Unknown and unusable answer alike, so a domain id is never confirmed to someone who cannot use it.
  if (!domain || !canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return c.json(forbidden, 403);
  const key = slugKey(raw, domain.caseSensitive);
  const g = actorCan(user.id, "links.editAny");
  const match = `domain_id = ? AND lower(slug_key) = lower(?) AND ${g.sql}`;
  // Audit first, in the same batch, from the rows the DELETE removes; HAVING skips it when no lock matches (lost race).
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail)
       SELECT ?, ?, NULL, 'lock.release', 'lock', ?, json_object('domainId', ?, 'slugKeys', json_group_array(slug_key))
       FROM slug_locks WHERE ${match} HAVING COUNT(*) > 0`,
    ).bind(Math.floor(Date.now() / 1000), user.id, `${domainId}/${key}`, domainId, domainId, key, ...g.binds),
    c.env.DB.prepare(`DELETE FROM slug_locks WHERE ${match}`).bind(domainId, key, ...g.binds),
  ]);
  if (res[1]!.meta.changes === 0) return await stillCan(c.env, g) ? c.json({ error: "not_found" }, 404) : c.json(forbidden, 403);
  await purge(c.env, domainId, key);
  return c.body(null, 204);
});
