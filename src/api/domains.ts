import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { CfError, cfConfig } from "../cf/api";
import { AttachError, classify, detachDomain, isVerified, logInternal, syncDomain, takeoverCheck } from "../cf/attach";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { canManageDomain, canUseDomain } from "../perm";
import { rowToCf, rowToDomain, type CfRow, type CfView, type DomainRow, type UserRow } from "../types";
import { checkSlugShape } from "../validate";
import { destination, getDomain, loopField, purgeHost as purge, purgeMany } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const domains = new Hono<E>();

const forbidden = { error: "forbidden" } as const;
const notFound = { error: "not_found" } as const;
export const MAX_PENDING_PER_MEMBER = 3;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const createBody = z.strictObject({ host: z.string(), type: z.enum(["main", "shared", "private"]), confirmTakeover: z.boolean().optional() });
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

// Second-level labels that make a two-letter ccTLD pair (co.uk, com.au) one registrable suffix.
// shortcut: a fixed list, display only (instructions.name/apex); use the Public Suffix List if users need more.
const CC_SLD = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);
/** Registrable apex by the simple rule: the last two labels, or three when they are a ccTLD pair like co.uk. */
export function apexOf(host: string): string {
  const l = host.split(".");
  const n = l.length >= 3 && l[l.length - 1]!.length === 2 && CC_SLD.has(l[l.length - 2]!) ? 3 : 2;
  return l.slice(-n).join(".");
}

const getCf = async (env: Env, id: string): Promise<CfRow | null> => {
  const r = await env.DB.prepare("SELECT * FROM domain_cf WHERE domain_id = ?").bind(id).first();
  return r ? rowToCf(r) : null;
};

/** A missing domain_cf row reads as manual (S1 behaviour). */
function cfView(env: Env, d: DomainRow, cf: CfRow | null): CfView {
  const t = env.CF_CNAME_TARGET?.trim();
  const target = t ? normalizeHost(t) : null;
  const apex = apexOf(d.host);
  const base = cf ?? { kind: "manual", dns: "unknown", ownership: "unknown", certificate: "unknown", errors: [], lastError: null, checkedAt: null, routeId: null };
  return {
    kind: base.kind, dns: base.dns, ownership: base.ownership, certificate: base.certificate,
    errors: base.errors, lastError: base.lastError, checkedAt: base.checkedAt,
    instructions: base.kind === "outside" && target
      ? { type: "CNAME", name: d.host === apex ? "@" : d.host.slice(0, -apex.length - 1), target, apex: d.host === apex }
      : null,
    attachOnApproval: base.kind === "account" && base.routeId === null && d.status === "pending",
  };
}

/** After a committed write a failed sync is reported through lastError (syncDomain stored it), never as a 5xx. */
async function trySync(env: Env, d: DomainRow, cf: CfRow, opts: { attach: boolean; confirmTakeover?: boolean }): Promise<CfRow> {
  const cfg = cfConfig(env);
  if (!cfg || cf.kind === "manual") return cf;
  try {
    return await syncDomain(env, cfg, d, cf, opts); // logs internal errors itself
  } catch {
    try {
      return (await getCf(env, d.id)) ?? cf;
    } catch (e) {
      logInternal(d.id, e);
      return { ...cf, lastError: "internal_error" };
    }
  }
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
  const cfs = new Map((await c.env.DB.prepare("SELECT * FROM domain_cf").all()).results.map((r) => [r.domain_id as string, rowToCf(r)]));
  // shortcut: no pagination, the domain list is small; add a cursor if an instance ever hosts thousands.
  const items = (await c.env.DB.prepare("SELECT * FROM domains ORDER BY host").all()).results.map(rowToDomain)
    .filter((d) => canUseDomain(user, d, members.has(d.id)))
    .map((d) => ({ ...d, linkCount: counts.get(d.id) ?? 0, isMember: members.has(d.id), cloudflare: cfView(c.env, d, cfs.get(d.id) ?? null) }));
  return c.json(items);
});

domains.post("/", async (c) => {
  const user = c.var.user;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { type, confirmTakeover } = body.data;
  const isOwner = user.role === "owner";
  if (!isOwner && type !== "private") return c.json(forbidden, 403);
  const host = normalizeHost(body.data.host.trim());
  const bad = hostError(host, c.env.DASHBOARD_HOST, c.env.CF_CNAME_TARGET);
  if (bad) return c.json({ error: bad }, 400);
  // Early exits so a doomed create makes no Cloudflare calls; the INSERT below still enforces both under races.
  if (await c.env.DB.prepare("SELECT 1 FROM domains WHERE host = ?").bind(host).first()) return c.json({ error: "host_taken" }, 409);
  if (!isOwner && (await c.env.DB.prepare("SELECT COUNT(*) n FROM domains WHERE owner_id = ? AND status = 'pending'").bind(user.id).first<{ n: number }>())!.n >= MAX_PENDING_PER_MEMBER)
    return c.json({ error: "pending_limit" }, 409);
  const cfg = cfConfig(c.env);
  let kind: CfRow["kind"] = "manual";
  if (cfg) {
    // Every Cloudflare read and refusal happens before the first write.
    try {
      const k = await classify(cfg, host);
      kind = k.kind;
      // R3: only the owner attaches at create, so only the owner is asked about a takeover. Same checks as syncDomain.
      if (k.kind === "account" && isOwner) {
        const code = await takeoverCheck(cfg, host, { id: k.zoneId, name: k.zoneName }, confirmTakeover);
        if (code) return c.json({ error: code }, 409);
      }
    } catch (e) {
      if (!(e instanceof CfError)) throw e;
      return e.status === 0 && e.codes.includes(-1) ? c.json({ error: "outside_not_configured" }, 400) : c.json({ error: "cloudflare_unreachable" }, 502);
    }
  }
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
      c.env.DB.prepare("INSERT INTO domain_cf (domain_id, kind, updated_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM domains WHERE id = ?)")
        .bind(d.id, kind, d.createdAt, d.id),
      auditStmt(c.env, { actorId: user.id, action: "domain.create", targetType: "domain", targetId: d.id,
        detail: { host, type, status: d.status } }, exists(d.id)),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "host_taken" }, 409);
    throw e;
  }
  if (res[0]!.meta.changes === 0) return c.json({ error: "pending_limit" }, 409);
  await purge(c.env, host); // clears a 60 s cached miss for this host
  // The row exactly as inserted, so nothing after the committed batch can turn this into a 500.
  const inserted: CfRow = { kind, zoneId: null, dnsRecordId: null, routeId: null, hostnameId: null, dns: "unknown", ownership: "unknown",
    certificate: "unknown", errors: [], lastError: null, checkedAt: null, securityLevel: null, rateLimit: null, updatedAt: d.createdAt };
  // A member's same-account create runs read-only (attach false): R3, no Cloudflare write.
  const cf = await trySync(c.env, d, inserted, { attach: kind === "outside" || isOwner, confirmTakeover });
  const out = { ...d, cloudflare: cfView(c.env, d, cf) };
  return c.json(isOwner ? { ...out, ...(await loopField(c.env, host)) } : out, 201);
});

/** R9: the poll endpoint and the retry. Repair mode only (attach false), so no poll can ever take over a host. */
domains.get("/:id/cloudflare", async (c) => {
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  if (!canManageDomain(c.var.user, d)) return c.json(forbidden, 403);
  let cf = await getCf(c.env, d.id);
  // Throttled on the last attempt, failed ones included, so a failing domain cannot drain the shared API budget.
  const fresh = !!cf && Math.floor(Date.now() / 1000) - Math.max(cf.checkedAt ?? 0, cf.updatedAt) < 10;
  // A disabled domain is never repaired: no Cloudflare calls.
  if (cf && !fresh && (d.status === "pending" || d.status === "active")) cf = await trySync(c.env, d, cf, { attach: false });
  return c.json(cfView(c.env, d, cf));
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

const approveBody = z.strictObject({ confirmTakeover: z.boolean().optional() });
// Objects linkwarren created; zone_id is only a lookup.
const cfIds = (cf: CfRow) => [cf.dnsRecordId, cf.routeId, cf.hostnameId];
const notConfigured = { error: "cloudflare_not_configured" } as const;

/** Owner-only status change, audit first and both guarded on the status we read: a racing change writes neither a phantom audit nor a stale status. */
async function setStatus(c: Context<E>, d: DomainRow, verb: "approve" | "disable", to: DomainRow["status"], extra: Record<string, unknown> = {}): Promise<DomainRow | null | "lost"> {
  if (d.status === to) return d;
  const at = { sql: "EXISTS (SELECT 1 FROM domains WHERE id = ? AND status = ?)", binds: [d.id, d.status] };
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: c.var.user.id, action: `domain.${verb}`, targetType: "domain", targetId: d.id,
      detail: { host: d.host, from: d.status, ...extra } }, at),
    c.env.DB.prepare("UPDATE domains SET status = ? WHERE id = ? AND status = ?").bind(to, d.id, d.status),
  ]);
  if (res[1]!.meta.changes === 0) return (await getDomain(c.env, d.id)) ?? "lost";
  await purge(c.env, d.host);
  return { ...d, status: to };
}

/**
 * approve: pending or disabled -> active, gated (R5) only on the row a fresh sync inside this request returned.
 * An active `account` domain without a route is a half-finished attach: approve finishes it ("Finish connecting").
 */
domains.post("/:id/approve", async (c) => {
  if (c.var.user.role !== "owner") return c.json(forbidden, 403);
  const raw = await c.req.json().catch(() => null);
  const body = approveBody.safeParse(raw ?? {});
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  let cf = await getCf(c.env, d.id);
  const finish = d.status === "active" && cf?.kind === "account" && cf.routeId === null;
  if (d.status === "active" && !finish) return c.json({ ...d, ...(await loopField(c.env, d.host)) });
  if (cf && cf.kind !== "manual") {
    const cfg = cfConfig(c.env);
    // Without Cloudflare settings nothing can be checked, so nothing is approved.
    if (!cfg) return c.json(notConfigured, 409);
    try {
      cf = await syncDomain(c.env, cfg, d, cf, { attach: cf.kind === "account", confirmTakeover: body.data.confirmTakeover });
    } catch (e) {
      if (e instanceof AttachError) return c.json({ error: e.code }, 409);
      if (e instanceof CfError) {
        // syncDomain throws 404 when the domain was deleted under it (a racing reject).
        if (e.status === 404 && !(await getDomain(c.env, d.id))) return c.json(notFound, 404);
        return c.json({ error: "cloudflare_error" }, 502);
      }
      throw e; // syncDomain logged it
    }
    if (finish) {
      // A route someone else made is never adopted, so nothing was attached: no audit.
      if (cf.routeId === null) return c.json({ error: "not_verified", cloudflare: cfView(c.env, d, cf) }, 409);
      await c.env.DB.batch([auditStmt(c.env, { actorId: c.var.user.id, action: "domain.attach", targetType: "domain", targetId: d.id,
        detail: { host: d.host } }, exists(d.id))]);
      return c.json({ ...d, cloudflare: cfView(c.env, d, cf), ...(await loopField(c.env, d.host)) });
    }
    if (!isVerified(cf)) return c.json({ error: "not_verified", cloudflare: cfView(c.env, d, cf) }, 409);
  }
  const view = cfView(c.env, d, cf);
  const out = await setStatus(c, d, "approve", "active", { check: { dns: view.dns, ownership: view.ownership, certificate: view.certificate } });
  if (out === "lost" || out === null) return c.json(notFound, 404);
  const loop = out.status === "active" ? await loopField(c.env, out.host) : {};
  return c.json({ ...out, cloudflare: cfView(c.env, out, cf), ...loop });
});

/** disable: any -> disabled. Owner-only and idempotent. */
domains.post("/:id/disable", async (c) => {
  if (c.var.user.role !== "owner") return c.json(forbidden, 403);
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  const out = await setStatus(c, d, "disable", "disabled");
  return out === "lost" || out === null ? c.json(notFound, 404) : c.json(out);
});

/**
 * Reject (R7): owner only, pending only. Cloudflare cleanup first (404 counts as gone); any other Cloudflare failure
 * leaves D1 untouched so the owner can retry. Then one guarded batch removes the domain and everything on it.
 */
domains.delete("/:id", async (c) => {
  const user = c.var.user;
  if (user.role !== "owner") return c.json(forbidden, 403);
  const d = await getDomain(c.env, c.req.param("id"));
  if (!d) return c.json(notFound, 404);
  if (d.status !== "pending") return c.json({ error: "not_pending" }, 409);
  const cfg = cfConfig(c.env);
  // Re-read right before detach, so ids a sync stored earlier in this request's lifetime are included.
  const cf = await getCf(c.env, d.id);
  if (cf && cfIds(cf).some((v) => v)) {
    if (!cfg) return c.json(notConfigured, 409);
    try {
      await detachDomain(c.env, cfg, d, cf);
    } catch (e) {
      if (e instanceof CfError) return c.json({ error: "cloudflare_error" }, 502);
      throw e;
    }
  }
  const pending = "EXISTS (SELECT 1 FROM domains WHERE id = ? AND status = 'pending')";
  const del = (t: string, col: string) => c.env.DB.prepare(`DELETE FROM ${t} WHERE ${col} = ? AND ${pending}`).bind(d.id, d.id);
  const at = Math.floor(Date.now() / 1000);
  // Reads first in the same batch, so the ids, slugs and link count are exactly what the delete removed.
  const res = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM domain_cf WHERE domain_id = ?").bind(d.id),
    c.env.DB.prepare("SELECT slug FROM links WHERE domain_id = ?").bind(d.id),
    c.env.DB.prepare(
      `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail)
       SELECT ?, ?, NULL, 'domain.reject', 'domain', ?, json_object('host', ?, 'links', (SELECT COUNT(*) FROM links WHERE domain_id = ?), 'owner', ?)
       WHERE ${pending}`,
    ).bind(at, user.id, d.id, d.host, d.id, d.ownerId, d.id),
    del("links", "domain_id"), del("slug_locks", "domain_id"), del("domain_members", "domain_id"), del("domain_cf", "domain_id"),
    c.env.DB.prepare("DELETE FROM domains WHERE id = ? AND status = 'pending'").bind(d.id),
  ]);
  if (res[res.length - 1]!.meta.changes === 0) {
    // Lost to a concurrent approve after our detach: put the active domain back in Cloudflare (repair, never a takeover).
    const cur = await getDomain(c.env, d.id);
    const now = cur && (await getCf(c.env, d.id).catch(() => null));
    if (cur && now && cur.status === "active") await trySync(c.env, cur, now, { attach: false });
    return c.json({ error: "conflict" }, 409);
  }
  // M-4: a sync running concurrently may have stored a new id after detach read the row. Best-effort, never fails the reject.
  const last = res[0]!.results[0] as Record<string, unknown> | undefined;
  const atDelete = last ? rowToCf(last) : null;
  if (cfg && atDelete && cf && cfIds(atDelete).some((v, i) => v && v !== cfIds(cf)[i])) {
    await detachDomain(c.env, cfg, d, atDelete).catch((e) =>
      console.warn("linkwarren: second cleanup after reject failed", JSON.stringify({ domainId: d.id, error: e instanceof CfError ? e.message : "internal_error" })));
  }
  const slugs = (res[1]!.results as { slug: string }[]).flatMap((r) => [r.slug, r.slug.toLowerCase()]);
  // shortcut: one KV delete per key (subrequest cap on huge domains); the 300 s TTL covers the rest, and the host purge alone already ends serving.
  await Promise.all([purge(c.env, d.host), purgeMany(c.env, d.id, [...new Set(slugs)])]);
  return c.body(null, 204);
});

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
