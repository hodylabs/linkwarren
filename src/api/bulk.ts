import type { Context } from "hono";
import { z } from "zod";
import { auditManyStmt } from "../audit";
import type { Env } from "../env";
import { hitAll, LIMITS, limitKey, type Check } from "../limits";
import { passwordRule } from "../password-rule";
import { actor, type Grant } from "../principal";
import { rowToDomain, rowToLink, toApiLink, type ApiLink, type DomainRow, type LinkRow, type UserRow } from "../types";
import { normalizeHost } from "../host";
import { canUseDomain } from "../perm";
import { actorCan, can, type Guard } from "../roles";
import { checkSlug, slugKey } from "../validate";
import { badWindow, bodyError, canEditLink, code, editFacts, forwarderDeletes, liveEdit, type EditFacts, passwordInput, purgeReturned, rules, times } from "./links";
import { isV1, purge } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };

const hostOf = (u: string) => { try { return normalizeHost(new URL(u).host); } catch { return null; } };

/** Distinct link ids per request (R2). */
export const BULK_MAX = 50;
/** Links whose password is set per request: one PBKDF2 run already fills the Free plan's 10 ms CPU (R6). */
export const PASSWORD_PER_REQUEST = 1;

export type BulkResult = { id: string; ok: true; link?: ApiLink } | { id: string; ok: false; error: string };

// Built on first use: links.ts imports this module, so its schemas are not initialized yet while this one loads.
let schema: ReturnType<typeof makeSchema> | undefined;
function makeSchema() {
  const ids = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(BULK_MAX * 2);
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
/**
 * This batch's own move wrote link `t`: the move marks it with updated_by = `f` (this batch's fresh forwarder id) and the batch's
 * last statement puts the editor back. A revision and editor match alone would also hold for another batch's identical
 * same-second move (D3), which could then recreate a forwarder deleted (and its slug locked) in between.
 */
const OWN = "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND updated_by = json_extract(j.value,'$.f'))";
/** This batch's own forwarder `f` exists, so this batch moved `t` (OWN guards its insert): the repoint and the audit follow it. */
const MINE = "EXISTS (SELECT 1 FROM links x WHERE x.id = json_extract(j.value,'$.f'))";
/** No lock on the target (bind: target id) for key `k`, through the slug_locks_lower index. */
const UNLOCKED = "NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(json_extract(j.value,'$.k')))";
/** No link on the target (bind: target id) holds key `k`. */
const FREE = "NOT EXISTS (SELECT 1 FROM links o WHERE o.domain_id = ? AND o.slug_key = json_extract(j.value,'$.k'))";

/**
 * S8: every statement's re-check of links.bulk (and links.create for a copy, which creates links) and, per row, of the edit
 * right from the row's facts `g` (editFacts, re-checked live as editGuard does), so a role edit or demotion between the reads
 * and the batch writes nothing it no longer allows. The permission subqueries name no column of the row, so D1 runs each once
 * per statement; only rows whose domain the actor owned at read time add a primary-key probe.
 */
const G_C = "json_extract(j.value,'$.g.c')", G_D = "json_extract(j.value,'$.g.d')";
const permGuard = (userId: string, copy: boolean): Guard => {
  const b = actorCan(userId, "links.bulk"), cr = actorCan(userId, "links.create"), e = liveEdit(userId, G_C, G_D);
  return { sql: `(${b.sql}${copy ? ` AND ${cr.sql}` : ""} AND ${e.sql})`, binds: [...b.binds, ...(copy ? cr.binds : []), ...e.binds] };
};

/** POST /api/links/bulk: every link decided with the single-edit rules, all accepted ones written in one D1 batch. */
export async function bulk(c: Context<E>) {
  if (!can(c.var.user, "links.bulk")) return c.json({ error: "forbidden" }, 403);
  const parsed = (schema ??= makeSchema()).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: bodyError(parsed.error) }, 400);
  const b = parsed.data;
  const copy = b.action === "move" && b.oldAddress === "copy";
  // A copy creates links (R9), refused like a missing links.bulk: before anything is read.
  if (copy && !can(c.var.user, "links.create")) return c.json({ error: "forbidden" }, 403);
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
  // A delete also counts each link's forwarders (deleted with it), through links_forward_to.
  const lr = await env.DB.batch<Record<string, unknown>>([env.DB.prepare(
    `SELECT l.*${b.action === "delete" ? ", (SELECT count(*) FROM links f WHERE f.forward_to = l.id) fwd" : ""} FROM json_each(?) j JOIN links l ON l.id = j.value`,
  ).bind(ids)]);
  const found = new Map(lr[0]!.results.map((r) => { const l = rowToLink(r); return [l.id, l]; }));
  const fwdCount = new Map(lr[0]!.results.map((r) => [r.id as string, (r.fwd as number | undefined) ?? 0]));
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
    // Unknown and unusable answer alike, so a domain id is never confirmed to someone who cannot use it.
    if (!target || !canUseDomain(user, target, member.has(target.id), g.domains)) return c.json({ error: "forbidden" }, 403);
    if (target.status !== "active") return c.json({ error: "target_not_active" }, 400);
  }

  const out = new Map<string, BulkResult>();
  const accepted: { link: LinkRow; domain: DomainRow; k: string; g: EditFacts }[] = [];
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
      // A destination or route on the target host (saved while that domain was pending) would redirect to itself there.
      if ([link.url, ...link.routes.map((r) => r.url)].some((u) => hostOf(u) === target.host)) { out.set(id, { id, ok: false, error: "loop" }); continue; }
      const s = checkSlug(link.slug, target.reservedExtra);
      if (!s.ok) { out.set(id, { id, ok: false, error: s.reason === "too_long" ? "slug_too_long" : s.reason }); continue; }
      k = slugKey(link.slug, target.caseSensitive);
    }
    accepted.push({ link, domain, k, g: editFacts(user, link, domain) });
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
  // A selected forwarder whose link is deleted in this request goes with that link (one delete, one audit); same outcome.
  const withParent = new Map<string, string>();
  if (b.action === "delete") {
    const parents = new Set(accepted.map(({ link }) => link.id));
    accepted.splice(0, accepted.length, ...accepted.filter(({ link }) => {
      if (!link.forwardTo || !parents.has(link.forwardTo)) return true;
      withParent.set(link.id, link.forwardTo);
      return false;
    }));
  }

  // R3: the daily caps count one unit per link processed (refused ones too, pending ones not) for /api/v1 and MCP; the key
  // middleware or runTool already charged one (not refunded on a refusal, D7).
  const extra = order.length - pending.length - 1;
  const checks: Check[] = isV1(c.req.path) && extra > 0
    ? [{ key: limitKey.apiDay(user.id), limit: LIMITS.apiDay, charge: extra }, { key: limitKey.apiInstanceDay, limit: LIMITS.apiInstanceDay, charge: extra }]
    : [];
  // R4: one KV delete per written link (a forward move: old and new key plus each forwarder it repoints).
  const cost = b.action === "move" && b.oldAddress === "forward" ? 2 * accepted.length + [...older.values()].reduce((a, n) => a + n, 0)
    : b.action === "delete" ? accepted.reduce((a, { link }) => a + 1 + fwdCount.get(link.id)!, 0) : accepted.length;
  if (cost) checks.push({ key: limitKey.bulkKv, limit: LIMITS.bulkKvDay, charge: cost });
  // The daily caps and bulk:kv in one atomic statement: a refused request writes nothing; the caps refuse first.
  if (checks.length) {
    const r = await hitAll(env, checks);
    if (!r.ok) return c.json({ error: r.key === limitKey.bulkKv ? "kv_budget" : "rate_limited" }, 429);
  }

  const results = () => order.flatMap((id) => out.get(id) ?? []);
  if (!accepted.length) return c.json({ results: results(), pending });

  // One hash per link, each with its own salt (hashPassword draws one per call); null clears, undefined does not occur here.
  const hashes = b.action === "password"
    ? await Promise.all(accepted.map(async () => {
      const pw = await passwordInput(env, b.password);
      if ("error" in pw) throw new Error(pw.error); // validated above
      return pw.hash ?? null;
    }))
    : [];

  const base = { ...actor(c), targetType: "link" };
  const G = permGuard(user.id, copy);
  const rows = accepted.map(({ link, g }, i) => ({ t: link.id, r: link.updatedAt, g, h: hashes[i] ?? null }));
  const json = JSON.stringify(rows);
  let stmts: D1PreparedStatement[];
  // The statement whose RETURNING lists the links written; for a copy it returns the new ids (`n` maps them back).
  let main: D1PreparedStatement;
  let repointed: D1PreparedStatement | undefined;
  // Delete: the statement deleting the forwarders, whose RETURNING lists their cache keys.
  let cascaded: D1PreparedStatement | undefined;
  const newIds = new Map<string, string>();
  if (b.action === "move" && target) {
    const t = target.id;
    if (b.oldAddress === "forward") {
      const rows = accepted.map(({ link, k, g }) => ({
        t: link.id, r: link.updatedAt, k, g, f: crypto.randomUUID(), om: link.domainId, ok: link.slugKey, s: link.slug,
        // Built by the server from the target host and an already-valid slug; it bypasses destination(), which would call it a loop.
        u: `https://${target.host}/${link.slug}`,
      }));
      const json = JSON.stringify(rows);
      const back = JSON.stringify(rows.filter((x) => reclaim.has(x.t)));
      // Only links that had forwarders when read: a new forwarder of a link needs a move of it, which changes its revision.
      const repoint = JSON.stringify(rows.filter((x) => older.has(x.t)));
      main = env.DB.prepare(
        `UPDATE links SET domain_id = ?, slug_key = json_extract(j.value,'$.k'), updated_by = json_extract(j.value,'$.f'), updated_at = max(?, links.updated_at + 1)
         FROM json_each(?) j WHERE links.id = json_extract(j.value,'$.t') AND links.updated_at = json_extract(j.value,'$.r')
         AND ${UNLOCKED} AND ${FREE} AND ${G.sql} RETURNING links.id`,
      ).bind(t, now, json, t, t, ...G.binds);
      stmts = [
        ...(reclaim.size ? [env.DB.prepare(
          `DELETE FROM links WHERE (domain_id, slug_key, forward_to) IN (SELECT ?, json_extract(j.value,'$.k'), l.id FROM json_each(?) j
             JOIN links l ON l.id = json_extract(j.value,'$.t') AND l.updated_at = json_extract(j.value,'$.r') WHERE ${G.sql})
           AND NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(links.slug_key))`,
        ).bind(t, back, ...G.binds, t)] : []),
        main,
        env.DB.prepare(
          `INSERT INTO links (id, domain_id, slug, slug_key, url, redirect_code, starts_at, expires_at, pass_query, password_hash, routes, forward_to, created_by, updated_by, created_at, updated_at)
           SELECT json_extract(j.value,'$.f'), json_extract(j.value,'$.om'), json_extract(j.value,'$.s'), json_extract(j.value,'$.ok'), json_extract(j.value,'$.u'),
             302, NULL, NULL, 1, NULL, '[]', json_extract(j.value,'$.t'), ?, ?, ?, ? FROM json_each(?) j WHERE ${OWN} AND ${G.sql} ON CONFLICT DO NOTHING`,
        ).bind(user.id, user.id, now, now, json, ...G.binds),
        // One hop: every older forwarder of a moved link now points at its new address.
        ...(older.size ? [repointed = env.DB.prepare(
          `UPDATE links SET url = json_extract(j.value,'$.u'), updated_at = max(?, links.updated_at + 1) FROM json_each(?) j
           WHERE links.forward_to = json_extract(j.value,'$.t') AND links.id != json_extract(j.value,'$.f') AND ${MINE} AND ${G.sql} RETURNING links.domain_id, links.slug_key`,
        ).bind(now, repoint, ...G.binds)] : []),
        auditManyStmt(env, { ...base, action: "link.move" }, accepted.map(({ link, domain, k, g }, i) => ({
          targetId: link.id, k, g, r: link.updatedAt, f: rows[i]!.f,
          detail: { fromHost: domain.host, toHost: target.host, slug: link.slug, url: link.url, oldAddress: "forward", forwarderId: rows[i]!.f },
        })), { sql: `${MINE} AND ${G.sql}`, binds: G.binds }),
        // The editor back on each link this batch moved (the OWN mark).
        env.DB.prepare(`UPDATE links SET updated_by = ? FROM json_each(?) j WHERE links.id = json_extract(j.value,'$.t') AND links.updated_by = json_extract(j.value,'$.f') AND ${G.sql}`)
          .bind(user.id, json, ...G.binds),
      ];
    } else {
      const rows = accepted.map(({ link, k, g }) => { const n = crypto.randomUUID(); newIds.set(n, link.id); return { t: link.id, r: link.updatedAt, k, g, n }; });
      main = env.DB.prepare(
        `INSERT INTO links (id, domain_id, slug, slug_key, url, redirect_code, starts_at, expires_at, pass_query, password_hash, routes, forward_to, created_by, updated_by, created_at, updated_at)
         SELECT json_extract(j.value,'$.n'), ?, s.slug, json_extract(j.value,'$.k'), s.url, s.redirect_code, s.starts_at, s.expires_at, s.pass_query, s.password_hash, s.routes,
           NULL, ?, ?, ?, ? FROM json_each(?) j JOIN links s ON s.id = json_extract(j.value,'$.t')
         WHERE s.updated_at = json_extract(j.value,'$.r') AND ${UNLOCKED} AND ${FREE} AND ${G.sql} RETURNING id`,
      ).bind(t, user.id, user.id, now, now, JSON.stringify(rows), t, t, ...G.binds);
      stmts = [
        main,
        // Same detail as a single create, plus the source; the copied hash is never in it (protection only).
        auditManyStmt(env, { ...base, action: "link.create" }, accepted.map(({ link, g }, i) => ({
          targetId: rows[i]!.n, g,
          detail: { host: target.host, slug: link.slug, url: link.url, ...(link.passwordHash ? { protection: "set" } : {}), ...(link.routes.length ? { routes: link.routes.length } : {}), copiedFrom: link.id },
        })), { sql: `EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t')) AND ${G.sql}`, binds: G.binds }),
      ];
    }
  } else if (b.action === "delete") {
    const withFwd = rows.filter((x) => fwdCount.get(x.t)! > 0);
    let fd: D1PreparedStatement[] = [];
    stmts = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO slug_locks (domain_id, slug_key, locked_at, locked_by)
         SELECT json_extract(j.value,'$.m'), json_extract(j.value,'$.k'), ?, ? FROM json_each(?) j WHERE ${REV} AND ${G.sql}`,
      ).bind(now, user.id, JSON.stringify(accepted.map(({ link, g }) => ({ t: link.id, r: link.updatedAt, g, m: link.domainId, k: link.slugKey }))), ...G.binds),
      auditManyStmt(env, { ...base, action: "link.delete" },
        accepted.map(({ link, domain, g }) => ({ targetId: link.id, r: link.updatedAt, g, detail: { host: domain.host, slug: link.slug, url: link.url } })),
        { sql: `${REV} AND ${G.sql}`, binds: G.binds }),
      // Only links that had forwarders when read: a new forwarder of a link needs a move of it, which changes its revision.
      ...(withFwd.length ? (fd = forwarderDeletes(env, base, now, JSON.stringify(withFwd), { sql: `${REV} AND ${G.sql}`, binds: G.binds })) : []),
      main = env.DB.prepare(`DELETE FROM links WHERE (id, updated_at) IN (SELECT json_extract(j.value,'$.t'), json_extract(j.value,'$.r') FROM json_each(?) j WHERE ${G.sql}) RETURNING id`)
        .bind(json, ...G.binds),
    ];
    cascaded = fd[2];
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
      auditManyStmt(env, { ...base, action: "link.update" }, accepted.map(({ link, domain, g }) => {
        const p = protection(link);
        return { targetId: link.id, r: link.updatedAt, g, detail: { host: domain.host, slug: link.slug, url: link.url, ...(p ? { protection: p } : {}), bulk: b.action } };
      }), { sql: `${REV} AND ${G.sql}`, binds: G.binds }),
      // updated_at is the revision: always moves forward, even within the same second.
      main = env.DB.prepare(
        `UPDATE links SET ${set.join(", ")}, updated_by = ?, updated_at = max(?, links.updated_at + 1)
         FROM json_each(?) j WHERE links.id = json_extract(j.value,'$.t') AND links.updated_at = json_extract(j.value,'$.r') AND ${G.sql} RETURNING links.id`,
      ).bind(...binds, user.id, now, json, ...G.binds),
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
  // The committed writes' cache keys go first, so a failing diagnosis read below never leaves a stale redirect cached.
  await Promise.all([...keys.map(([d, k]) => purge(env, d, k)), ...(cascaded ? [purgeReturned(env, res[stmts.indexOf(cascaded)]!)] : [])]);
  // Something not written: tell a permission lost since the reads (forbidden) from a changed link (conflict). One batch, only then.
  let lostPerm = (_: string) => false;
  if (done.length < accepted.length) {
    const hb = actorCan(user.id, "links.bulk"), hc = actorCan(user.id, "links.create"), e = liveEdit(user.id, G_C, G_D);
    const lost = JSON.stringify(accepted.filter(({ link }) => !applied.has(link.id)).map(({ link, g }) => ({ t: link.id, g })));
    const [flags, no] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`SELECT ${hb.sql} b, ${hc.sql} c`).bind(...hb.binds, ...hc.binds),
      env.DB.prepare(`SELECT json_extract(j.value,'$.t') t FROM json_each(?) j WHERE NOT ${e.sql}`).bind(lost, ...e.binds),
    ]);
    const f = flags!.results[0] ?? {};
    const whole = !f.b || (copy && !f.c);
    if (whole && !done.length) return c.json({ error: "forbidden" }, 403);
    const refused = new Set(no!.results.map((r) => r.t as string));
    lostPerm = (id) => whole || refused.has(id);
  }
  // Keyed by the selected id: a copy answers with the new link (the source is unchanged).
  const fresh = new Map<string, LinkRow>();
  if (b.action !== "delete" && done.length) {
    const want = newIds.size ? returned : done.map(({ link }) => link.id);
    const rr = await env.DB.prepare("SELECT * FROM links WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(want)).all();
    for (const r of rr.results) { const l = rowToLink(r); fresh.set(newIds.get(l.id) ?? l.id, l); }
  }
  for (const { link } of accepted) {
    const f = fresh.get(link.id);
    out.set(link.id, applied.has(link.id) ? { id: link.id, ok: true, ...(f ? { link: toApiLink(f) } : {}) } : { id: link.id, ok: false, error: lostPerm(link.id) ? "forbidden" : "conflict" });
  }
  // A selected forwarder shares its parent's outcome: it was deleted with it, or not, for the same reason.
  for (const [id, parent] of withParent) out.set(id, applied.has(parent) ? { id, ok: true } : { ...(out.get(parent) as BulkResult), id });
  return c.json({ results: results(), pending });
}
