import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { hostError, normalizeHost } from "../host";
import { parseSettings, settingsQ } from "../settings";
import { rowToDomain, type DomainRow, type UserRow } from "../types";
import { canManageDomain, usableDomainsSql } from "../perm";
import { actorCan, can, type Guard } from "../roles";
import { checkDestination, checkLinkName, checkSlugShape, slugKey } from "../validate";
import { reservedSlugs } from "../dash";
import { isLegacyHost, refusedDashboard } from "./domains";
import { purgeHost, purgeMany } from "./shared";
import { cardOf, vcardSchema } from "./links";
import { VCARD_URL, vcardData, type VCard } from "../vcard";

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
    // S9: a contact card (a vCard link); its destination is ignored.
    vcard: vcardSchema.optional(),
    // S12: the optional link name (checked like the API: trimmed, 100 characters, no control characters).
    name: z.string().max(1000).nullable().optional(),
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

/** What makes two cards the same for skip-or-conflict: the stored data and photo (the live-link query builds the same string in SQL). */
function cardKey(v: VCard): string {
  return `${VCARD_URL}#${vcardData(v)}#${v.photo ?? ""}`;
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
    if (isLegacyHost(c.env, h)) { badHost.set(h, "legacy_dashboard_host"); continue; }
    // The dashboard host: never in host mode; in path mode only as an existing main domain (import creates private ones).
    const dashErr = h !== dashboard ? null : refusedDashboard(c.env) !== null ? "dashboard_host" : row?.type === "main" ? null : "dashboard_main_only";
    if (dashErr) { badHost.set(h, dashErr); continue; }
    if (row) { doms.set(h, { id: row.id, host: h, isNew: false, cs: row.caseSensitive, bare: row.bareRedirect, nf: row.notfoundRedirect, fillBare: false, fillNf: false }); continue; }
    const err = hostError(h, null);
    if (err) { badHost.set(h, err); continue; }
    doms.set(h, { id: crypto.randomUUID(), host: h, isNew: true, cs: hasTwins(h), bare: null, nf: null, fillBare: false, fillNf: false });
  }

  // Destinations may not point at any short host, existing or about to be created.
  const shortHosts = [...existing.keys(), ...[...doms.values()].filter((d) => d.isNew).map((d) => d.host), dashboard];
  // Domain redirects are web-only, as in the domain settings; links may also be tel: or mailto:.
  const dest = (raw: string, webOnly = false): string | null => {
    const r = checkDestination(raw, shortHosts, { webOnly });
    return r.ok && r.url.href.length <= 2048 ? r.url.href : null;
  };
  const ignored: { host: string; field: string }[] = [];
  for (const d of b.domains) {
    const dom = doms.get(normalizeHost(d.host));
    if (!dom) continue;
    for (const [field, raw, cur] of [["customIndexUrl", d.customIndexUrl, "bare"], ["customNotFoundUrl", d.customNotFoundUrl, "nf"]] as const) {
      if (!raw) continue;
      const href = dest(raw, true);
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
  // The exact keys a card row of this request asks for on a reused domain: only those cards' data and photos are read (a domain may
  // hold thousands of cards with photos up to 64 KB each; reading them all could exceed the Worker's memory).
  const cardKeys = JSON.stringify(b.links.flatMap((l) => {
    const d = l.vcard ? doms.get(hostOf(l.host)) : undefined;
    return d && !d.isNew ? [[d.id, slugKey(l.slug, d.cs)]] : [];
  }));
  const [liveRows, lockRows, setRows, usableRows] = await c.env.DB.batch<{ domain_id: string; slug_key: string; url?: string; id?: string }>([
    // A requested card compares by its contents (the same string cardKey builds); every other link by its url (a card's is the placeholder).
    c.env.DB.prepare(`SELECT links.domain_id, links.slug_key, CASE WHEN v.link_id IS NOT NULL THEN '${VCARD_URL}#' || v.data || '#' || coalesce(v.photo, '')
      ELSE links.url END AS url FROM links LEFT JOIN vcards v ON v.link_id = links.id AND links.kind = 'vcard'
        AND EXISTS (SELECT 1 FROM json_each(?) k WHERE json_extract(k.value, '$[0]') = links.domain_id AND json_extract(k.value, '$[1]') = links.slug_key)
      WHERE links.domain_id IN (SELECT value FROM json_each(?))`).bind(cardKeys, reused),
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

  type Plan = { dom: Dom; slug: string; key: string; url: string; name?: string | null; startsAt: number | null; expiresAt: number | null; vcard?: VCard };
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
    // R4: the dashboard's path segment on its host, any case; checked before the disabled split so locks are refused too.
    if (reservedSlugs(c.env, host).includes(l.slug.toLowerCase())) return conflict(i, "reserved_path");
    if (!dom.cs && isTwin(host, l.slug)) return conflict(i, "case_twin");
    if (!l.enabled || l.protected) { disabled.push(i); return; }
    const nm = checkLinkName(l.name ?? null);
    if (!nm.ok) return conflict(i, "bad_link_name");
    const card = l.vcard ? cardOf(l.vcard) : null;
    if (card && "error" in card) return conflict(i, "invalid_vcard");
    const href = card ? VCARD_URL : dest(l.destination);
    // The card placeholder is never a live destination (an exported card row with its url kept would redirect to it).
    if (!href || (!card && new URL(href).hostname === new URL(VCARD_URL).hostname)) return conflict(i, "invalid_destination");
    const startsAt = parseDate(l.startDate), expiresAt = parseDate(l.endDate);
    if (startsAt === undefined || expiresAt === undefined || (startsAt !== null && expiresAt !== null && expiresAt <= startsAt)) return conflict(i, "bad_date");
    const key = slugKey(l.slug, dom.cs);
    // A card is the same only with the same contents (the url is one placeholder for every card): see cardKey.
    const same = card ? cardKey(card.vcard) : href;
    const have = live.get(dom.id)!.get(key);
    if (have !== undefined) { out[i] = have === same ? { kind: "skip" } : { kind: "conflict", reason: "exists" }; return; }
    if (locks.get(dom.id)!.has(key.toLowerCase())) return conflict(i, "locked");
    live.get(dom.id)!.set(key, same);
    plans.link.push({ dom, slug: l.slug, key, url: href, name: nm.name, startsAt, expiresAt, ...(card ? { vcard: card.vcard } : {}) });
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
  // (links, locks) or usable and managed (redirects). A chunk whose audit guard fails wrote nothing and ends the import with 403.
  const may = actorCan(user.id, "data"), mgr = actorCan(user.id, "domains.manage");
  const use = (domainId: string): Guard => ({ sql: `${may.sql} AND ? IN (${usableDomainsSql})`, binds: [...may.binds, domainId, user.id] });
  // Work statements carry their kind and host so each D1 batch can audit exactly what it touches. Each is SQL ending in its
  // WHERE plus binds, prepared per chunk so the chunk's own guard can be added to every write in it.
  type Work = { sql: string; binds: unknown[]; kind: "domain" | "fill" | "link" | "lock" | "vcard"; host: string; counted: boolean; plan?: Plan };
  const work: Work[] = [];
  for (const d of newDoms) {
    work.push({ kind: "domain", host: d.host, counted: false,
      sql: `INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,notfound_redirect,case_sensitive,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${may.sql} AND ${mgr.sql}`,
      binds: [d.id, d.host, "private", "active", user.id, d.bare, d.nf, d.cs ? 1 : 0, now, ...may.binds, ...mgr.binds] });
  }
  for (const d of doms.values()) {
    // Fill only while still null, so a concurrent edit is never clobbered; usable and managed now, as planning required.
    const u = use(d.id), manage = `${u.sql} AND (owner_id = ? OR ${mgr.sql})`, mb = [...u.binds, user.id, ...mgr.binds];
    if (d.fillBare) work.push({ kind: "fill", host: d.host, counted: false, sql: `UPDATE domains SET bare_redirect = ? WHERE id = ? AND bare_redirect IS NULL AND ${manage}`, binds: [d.bare, d.id, ...mb] });
    if (d.fillNf) work.push({ kind: "fill", host: d.host, counted: false, sql: `UPDATE domains SET notfound_redirect = ? WHERE id = ? AND notfound_redirect IS NULL AND ${manage}`, binds: [d.nf, d.id, ...mb] });
  }
  // The slug key was computed from the case mode read at planning time; insert only while the domain still has it.
  for (const p of plans.link) {
    const id = crypto.randomUUID();
    work.push({ kind: "link", host: p.dom.host, counted: true, plan: p,
      sql: `INSERT OR IGNORE INTO links (id,domain_id,slug,slug_key,url,name,redirect_code,starts_at,expires_at,pass_query,kind,created_by,updated_by,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?))
       AND EXISTS (SELECT 1 FROM domains WHERE id = ? AND case_sensitive = ?) AND ${use(p.dom.id).sql}`,
      binds: [id, p.dom.id, p.slug, p.key, p.url, p.name ?? null, p.vcard ? 302 : defaults.linkRedirectCode, p.startsAt, p.expiresAt, defaults.linkPassQuery ? 1 : 0, p.vcard ? "vcard" : "url",
        user.id, user.id, now, now, p.dom.id, p.key, p.dom.id, p.dom.cs ? 1 : 0, ...use(p.dom.id).binds] });
    // The card right after its link, only if that insert ran (a fresh id); never counted on its own.
    if (p.vcard) work.push({ kind: "vcard", host: p.dom.host, counted: false,
      sql: "INSERT INTO vcards (link_id, data, photo) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM links WHERE id = ?)",
      binds: [id, vcardData(p.vcard), p.vcard.photo, id] });
  }
  // A live link committed after planning wins its key over a planned lock.
  for (const p of plans.lock) {
    work.push({ kind: "lock", host: p.dom.host, counted: true, plan: p,
      sql: `INSERT OR IGNORE INTO slug_locks (domain_id,slug_key,locked_at,locked_by)
       SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM links WHERE domain_id = ? AND lower(slug_key) = lower(?)) AND ${use(p.dom.id).sql}`,
      binds: [p.dom.id, p.key, now, user.id, p.dom.id, p.key, ...use(p.dom.id).binds] });
  }
  const runAudit = (g: Guard) => auditStmt(c.env, { actorId: user.id, action: "import.run", targetType: "import", targetId: "file",
    detail: { planned, skipped, conflicts: conflicts.length, domainsCreated: report.domainsCreated } }, g);
  let inserted = 0; // INSERT OR IGNORE can lose a race; report what was really written
  const lostLinks: Plan[] = [], lostLocks: Plan[] = [];
  const SIZE = CHUNK - 2; // room for the run row (first batch) and the chunk row
  // One batch even with no work (the run row), as before.
  for (let i = 0, end = 0, first = true; first || i < work.length; i = end, first = false) {
    // A card never starts a batch: it is written in the same batch as its link, so a failed batch never leaves a link without its card.
    end = Math.min(i + SIZE, work.length);
    if (work[end]?.kind === "vcard") end--;
    const part = work.slice(i, end);
    const n = (k: Work["kind"]) => part.filter((w) => w.kind === k).length;
    // A chunk that adds a domain needs domains.manage for all of it: every write carries that guard too, so a loss refuses
    // the whole chunk (audit included) rather than letting its links land unaudited behind a 403.
    const strict = n("domain") > 0;
    const g: Guard = strict ? { sql: `${may.sql} AND ${mgr.sql}`, binds: [...may.binds, ...mgr.binds] } : may;
    const prep = (w: Work) => db.prepare(strict ? `${w.sql} AND ${mgr.sql}` : w.sql).bind(...w.binds, ...(strict ? mgr.binds : []));
    const chunkAudit = auditStmt(c.env, { actorId: user.id, action: "import.chunk", targetType: "import", targetId: "file",
      detail: { hosts: [...new Set(part.map((w) => w.host))], domains: n("domain"), links: n("link"), locks: n("lock") } }, g);
    const res = await db.batch([...(i === 0 ? [runAudit(g)] : []), chunkAudit, ...part.map(prep)]);
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

  // Explain the writes a guard refused: the domain no longer usable (forbidden), a changed case mode, or a slug that went live before its lock.
  // Other lost races (a concurrent identical link or lock) stay uncounted, as before.
  if (lostLinks.length || lostLocks.length) {
    const [modes, live, locked, usableNow] = await db.batch<{ id?: string; case_sensitive?: number; i?: number }>([
      db.prepare("SELECT id, case_sensitive FROM domains WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(lostLinks.map((p) => p.dom.id))),
      db.prepare(`SELECT j.key AS i FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM links
        WHERE domain_id = json_extract(j.value, '$[0]') AND lower(slug_key) = lower(json_extract(j.value, '$[1]')))`)
        .bind(JSON.stringify(lostLocks.map((p) => [p.dom.id, p.key]))),
      db.prepare(`SELECT j.key AS i FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM slug_locks
        WHERE domain_id = json_extract(j.value, '$[0]') AND lower(slug_key) = lower(json_extract(j.value, '$[1]')))`)
        .bind(JSON.stringify(lostLinks.map((p) => [p.dom.id, p.key]))),
      db.prepare(usableDomainsSql).bind(user.id),
    ]);
    const ok = new Set(usableNow!.results.map((r) => r.id!));
    const mode = new Map(modes!.results.map((r) => [r.id!, !!r.case_sensitive]));
    const lockedAt = new Set(locked!.results.map((r) => r.i!));
    lostLinks.forEach((p, i) => {
      const reason = !ok.has(p.dom.id) ? "forbidden" : mode.get(p.dom.id) !== p.dom.cs ? "mode_changed" : lockedAt.has(i) ? "locked" : null;
      if (reason) report.conflicts.push({ host: p.dom.host, slug: p.slug, reason });
    });
    const liveAt = new Set(live!.results.map((r) => r.i!));
    lostLocks.forEach((p, i) => {
      const reason = !ok.has(p.dom.id) ? "forbidden" : liveAt.has(i) ? "exists" : null;
      if (reason) report.conflicts.push({ host: p.dom.host, slug: p.slug, reason });
    });
  }

  // Clears cached misses for everything written (errors are swallowed; entries expire by TTL anyway).
  await Promise.all([...doms.values()].map((d) => purgeHost(c.env, d.host)));
  for (const d of doms.values()) {
    const keys = [...plans.link, ...plans.lock].filter((p) => p.dom === d).map((p) => p.key);
    if (keys.length) await purgeMany(c.env, d.id, keys);
  }
  return c.json(report);
});
