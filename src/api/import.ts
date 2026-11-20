import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { rowToDomain, type DomainRow, type UserRow } from "../types";
import { checkDestination, checkSlugShape, slugKey } from "../validate";
import { hostError } from "./domains";
import { purgeHost, purgeMany } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const importApi = new Hono<E>();

const MAX_LINKS = 1000;
const CHUNK = 100; // statements per D1 batch

const body = z.object({
  mainHost: z.string().min(1),
  domains: z.array(z.object({
    host: z.string(), customIndexUrl: z.string().nullable().optional(), customNotFoundUrl: z.string().nullable().optional(),
  })).max(MAX_LINKS),
  links: z.array(z.object({
    host: z.string().nullable(), slug: z.string(), destination: z.string(), enabled: z.boolean(),
    startDate: z.string().nullable().optional(), endDate: z.string().nullable().optional(),
  })),
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
  if (user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const b = parsed.data;
  if (b.links.length > MAX_LINKS) return c.json({ error: "too_many" }, 400);
  const dry = c.req.query("dryRun") === "1";
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
  for (const d of doms.values()) {
    live.set(d.id, new Map()); locks.set(d.id, new Set());
    if (d.isNew) continue;
    for (const r of (await c.env.DB.prepare("SELECT slug_key, url FROM links WHERE domain_id = ?").bind(d.id).all<{ slug_key: string; url: string }>()).results) live.get(d.id)!.set(r.slug_key, r.url);
    for (const r of (await c.env.DB.prepare("SELECT slug_key FROM slug_locks WHERE domain_id = ?").bind(d.id).all<{ slug_key: string }>()).results) locks.get(d.id)!.add(r.slug_key.toLowerCase());
  }

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
    if (!l.enabled) { disabled.push(i); return; }
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
    if (liveLower.get(dom.id)!.has(key.toLowerCase())) { conflict(i, "exists"); continue; }
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
  };
  if (dry) return c.json(report);

  const now = Math.floor(Date.now() / 1000);
  const db = c.env.DB;
  const counted = new Set<number>(); // indexes of link/lock inserts, whose meta.changes is the real created count
  const stmts: D1PreparedStatement[] = [
    auditStmt(c.env, { actorId: user.id, action: "import.run", targetType: "import", targetId: "legacy",
      detail: { created: planned, skipped, conflicts: conflicts.length, domainsCreated: report.domainsCreated } }),
  ];
  for (const d of newDoms) {
    stmts.push(db.prepare(
      "INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,notfound_redirect,case_sensitive,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(d.id, d.host, "private", "active", user.id, d.bare, d.nf, d.cs ? 1 : 0, now));
  }
  for (const d of doms.values()) {
    // Fill only while still null, so a concurrent edit is never clobbered.
    if (d.fillBare) stmts.push(db.prepare("UPDATE domains SET bare_redirect = ? WHERE id = ? AND bare_redirect IS NULL").bind(d.bare, d.id));
    if (d.fillNf) stmts.push(db.prepare("UPDATE domains SET notfound_redirect = ? WHERE id = ? AND notfound_redirect IS NULL").bind(d.nf, d.id));
  }
  for (const p of plans.link) {
    counted.add(stmts.length);
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,created_by,updated_by,created_at,updated_at)
       SELECT ?,?,?,?,?,302,?,?,1,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slug_locks WHERE domain_id = ? AND lower(slug_key) = lower(?))`,
    ).bind(crypto.randomUUID(), p.dom.id, p.slug, p.key, p.url, p.startsAt, p.expiresAt, user.id, user.id, now, now, p.dom.id, p.key));
  }
  for (const p of plans.lock) {
    counted.add(stmts.length);
    stmts.push(db.prepare("INSERT OR IGNORE INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES (?,?,?,?)").bind(p.dom.id, p.key, now, user.id));
  }
  let inserted = 0; // INSERT OR IGNORE can lose a race; report what was really written
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const res = await db.batch(stmts.slice(i, i + CHUNK));
    res.forEach((r, k) => { if (counted.has(i + k)) inserted += r.meta.changes; });
  }
  report.created = inserted;

  // Clears cached misses for everything written (errors are swallowed; entries expire by TTL anyway).
  await Promise.all([...doms.values()].map((d) => purgeHost(c.env, d.host)));
  for (const d of doms.values()) {
    const keys = [...plans.link, ...plans.lock].filter((p) => p.dom === d).map((p) => p.key);
    if (keys.length) await purgeMany(c.env, d.id, keys);
  }
  return c.json(report);
});
