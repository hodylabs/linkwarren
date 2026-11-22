import type { Context } from "hono";
import { z } from "zod";
import { auditManyStmt } from "../audit";
import type { Env } from "../env";
import { fits, hitBy, LIMITS, limitKey } from "../limits";
import { passwordRule } from "../password-rule";
import { actor, type Grant } from "../principal";
import { rowToDomain, rowToLink, toApiLink, type ApiLink, type DomainRow, type LinkRow, type UserRow } from "../types";
import { canUseDomain } from "../perm";
import { checkSlug, slugKey } from "../validate";
import { badWindow, bodyError, canEditLink, code, passwordInput, rules, times } from "./links";
import { purge } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };

/** Distinct link ids per request (R2). */
export const BULK_MAX = 100;
/** Links whose password is set per request: one PBKDF2 run already fills the Free plan's 10 ms CPU (R6). */
export const PASSWORD_PER_REQUEST = 1;

export type BulkResult = { id: string; ok: true; link?: ApiLink } | { id: string; ok: false; error: string };

// Built on first use: links.ts imports this module, so its schemas are not initialized yet while this one loads.
let schema: ReturnType<typeof makeSchema> | undefined;
function makeSchema() {
  const ids = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(200);
  return z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("delete"), ids }),
    z.strictObject({ action: z.literal("schedule"), ids, ...times, endNow: z.literal(true).optional() }),
    z.strictObject({ action: z.literal("redirect"), ids, redirectCode: code.optional(), passQuery: z.boolean().optional() }),
    z.strictObject({ action: z.literal("password"), ids, password: rules.password.unwrap() }),
    // R5: what happens to the old address is always the caller's choice; there is no default.
    z.strictObject({ action: z.literal("move"), ids, domainId: z.string().min(1).max(64), oldAddress: z.enum(["forward", "copy"]) }),
  ]);
}
type Body = z.infer<ReturnType<typeof makeSchema>>;

/** The per-link refusal of the action, checked on the merged next state exactly as PATCH checks it. */
function refusal(b: Body, link: LinkRow, now: number): string | null {
  if (b.action === "schedule") {
    const s = b.startsAt === undefined ? link.startsAt : b.startsAt;
    const x = b.endNow ? now : b.expiresAt === undefined ? link.expiresAt : b.expiresAt;
    return badWindow(s, x) ? "bad_window" : null;
  }
  if (b.action === "redirect") return link.passwordHash !== null && (b.redirectCode ?? link.redirectCode) === 301 ? "password_301" : null;
  if (b.action === "password") return b.password !== null && link.redirectCode === 301 ? "password_301" : null;
  return null;
}

/** Revision guard for INSERT ... SELECT over json_each: looks the link up by id (index search, never a scan of links). */
const REV = "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND updated_at = json_extract(j.value,'$.r'))";
/** A move happened: link `t` now sits on the target (bind: target id) at key `k`. Guards every statement after the move (D3). */
const MOVED = "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND domain_id = ? AND slug_key = json_extract(j.value,'$.k'))";
/** No lock on the target (bind: target id) for key `k`, through the slug_locks_lower index. */
const UNLOCKED = "NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(json_extract(j.value,'$.k')))";
/** No link on the target (bind: target id) holds key `k`. */
const FREE = "NOT EXISTS (SELECT 1 FROM links o WHERE o.domain_id = ? AND o.slug_key = json_extract(j.value,'$.k'))";

/** POST /api/links/bulk: every link decided with the single-edit rules, all accepted ones written in one D1 batch. */
export async function bulk(c: Context<E>) {
  const parsed = (schema ??= makeSchema()).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: bodyError(parsed.error) }, 400);
  const b = parsed.data;
  // Defense in depth: the /api/v1 scope gate checks only the HTTP method, and every bulk action is a POST.
  const g = c.var.grant;
  if (b.action === "delete" && !(g.write && g.del)) return c.json({ error: "delete_not_allowed" }, 403);
  if (!g.write) return c.json({ error: "read_only" }, 403);
  const invalid = () => c.json({ error: "invalid_body" }, 400);
  if (b.action === "schedule" && (b.endNow ? b.expiresAt !== undefined : b.startsAt === undefined && b.expiresAt === undefined)) return invalid();
  if (b.action === "redirect" && b.redirectCode === undefined && b.passQuery === undefined) return invalid();
  const order = [...new Set(b.ids)];
  if (order.length > BULK_MAX) return c.json({ error: "too_many" }, 400);
  // Once per request, before anything is read (R6).
  if (b.action === "password" && b.password !== null) {
    const p = passwordRule(b.password);
    if (!p.ok) return c.json({ error: p.reason }, 400);
  }

  const { env } = c, user = c.var.user, now = Math.floor(Date.now() / 1000);
  const ids = JSON.stringify(order);
  // Driven from json_each with a by-id lookup: rows read stay O(selected), never a scan of links.
  const lr = await env.DB.batch<Record<string, unknown>>([env.DB.prepare("SELECT l.* FROM json_each(?) j JOIN links l ON l.id = j.value").bind(ids)]);
  const found = new Map(lr[0]!.results.map((r) => { const l = rowToLink(r); return [l.id, l]; }));
  const dIds = JSON.stringify([...new Set([...found.values()].map((l) => l.domainId).concat(b.action === "move" ? [b.domainId] : []))]);
  const [dr, mr] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT d.* FROM json_each(?) j JOIN domains d ON d.id = j.value").bind(dIds),
    env.DB.prepare("SELECT m.domain_id FROM json_each(?) j JOIN domain_members m ON m.domain_id = j.value AND m.user_id = ?").bind(dIds, user.id),
  ]);
  const domains = new Map(dr!.results.map((r) => { const d = rowToDomain(r); return [d.id, d]; }));
  const member = new Set(mr!.results.map((r) => r.domain_id as string));
  // R5 whole-request checks on the one target: usable (narrowed by the grant), then active (D12).
  const target = b.action === "move" ? domains.get(b.domainId) : undefined;
  if (b.action === "move") {
    if (!target) return c.json({ error: "not_found" }, 404);
    if (!canUseDomain(user, target, member.has(target.id), g.domains)) return c.json({ error: "forbidden" }, 403);
    if (target.status !== "active") return c.json({ error: "target_not_active" }, 400);
  }

  const out = new Map<string, BulkResult>();
  const accepted: { link: LinkRow; domain: DomainRow; k: string }[] = [];
  const pending: string[] = [];
  for (const id of order) {
    const link = found.get(id), domain = link && domains.get(link.domainId);
    if (!link || !domain) { out.set(id, { id, ok: false, error: "not_found" }); continue; }
    if (!canEditLink(user, link, domain, member.has(domain.id), c.var.grant.domains)) { out.set(id, { id, ok: false, error: "forbidden" }); continue; }
    // A forwarder is never edited or moved, only deleted (R5).
    const error = b.action !== "delete" && link.forwardTo ? "forwarder" : refusal(b, link, now);
    if (error) { out.set(id, { id, ok: false, error }); continue; }
    if (b.action === "password" && b.password !== null && accepted.length >= PASSWORD_PER_REQUEST) { pending.push(id); continue; }
    let k = link.slugKey;
    if (target) {
      if (link.domainId === target.id) { out.set(id, { id, ok: false, error: "same_domain" }); continue; }
      const s = checkSlug(link.slug, target.reservedExtra);
      if (!s.ok) { out.set(id, { id, ok: false, error: s.reason === "too_long" ? "slug_too_long" : s.reason }); continue; }
      k = slugKey(link.slug, target.caseSensitive);
    }
    accepted.push({ link, domain, k });
  }
  // Move: per accepted link, a lock on its new key, who holds that key, and how many forwarders point at it (a forward move
  // repoints them). One statement driven from json_each, index probes only (slug_locks_lower, the links unique key, links_forward_to).
  const older = new Map<string, number>();
  const reclaim = new Set<string>();
  if (target && accepted.length) {
    const forward = b.action === "move" && b.oldAddress === "forward";
    const kr = (await env.DB.batch<Record<string, unknown>>([env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(json_extract(j.value,'$.k'))) locked,
       (SELECT coalesce(forward_to, '') FROM links WHERE domain_id = ? AND slug_key = json_extract(j.value,'$.k')) holder,
       (SELECT count(*) FROM links WHERE forward_to = json_extract(j.value,'$.t')) fwd FROM json_each(?) j ORDER BY j.key`,
    ).bind(target.id, target.id, JSON.stringify(accepted.map((a) => ({ t: a.link.id, k: a.k }))))]))[0]!.results;
    const seen = new Set<string>();
    const keep = accepted.splice(0).filter(({ link, k }, i) => {
      // holder: NULL free, '' held by a link, otherwise held by a forwarder of that link id.
      const r = kr[i]!, holder = r.holder as string | null;
      // forward reclaims an address held by this link's own forwarder (a move back), so no cycle and no lock.
      const mine = forward && holder === link.id;
      const error = r.locked === 1 ? "locked" : holder !== null && !mine ? "taken" : seen.has(k) ? "duplicate_slug" : null;
      if (error) { out.set(link.id, { id: link.id, ok: false, error }); return false; }
      seen.add(k);
      if (mine) reclaim.add(link.id);
      // The reclaimed forwarder is deleted, not repointed.
      const n = (r.fwd as number) - (mine ? 1 : 0);
      if (forward && n > 0) older.set(link.id, n);
      return true;
    });
    accepted.push(...keep);
  }

  const results = () => order.flatMap((id) => out.get(id) ?? []);
  if (!accepted.length) return c.json({ results: results(), pending });

  // R4: one KV delete per written link (a forward move: old and new key plus each forwarder it repoints), checked read-only
  // first so a refused request writes nothing.
  const cost = b.action === "move" && b.oldAddress === "forward" ? 2 * accepted.length + [...older.values()].reduce((a, n) => a + n, 0) : accepted.length;
  if (!(await fits(env, limitKey.bulkKv, LIMITS.bulkKvDay, cost))) return c.json({ error: "kv_budget" }, 429);
  // One hash per link, each with its own salt (hashPassword draws one per call); null clears, undefined does not occur here.
  const hashes = b.action === "password"
    ? await Promise.all(accepted.map(async () => {
      const pw = await passwordInput(env, b.password);
      if ("error" in pw) throw new Error(pw.error); // validated above
      return pw.hash ?? null;
    }))
    : [];
  await hitBy(env, limitKey.bulkKv, LIMITS.bulkKvDay, cost);

  const base = { ...actor(c), targetType: "link" };
  const rows = accepted.map(({ link }, i) => ({ t: link.id, r: link.updatedAt, h: hashes[i] ?? null }));
  const json = JSON.stringify(rows);
  let stmts: D1PreparedStatement[];
  // The statement whose RETURNING lists the links written; for a copy it returns the new ids (`n` maps them back).
  let main: D1PreparedStatement;
  let repointed: D1PreparedStatement | undefined;
  const newIds = new Map<string, string>();
  if (b.action === "move" && target) {
    const t = target.id;
    if (b.oldAddress === "forward") {
      const rows = accepted.map(({ link, k }) => ({
        t: link.id, r: link.updatedAt, k, f: crypto.randomUUID(), om: link.domainId, ok: link.slugKey, s: link.slug,
        // Built by the server from the target host and an already-valid slug; it bypasses destination(), which would call it a loop.
        u: `https://${target.host}/${link.slug}`,
      }));
      const json = JSON.stringify(rows);
      const back = JSON.stringify(rows.filter((x) => reclaim.has(x.t)));
      // Only links that had forwarders when read: a new forwarder of a link needs a move of it, which changes its revision.
      const repoint = JSON.stringify(rows.filter((x) => older.has(x.t)));
      main = env.DB.prepare(
        `UPDATE links SET domain_id = ?, slug_key = json_extract(j.value,'$.k'), updated_by = ?, updated_at = max(?, links.updated_at + 1)
         FROM json_each(?) j WHERE links.id = json_extract(j.value,'$.t') AND links.updated_at = json_extract(j.value,'$.r')
         AND ${UNLOCKED} AND ${FREE} RETURNING links.id`,
      ).bind(t, user.id, now, json, t, t);
      stmts = [
        ...(reclaim.size ? [env.DB.prepare(
          `DELETE FROM links WHERE (forward_to, domain_id, slug_key) IN (SELECT json_extract(value,'$.t'), ?, json_extract(value,'$.k') FROM json_each(?))
           AND forward_to IN (SELECT id FROM links WHERE (id, updated_at) IN (SELECT json_extract(value,'$.t'), json_extract(value,'$.r') FROM json_each(?)))
           AND NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(links.slug_key))`,
        ).bind(t, back, back, t)] : []),
        main,
        env.DB.prepare(
          `INSERT INTO links (id, domain_id, slug, slug_key, url, redirect_code, starts_at, expires_at, pass_query, password_hash, routes, forward_to, created_by, updated_by, created_at, updated_at)
           SELECT json_extract(j.value,'$.f'), json_extract(j.value,'$.om'), json_extract(j.value,'$.s'), json_extract(j.value,'$.ok'), json_extract(j.value,'$.u'),
             302, NULL, NULL, 1, NULL, '[]', json_extract(j.value,'$.t'), ?, ?, ?, ? FROM json_each(?) j WHERE ${MOVED}`,
        ).bind(user.id, user.id, now, now, json, t),
        // One hop: every older forwarder of a moved link now points at its new address.
        ...(older.size ? [repointed = env.DB.prepare(
          `UPDATE links SET url = json_extract(j.value,'$.u'), updated_at = max(?, links.updated_at + 1) FROM json_each(?) j
           WHERE links.forward_to = json_extract(j.value,'$.t') AND links.id != json_extract(j.value,'$.f') AND ${MOVED} RETURNING links.domain_id, links.slug_key`,
        ).bind(now, repoint, t)] : []),
        auditManyStmt(env, { ...base, action: "link.move" }, accepted.map(({ link, domain, k }, i) => ({
          targetId: link.id, k,
          detail: { fromHost: domain.host, toHost: target.host, slug: link.slug, url: link.url, oldAddress: "forward", forwarderId: rows[i]!.f },
        })), { sql: MOVED, binds: [t] }),
      ];
    } else {
      const rows = accepted.map(({ link, k }) => { const n = crypto.randomUUID(); newIds.set(n, link.id); return { t: link.id, r: link.updatedAt, k, n }; });
      main = env.DB.prepare(
        `INSERT INTO links (id, domain_id, slug, slug_key, url, redirect_code, starts_at, expires_at, pass_query, password_hash, routes, forward_to, created_by, updated_by, created_at, updated_at)
         SELECT json_extract(j.value,'$.n'), ?, s.slug, json_extract(j.value,'$.k'), s.url, s.redirect_code, s.starts_at, s.expires_at, s.pass_query, s.password_hash, s.routes,
           NULL, ?, ?, ?, ? FROM json_each(?) j JOIN links s ON s.id = json_extract(j.value,'$.t')
         WHERE s.updated_at = json_extract(j.value,'$.r') AND ${UNLOCKED} AND ${FREE} RETURNING id`,
      ).bind(t, user.id, user.id, now, now, JSON.stringify(rows), t, t);
      stmts = [
        main,
        // Same detail as a single create, plus the source; the copied hash is never in it (protection only).
        auditManyStmt(env, { ...base, action: "link.create" }, accepted.map(({ link }, i) => ({
          targetId: rows[i]!.n,
          detail: { host: target.host, slug: link.slug, url: link.url, ...(link.passwordHash ? { protection: "set" } : {}), ...(link.routes.length ? { routes: link.routes.length } : {}), copiedFrom: link.id },
        })), { sql: "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t'))", binds: [] }),
      ];
    }
  } else if (b.action === "delete") {
    stmts = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO slug_locks (domain_id, slug_key, locked_at, locked_by)
         SELECT json_extract(j.value,'$.m'), json_extract(j.value,'$.k'), ?, ? FROM json_each(?) j WHERE ${REV}`,
      ).bind(now, user.id, JSON.stringify(accepted.map(({ link }) => ({ t: link.id, r: link.updatedAt, m: link.domainId, k: link.slugKey })))),
      auditManyStmt(env, { ...base, action: "link.delete" },
        accepted.map(({ link, domain }) => ({ targetId: link.id, r: link.updatedAt, detail: { host: domain.host, slug: link.slug, url: link.url } })),
        { sql: REV, binds: [] }),
      main = env.DB.prepare("DELETE FROM links WHERE (id, updated_at) IN (SELECT json_extract(value,'$.t'), json_extract(value,'$.r') FROM json_each(?)) RETURNING id").bind(json),
    ];
  } else {
    const set: string[] = [], binds: unknown[] = [];
    const col = (sql: string, ...v: unknown[]) => { set.push(sql); binds.push(...v); };
    if (b.action === "schedule") {
      if (b.startsAt !== undefined) col("starts_at = ?", b.startsAt);
      if (b.endNow) col("expires_at = ?", now);
      else if (b.expiresAt !== undefined) col("expires_at = ?", b.expiresAt);
    } else if (b.action === "redirect") {
      if (b.redirectCode !== undefined) col("redirect_code = ?", b.redirectCode);
      if (b.passQuery !== undefined) col("pass_query = ?", b.passQuery ? 1 : 0);
    } else {
      col("password_hash = json_extract(j.value,'$.h')");
    }
    // R13: protection only when it changed, never the password or its hash.
    const protection = (link: LinkRow) =>
      b.action !== "password" ? undefined : b.password !== null ? "set" : link.passwordHash !== null ? "cleared" : undefined;
    stmts = [
      // Audit first, only while the row is still the revision read, so a lost race writes neither (as PATCH).
      auditManyStmt(env, { ...base, action: "link.update" }, accepted.map(({ link, domain }) => {
        const p = protection(link);
        return { targetId: link.id, r: link.updatedAt, detail: { host: domain.host, slug: link.slug, url: link.url, ...(p ? { protection: p } : {}), bulk: b.action } };
      }), { sql: REV, binds: [] }),
      // updated_at is the revision: always moves forward, even within the same second.
      main = env.DB.prepare(
        `UPDATE links SET ${set.join(", ")}, updated_by = ?, updated_at = max(?, links.updated_at + 1)
         FROM json_each(?) j WHERE links.id = json_extract(j.value,'$.t') AND links.updated_at = json_extract(j.value,'$.r') RETURNING links.id`,
      ).bind(...binds, user.id, now, json),
    ];
  }
  let res: D1Result[];
  try {
    res = await env.DB.batch(stmts);
  } catch (e) {
    // Backstop only (no guarded statement here can collide): the batch rolled back, nothing was written.
    if (String(e).includes("UNIQUE")) return c.json({ error: "conflict" }, 409);
    throw e;
  }
  const returned = res[stmts.indexOf(main)]!.results.map((r) => (r as { id: string }).id);
  const applied = new Set(newIds.size ? returned.map((n) => newIds.get(n)!) : returned);
  const done = accepted.filter(({ link }) => applied.has(link.id));
  const keys: [string, string][] = b.action !== "move" ? done.map(({ link }) => [link.domainId, link.slugKey])
    : done.map(({ k }): [string, string] => [target!.id, k]).concat(
      b.oldAddress === "forward" ? done.map(({ link }): [string, string] => [link.domainId, link.slugKey]) : [],
      repointed ? res[stmts.indexOf(repointed)]!.results.map((r) => [(r as { domain_id: string }).domain_id, (r as { slug_key: string }).slug_key]) : [],
    );
  await Promise.all(keys.map(([d, k]) => purge(env, d, k)));
  // Keyed by the selected id: a copy answers with the new link (the source is unchanged).
  const fresh = new Map<string, LinkRow>();
  if (b.action !== "delete" && done.length) {
    const want = newIds.size ? returned : done.map(({ link }) => link.id);
    const rr = await env.DB.prepare("SELECT * FROM links WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(want)).all();
    for (const r of rr.results) { const l = rowToLink(r); fresh.set(newIds.get(l.id) ?? l.id, l); }
  }
  for (const { link } of accepted) {
    const f = fresh.get(link.id);
    out.set(link.id, applied.has(link.id) ? { id: link.id, ok: true, ...(f ? { link: toApiLink(f) } : {}) } : { id: link.id, ok: false, error: "conflict" });
  }
  return c.json({ results: results(), pending });
}
