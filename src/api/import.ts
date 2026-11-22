import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { parseSettings, settingsQ } from "../settings";
import { rowToDomain, type DomainRow, type UserRow } from "../types";
import { canManageDomain, usableDomainsSql } from "../perm";
import { actorCan, can, type Guard } from "../roles";
import { checkDestination, checkSlugShape, slugKey } from "../validate";
import { hostError } from "./domains";
import { purgeHost, purgeMany } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const importApi = new Hono<E>();

const MAX_LINKS = 1000;
const CHUNK = 100; // statements per D1 batch

const body = z.object({
  mainHost: z.string().min(1).max(1024),
  domains: z.array(z.object({
    host: z.string().max(1024), customIndexUrl: z.string().max(8192).nullable().optional(), customNotFoundUrl: z.string().max(8192).nullable().optional(),
  })).max(MAX_LINKS),
  links: z.array(z.object({
    host: z.string().max(1024).nullable(), slug: z.string().max(1024), destination: z.string().max(8192), enabled: z.boolean(),
    startDate: z.string().max(32).nullable().optional(), endDate: z.string().max(32).nullable().optional(),
    // A legacy password link: its hash cannot be carried over, so it is imported like a disabled link (a lock) and listed.
    protected: z.boolean().optional(),
  })),
  confirmNoPasswords: z.boolean().optional(),
});

/** "YYYY-MM-DD HH:MM:SS" (UTC) -> unix seconds, null for null, undefined when unparseable. */
function parseDate(s: string | null | undefined): number | null | undefined {
  if (s === null || s === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  const ok = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
  return ok ? t.getTime() / 1000 : undefined;
}

type Dom = { id: string; host: string; isNew: boolean; cs: boolean; bare: string | null; nf: string | null; fillBare: boolean; fillNf: boolean };
type Out = { kind: "create"; sql: "link" | "lock" } | { kind: "skip" } | { kind: "conflict"; reason: string };

importApi.post("/", async (c) => {
  const user = c.var.user;
  // S8 R12: import is the `data` permission, checked before the body is read.
  if (!can(user, "data")) return c.json({ error: "forbidden" }, 403);
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const b = parsed.data;
  if (b.links.length > MAX_LINKS) return c.json({ error: "too_many" }, 400);
  const dry = c.req.query("dryRun") === "1";
  // N2: a row that does not say whether it had a password (an old export, a CSV, a mixed file) would go live as an open
  // redirect, so a real run needs the owner's explicit confirmation if any row omits it. Export rows always carry it.
  if (!dry && b.links.some((l) => l.protected === undefined) && b.confirmNoPasswords !== true)
    return c.json({ error: "protected_unknown" }, 400);
  const dashboard = normalizeHost(c.env.DASHBOARD_HOST);
  const mainHost = normalizeHost(b.mainHost);
  const hostOf = (h: string | null) => (h === null ? mainHost : normalizeHost(h));

  // Domains: reuse existing, plan the rest.
  // shortcut: loads every domain row; the table is small, page it if an instance ever hosts thousands.
  const existing = new Map((await c.env.DB.prepare("SELECT * FROM domains").all()).results.map(rowToDomain).map((d) => [d.host, d] as const));
  const hosts = new Set([...b.domains.map((d) => normalizeHost(d.host)), ...b.links.map((l) => hostOf(l.host))]);
  const doms = new Map<string, Dom>(), badHost = new Map<string, string>();
  // case twins per domain: lower(slug) -> distinct slugs (only slugs of a valid shape)
  const twins = new Map<string, Map<string, Set<string>>>();
  for (const l of b.links) {
    if (!checkSlugShape(l.slug).ok) continue;
    const m = twins.get(hostOf(l.host)) ?? new Map<string, Set<string>>();
    const k = l.slug.toLowerCase();
    m.set(k, (m.get(k) ?? new Set()).add(l.slug));
    twins.set(hostOf(l.host), m);
  }
  const hasTwins = (h: string) => [...(twins.get(h)?.values() ?? [])].some((s) => s.size > 1);
  const isTwin = (h: string, slug: string) => (twins.get(h)?.get(slug.toLowerCase())?.size ?? 0) > 1;
  for (const h of hosts) {
    const row: DomainRow | undefined = existing.get(h);
    if (row) { doms.set(h, { id: row.id, host: h, isNew: false, cs: row.caseSensitive, bare: row.bareRedirect, nf: row.notfoundRedirect, fillBare: false, fillNf: false }); continue; }
    const err = hostError(h, c.env.DASHBOARD_HOST);
    if (err) { badHost.set(h, err); continue; }
    doms.set(h, { id: crypto.randomUUID(), host: h, isNew: true, cs: hasTwins(h), bare: null, nf: null, fillBare: false, fillNf: false });
  }

  // Destinations may not point at any short host, existing or about to be created.
  const shortHosts = [...existing.keys(), ...[...doms.values()].filter((d) => d.isNew).map((d) => d.host), dashboard];
  const dest = (raw: string): string | null => {
    const r = checkDestination(raw, shortHosts);
    return r.ok && r.url.href.length <= 2048 ? r.url.href : null;
  };
  const ignored: { host: string; field: string }[] = [];
  for (const d of b.domains) {
    const dom = doms.get(normalizeHost(d.host));
    if (!dom) continue;
    for (const [field, raw, cur] of [["customIndexUrl", d.customIndexUrl, "bare"], ["customNotFoundUrl", d.customNotFoundUrl, "nf"]] as const) {
      if (!raw) continue;
      const href = dest(raw);
      if (!href) { ignored.push({ host: dom.host, field }); continue; }
      if (dom[cur] !== null) continue; // never overwrite a redirect that is already set
      dom[cur] = href;
      if (!dom.isNew) dom[cur === "bare" ? "fillBare" : "fillNf"] = true;
    }
  }

  // Existing links and locks of reused domains.
  const live = new Map<string, Map<string, string>>(), locks = new Map<string, Set<string>>();
  for (const d of doms.values()) { live.set(d.id, new Map()); locks.set(d.id, new Set()); }
  // Two queries in total, whatever the domain count: ids go in as one JSON bind (D1 caps queries per invocation and binds per query).
  const reused = JSON.stringify([...doms.values()].filter((d) => !d.isNew).map((d) => d.id));
  const [liveRows, lockRows, setRows, usableRows] = await c.env.DB.batch<{ domain_id: string; slug_key: string; url?: string; id?: string }>([
    c.env.DB.prepare("SELECT domain_id, slug_key, url FROM links WHERE domain_id IN (SELECT value FROM json_each(?))").bind(reused),
    c.env.DB.prepare("SELECT domain_id, slug_key FROM slug_locks WHERE domain_id IN (SELECT value FROM json_each(?))").bind(reused),
    settingsQ(c.env),
    c.env.DB.prepare(usableDomainsSql).bind(user.id),
  ]);
  // S8 R12, before any write and in a dry run too: a new domain needs domains.manage; every existing domain the file names must
  // be one the person can use, and a redirect filled in needs the right to manage that domain.
  const usable = new Set(usableRows!.results.map((r) => r.id!));
  const named = [...doms.values()];
  if (named.some((d) => d.isNew) && !can(user, "domains.manage")) return c.json({ error: "forbidden" }, 403);
  if (named.some((d) => !d.isNew && (!usable.has(d.id) || ((d.fillBare || d.fillNf) && !canManageDomain(user, existing.get(d.host)!)))))
    return c.json({ error: "forbidden" }, 403);
  // The import format carries no redirect code or query rule, so imported links take the instance defaults.
  const defaults = parseSettings(setRows!.results as unknown as { key: string; value: string }[]);
  for (const r of liveRows!.results) live.get(r.domain_id)!.set(r.slug_key, r.url!);
  for (const r of lockRows!.results) locks.get(r.domain_id)!.add(r.slug_key.toLowerCase());

  type Plan = { dom: Dom; slug: string; key: string; url: string; startsAt: number | null; expiresAt: number | null };
  const out: Out[] = new Array(b.links.length);
  const plans: { link: Plan[]; lock: Plan[] } = { link: [], lock: [] };
  const conflict = (i: number, reason: string) => { out[i] = { kind: "conflict", reason }; };

  // Pass 1 validates everything and places live links; pass 2 places disabled links (locks), so a live link always wins its key.
  const disabled: number[] = [];
  b.links.forEach((l, i) => {
    const host = hostOf(l.host);
    const dom = doms.get(host);
    if (!dom) return conflict(i, badHost.get(host) ?? "invalid_host");
    if (!checkSlugShape(l.slug).ok) return conflict(i, "invalid_slug");
    if (!dom.cs && isTwin(host, l.slug)) return conflict(i, "case_twin");
    if (!l.enabled || l.protected) { disabled.push(i); return; }
    const href = dest(l.destination);
    if (!href) return conflict(i, "invalid_destination");
    const startsAt = parseDate(l.startDate), expiresAt = parseDate(l.endDate);
    if (startsAt === undefined || expiresAt === undefined || (startsAt !== null && expiresAt !== null && expiresAt <= startsAt)) return conflict(i, "bad_date");
    const key = slugKey(l.slug, dom.cs);
    const have = live.get(dom.id)!.get(key);
    if (have !== undefined) { out[i] = have === href ? { kind: "skip" } : { kind: "conflict", reason: "exists" }; return; }
    if (locks.get(dom.id)!.has(key.toLowerCase())) return conflict(i, "locked");
    live.get(dom.id)!.set(key, href);
    plans.link.push({ dom, slug: l.slug, key, url: href, startsAt, expiresAt });
    out[i] = { kind: "create", sql: "link" };
  });
  // Case variants count as the same key here (locks are case-insensitive): disabled `abc` beside live `Abc` is a conflict.
  const liveLower = new Map([...live].map(([id, m]) => [id, new Set([...m.keys()].map((k) => k.toLowerCase()))] as const));
  for (const i of disabled) {
    const l = b.links[i]!, dom = doms.get(hostOf(l.host))!;
    const key = slugKey(l.slug, dom.cs);
    // protected_live: a former password link already serves as an open redirect here; the owner has to fix it by hand.
    if (liveLower.get(dom.id)!.has(key.toLowerCase())) { conflict(i, l.protected ? "protected_live" : "exists"); continue; }
    if (locks.get(dom.id)!.has(key.toLowerCase())) { out[i] = { kind: "skip" }; continue; }
    locks.get(dom.id)!.add(key.toLowerCase());
    plans.lock.push({ dom, slug: l.slug, key, url: "", startsAt: null, expiresAt: null });
    out[i] = { kind: "create", sql: "lock" };
  }

  const conflicts = out.flatMap((o, i) => o.kind === "conflict" ? [{ host: hostOf(b.links[i]!.host), slug: b.links[i]!.slug, reason: o.reason }] : []);
  const planned = plans.link.length + plans.lock.length;
  const skipped = out.filter((o) => o.kind === "skip").length;
  const newDoms = [...doms.values()].filter((d) => d.isNew);
  const report = {
    created: planned, skipped, conflicts, caseSensitiveDomains: newDoms.filter((d) => d.cs).map((d) => d.host),
    domainsCreated: newDoms.map((d) => d.host), ignored,
    // Locked or already locked: the owner recreates each with a new password. Conflicts are already in `conflicts`.
    protected: b.links.flatMap((l, i) => (l.protected && out[i]!.kind !== "conflict" ? [{ host: hostOf(l.host), slug: l.slug }] : [])),
  };
  if (dry) return c.json(report);

  const now = Math.floor(Date.now() / 1000);
  const db = c.env.DB;
  // Every write re-checks in SQL what the checks above allowed: data, domains.manage for a new domain, the domain usable
  // (links, locks) or managed (redirects). A chunk whose audit guard fails wrote nothing and ends the import with 403.
  const may = actorCan(user.id, "data"), mgr = actorCan(user.id, "domains.manage");
  const use = (domainId: string): Guard => ({ sql: `${may.sql} AND ? IN (${usableDomainsSql})`, binds: [...may.binds, domainId, user.id] });
  // Work statements carry their kind and host so each D1 batch can audit exactly what it touches.
  type Work = { stmt: D1PreparedStatement; kind: "domain" | "fill" | "link" | "lock"; host: string; counted: boolean; plan?: Plan };
  const work: Work[] = [];
  for (const d of newDoms) {
    work.push({ kind: "domain", host: d.host, counted: false, stmt: db.prepare(
      `INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,notfound_redirect,case_sensitive,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${may.sql} AND ${mgr.sql}`,
    ).bind(d.id, d.host, "private", "active", user.id, d.bare, d.nf, d.cs ? 1 : 0, now, ...may.binds, ...mgr.binds) });
  }
  for (const d of doms.values()) {
    // Fill only while still null, so a concurrent edit is never clobbered.
    const manage = `${may.sql} AND (owner_id = ? OR ${mgr.sql})`, mb = [...may.binds, user.id, ...mgr.binds];
    if (d.fillBare) work.push({ kind: "fill", host: d.host, counted: false, stmt: db.prepare(`UPDATE domains SET bare_redirect = ? WHERE id = ? AND bare_redirect IS NULL AND ${manage}`).bind(d.bare, d.id, ...mb) });
    if (d.fillNf) work.push({ kind: "fill", host: d.host, counted: false, stmt: db.prepare(`UPDATE domains SET notfound_redirect = ? WHERE id = ? AND notfound_redirect IS NULL AND ${manage}`).bind(d.nf, d.id, ...mb) });
  }
  // The slug key was computed from the case mode read at planning time; insert only while the domain still has it.
  for (const p of plans.link) {
    work.push({ kind: "link", host: p.dom.host, counted: true, plan: p, stmt: db.prepare(
      `INSERT OR IGNORE INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,created_by,updated_by,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?))
       AND EXISTS (SELECT 1 FROM domains WHERE id = ? AND case_sensitive = ?) AND ${use(p.dom.id).sql}`,
    ).bind(crypto.randomUUID(), p.dom.id, p.slug, p.key, p.url, defaults.linkRedirectCode, p.startsAt, p.expiresAt, defaults.linkPassQuery ? 1 : 0, user.id, user.id, now, now, p.dom.id, p.key, p.dom.id, p.dom.cs ? 1 : 0, ...use(p.dom.id).binds) });
  }
  // A live link committed after planning wins its key over a planned lock.
  for (const p of plans.lock) {
    work.push({ kind: "lock", host: p.dom.host, counted: true, plan: p, stmt: db.prepare(
      `INSERT OR IGNORE INTO slug_locks (domain_id,slug_key,locked_at,locked_by)
       SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM links WHERE domain_id = ? AND lower(slug_key) = lower(?)) AND ${use(p.dom.id).sql}`,
    ).bind(p.dom.id, p.key, now, user.id, p.dom.id, p.key, ...use(p.dom.id).binds) });
  }
  const runAudit = (g: Guard) => auditStmt(c.env, { actorId: user.id, action: "import.run", targetType: "import", targetId: "file",
    detail: { planned, skipped, conflicts: conflicts.length, domainsCreated: report.domainsCreated } }, g);
  let inserted = 0; // INSERT OR IGNORE can lose a race; report what was really written
  const lostLinks: Plan[] = [], lostLocks: Plan[] = [];
  const SIZE = CHUNK - 2; // room for the run row (first batch) and the chunk row
  for (let i = 0; i === 0 || i < work.length; i += SIZE) {
    const part = work.slice(i, i + SIZE);
    const n = (k: Work["kind"]) => part.filter((w) => w.kind === k).length;
    const g: Guard = n("domain") ? { sql: `${may.sql} AND ${mgr.sql}`, binds: [...may.binds, ...mgr.binds] } : may;
    const chunkAudit = auditStmt(c.env, { actorId: user.id, action: "import.chunk", targetType: "import", targetId: "file",
      detail: { hosts: [...new Set(part.map((w) => w.host))], domains: n("domain"), links: n("link"), locks: n("lock") } }, g);
    const res = await db.batch([...(i === 0 ? [runAudit(g)] : []), chunkAudit, ...part.map((w) => w.stmt)]);
    // The audit and every statement share the batch's view: a refused audit guard means a lost permission and no write.
    if (!res[i === 0 ? 1 : 0]!.meta.changes) return c.json({ error: "forbidden" }, 403);
    const off = res.length - part.length;
    part.forEach((w, k) => {
      if (!w.counted) return;
      if (res[off + k]!.meta.changes) inserted++;
      else (w.kind === "link" ? lostLinks : lostLocks).push(w.plan!);
    });
  }
  report.created = inserted;

  // Explain the writes a guard refused: a changed case mode, or a slug that went live before its lock.
  // Other lost races (a concurrent identical link or lock) stay uncounted, as before.
  if (lostLinks.length || lostLocks.length) {
    const [modes, live, locked] = await db.batch<{ id?: string; case_sensitive?: number; i?: number }>([
      db.prepare("SELECT id, case_sensitive FROM domains WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(lostLinks.map((p) => p.dom.id))),
      db.prepare(`SELECT j.key AS i FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM links
        WHERE domain_id = json_extract(j.value, '$[0]') AND lower(slug_key) = lower(json_extract(j.value, '$[1]')))`)
        .bind(JSON.stringify(lostLocks.map((p) => [p.dom.id, p.key]))),
      db.prepare(`SELECT j.key AS i FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM slug_locks
        WHERE domain_id = json_extract(j.value, '$[0]') AND lower(slug_key) = lower(json_extract(j.value, '$[1]')))`)
        .bind(JSON.stringify(lostLinks.map((p) => [p.dom.id, p.key]))),
    ]);
    const mode = new Map(modes!.results.map((r) => [r.id!, !!r.case_sensitive]));
    const lockedAt = new Set(locked!.results.map((r) => r.i!));
    lostLinks.forEach((p, i) => {
      const reason = mode.get(p.dom.id) !== p.dom.cs ? "mode_changed" : lockedAt.has(i) ? "locked" : null;
      if (reason) report.conflicts.push({ host: p.dom.host, slug: p.slug, reason });
    });
    for (const r of live!.results) { const p = lostLocks[r.i!]!; report.conflicts.push({ host: p.dom.host, slug: p.slug, reason: "exists" }); }
  }

  // Clears cached misses for everything written (errors are swallowed; entries expire by TTL anyway).
  await Promise.all([...doms.values()].map((d) => purgeHost(c.env, d.host)));
  for (const d of doms.values()) {
    const keys = [...plans.link, ...plans.lock].filter((p) => p.dom === d).map((p) => p.key);
    if (keys.length) await purgeMany(c.env, d.id, keys);
  }
  return c.json(report);
});
