import type { Env } from "../env";
import { rowToCf, type CfRow, type DomainRow } from "../types";
import { CfError, createDns, createHostname, createRoute, deleteDns, deleteHostname, deleteRoute, findHostname, findZone, hostnameCount, listDns, listRoutes, type CfConfig, type DnsRecord, type HostnameStatus, type Route } from "./api";
import { deleteHostRule, isForbidden, rlRef, secRef, type Phase } from "./controls";
import { dnsPointsAt } from "./dns";

export class AttachError extends Error {
  constructor(public code: "dns_record_exists" | "dns_not_proxied" | "route_in_use" | "hostname_in_use" | "hostname_limit") {
    super(code);
    this.name = "AttachError";
  }
}

/** CfError 0 with code -1: the API maps it to `outside_not_configured`. */
const notConfigured = () => new CfError(0, [-1]);

/** Cloudflare for SaaS includes this many custom hostnames; each one past it is billed, so linkwarren never creates one there. */
export const FREE_HOSTNAMES = 100;

/**
 * The one mapping from a sync failure to the stable code stored as `last_error` and reported by resync.
 * Never Cloudflare's own text: CfError messages are status-only anyway.
 */
export function syncErrorCode(e: unknown): string {
  if (e instanceof AttachError) return e.code;
  if (!(e instanceof CfError)) return "internal_error";
  if (e.status === 0) return e.codes.includes(-1) ? "outside_not_configured" : "cloudflare_unreachable";
  return e.status === 401 || e.status === 403 ? "cloudflare_forbidden" : "cloudflare_error";
}

export async function classify(cfg: CfConfig, host: string): Promise<{ kind: "account"; zoneId: string; zoneName: string } | { kind: "outside" }> {
  const z = await findZone(cfg, host);
  if (z) return { kind: "account", zoneId: z.id, zoneName: z.name };
  if (!cfg.saasZoneId || !cfg.cnameTarget) throw notConfigured();
  return { kind: "outside" };
}

type IdCol = "zone_id" | "dns_record_id" | "route_id" | "hostname_id";
type Made = Partial<Record<IdCol, string>>;
type Snap = Pick<CfRow, "dns" | "ownership" | "certificate" | "errors">;

const ownershipOf = (s: string): CfRow["ownership"] =>
  s === "active" || s === "active_redeploying" ? "verified" : s === "pending" ? "pending" : ["blocked", "moved", "deleted"].includes(s) ? "failed" : "unknown";
const certificateOf = (s: string | null): CfRow["certificate"] =>
  s === null ? "unknown"
  : s === "active" || s === "backup_issued" ? "issued"
  : /(timed_out|deleted|expired)$/.test(s) || ["pending_deletion", "pending_expiration", "pending_cleanup"].includes(s) ? "failed"
  : s === "initializing" || s.startsWith("pending_") ? "pending"
  : "unknown";

// Only these types serve traffic at the host; TXT, MX and friends never conflict with the placeholder.
const ADDRESS = new Set(["A", "AAAA", "CNAME"]);

/** Whether a Worker route pattern matches requests for `host` (any path). A leading `*` matches as a suffix. */
export function routeCovers(pattern: string, host: string): boolean {
  const hp = pattern.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  return hp.startsWith("*") ? host.endsWith(hp.slice(1)) : hp === host;
}

/**
 * Reads come first and every refusal is thrown before the first write. Ids are recorded the moment
 * linkwarren creates something, so a failure later in the flow still leaves them stored for detach.
 */
export async function syncDomain(env: Env, cfg: CfConfig, d: DomainRow, cf: CfRow, opts: { attach: boolean; confirmTakeover?: boolean }): Promise<CfRow> {
  if (cf.kind === "manual") return cf;
  const made: Made = {};
  let saved: CfRow | null;
  try {
    const snap = cf.kind === "outside" ? await syncOutside(cfg, d.host, cf, made) : await syncAccount(cfg, d.host, cf, opts, made);
    // A read-only check of an active account domain whose attach failed resolves nothing: its error stays until Finish connecting.
    const unresolved = cf.kind === "account" && d.status === "active" && !opts.attach && cf.routeId === null;
    saved = await save(env, d.id, cf, made, { ...snap, errors: JSON.stringify(snap.errors), ...(unresolved ? {} : { last_error: null }), checked_at: Math.floor(Date.now() / 1000) });
  } catch (e) {
    // checked_at moves only on success; updated_at (bumped by save) is what throttles polls.
    const code = syncErrorCode(e);
    if (code === "internal_error") logInternal(d.id, e);
    try {
      await unstored(cfg, d.id, cf, made, await save(env, d.id, cf, made, { last_error: code }));
    } catch {
      // Ids and codes only: never the token or Cloudflare's own text.
      console.warn("linkwarren: could not store domain_cf after a failed sync", JSON.stringify({ domainId: d.id, lastError: code, made }));
    }
    throw e;
  }
  await unstored(cfg, d.id, cf, made, saved);
  if (!saved) throw new CfError(404); // the domain was deleted (rejected) while this sync ran
  return saved;
}

/**
 * Deletes what this sync created but could not store: the row is gone, or another writer's id won the compare-and-set.
 * Only ids from `made` (this call's creates), never one it read. Best-effort: 404 is gone, failures are logged, never thrown.
 */
async function unstored(cfg: CfConfig, domainId: string, cf: CfRow, made: Made, row: CfRow | null): Promise<void> {
  const zone = cf.zoneId ?? made.zone_id ?? null; // the zone this sync used for an account domain
  const stored = { dns_record_id: row?.dnsRecordId, route_id: row?.routeId, hostname_id: row?.hostnameId };
  const del: Record<"dns_record_id" | "route_id" | "hostname_id", (id: string) => Promise<unknown>> = {
    route_id: (id) => deleteRoute(cfg, (cf.kind === "outside" ? cfg.saasZoneId : zone) ?? "", id),
    hostname_id: (id) => deleteHostname(cfg, id),
    dns_record_id: (id) => deleteDns(cfg, zone ?? "", id),
  };
  for (const col of ["route_id", "hostname_id", "dns_record_id"] as const) {
    const id = made[col];
    if (!id || stored[col] === id) continue;
    await del[col](id).catch((e) => console.warn("linkwarren: could not delete an unstored Cloudflare object",
      JSON.stringify({ domainId, [col]: id, error: e instanceof CfError ? e.message : "internal_error" })));
  }
}

type OutsideFacts = { hostname: (HostnameStatus & { id: string }) | null; routes: Route[]; route: Route | null };

/** Reads only: the custom hostname and the SaaS zone's routes for `host`. */
async function inspectOutside(cfg: CfConfig, zoneId: string, host: string): Promise<OutsideFacts> {
  const [hostname, routes] = await Promise.all([findHostname(cfg, host), listRoutes(cfg, zoneId)]);
  return { hostname, routes, route: routes.find((r) => r.pattern === `${host}/*`) ?? null };
}

/**
 * The refusal an outside sync of `host` would throw, or null. Reads only (the hostname count is one GET, only when a create is due).
 * The SaaS zone may serve other things: linkwarren never routes a host another Worker serves, never takes over a custom hostname
 * it does not hold, and never creates a billed hostname past the free quota.
 */
async function outsideRefusal(cfg: CfConfig, host: string, f: OutsideFacts, heldHostnameId: string | null): Promise<AttachError["code"] | null> {
  const covers = f.routes.filter((r) => routeCovers(r.pattern, host));
  // Our own exact route wins over a broader foreign one; without it, any foreign (or script-less) covering route refuses.
  if (f.route ? f.route.script !== cfg.workerName : covers.some((r) => r.script !== cfg.workerName)) return "route_in_use";
  if (f.hostname && f.hostname.id !== heldHostnameId && !covers.some((r) => r.script === cfg.workerName)) return "hostname_in_use";
  if (!f.hostname && (await hostnameCount(cfg)) >= FREE_HOSTNAMES) return "hostname_limit";
  return null;
}

/** Read-only twin of an outside sync for a new domain: the AttachError code syncDomain would throw, or null. Never writes. */
export async function outsideCheck(cfg: CfConfig, host: string): Promise<AttachError["code"] | null> {
  if (!cfg.saasZoneId || !cfg.cnameTarget) throw notConfigured();
  return outsideRefusal(cfg, host, await inspectOutside(cfg, cfg.saasZoneId, host), null);
}

async function syncOutside(cfg: CfConfig, host: string, cf: CfRow, made: Made): Promise<Snap> {
  if (!cfg.saasZoneId || !cfg.cnameTarget) throw notConfigured();
  const f = await inspectOutside(cfg, cfg.saasZoneId, host);
  const code = await outsideRefusal(cfg, host, f, cf.hostnameId);
  if (code) throw new AttachError(code);
  let h = f.hostname;
  if (!h) made.hostname_id = (h = await createHostname(cfg, host)).id;
  if (!f.route) made.route_id = (await createRoute(cfg, cfg.saasZoneId, `${host}/*`)).id;
  return { dns: await dnsPointsAt(host, cfg.cnameTarget), ownership: ownershipOf(h.status), certificate: certificateOf(h.sslStatus), errors: h.errors };
}

type AccountFacts = { records: DnsRecord[]; covering: DnsRecord[]; delegated: boolean; routes: Route[]; route: Route | null };

/** Reads only: what is at `host` in its zone (records, closest wildcard, NS delegation, routes). */
async function inspectAccount(cfg: CfConfig, host: string, zone: { id: string; name: string }): Promise<AccountFacts> {
  const atHost = await listDns(cfg, zone.id, host);
  const records = atHost.filter((r) => ADDRESS.has(r.type));
  // Ancestors inside the zone, closest first, ending at the apex: a.b.owned.test -> b.owned.test, owned.test.
  const ancestors: string[] = [];
  for (let p = host; p !== zone.name && p.endsWith("." + zone.name); ancestors.push(p)) p = p.slice(p.indexOf(".") + 1);
  // shortcut: the closest wildcard counts even when a closer non-wildcard name exists (DNS would not use it then); errs toward asking.
  const [wilds, mids] = await Promise.all([
    Promise.all(ancestors.map((p) => listDns(cfg, zone.id, `*.${p}`))),
    Promise.all(ancestors.slice(0, -1).map((p) => listDns(cfg, zone.id, p))), // NS at the apex is the zone's own
  ]);
  const wild = wilds.map((l) => l.filter((r) => ADDRESS.has(r.type))).find((l) => l.length) ?? [];
  // NS at the host or any label below the apex delegates the name to other nameservers.
  const delegated = [atHost, ...mids].some((l) => l.some((r) => r.type === "NS"));
  const routes = await listRoutes(cfg, zone.id);
  const pattern = `${host}/*`;
  return { records, covering: records.length ? records : wild, delegated, routes, route: routes.find((r) => r.pattern === pattern) ?? null };
}

/** The refusal an attach of `host` would throw, or null. Pure, so the pre-insert check and syncDomain cannot drift. */
function refusal(cfg: CfConfig, host: string, f: AccountFacts, o: { confirmTakeover?: boolean; ownRecordId: string | null; attached: boolean }): AttachError["code"] | null {
  // A delegated subdomain is served by other nameservers: no confirmation can make the placeholder visible.
  if (f.delegated || f.covering.some((r) => !r.proxied)) return "dns_not_proxied";
  const onlyOurs = f.records.length === 1 && f.records[0]!.id === o.ownRecordId;
  if (f.covering.length > 0 && !onlyOurs && !o.confirmTakeover && !o.attached) return "dns_record_exists";
  if (f.routes.some((r) => routeCovers(r.pattern, host) && r.script !== cfg.workerName)) return "route_in_use";
  return null;
}

/** Read-only twin of a fresh attach: the AttachError code syncDomain would throw for `host`, or null. Never writes. */
export async function takeoverCheck(cfg: CfConfig, host: string, zone: { id: string; name: string }, confirmTakeover = false): Promise<AttachError["code"] | null> {
  return refusal(cfg, host, await inspectAccount(cfg, host, zone), { confirmTakeover, ownRecordId: null, attached: false });
}

async function syncAccount(cfg: CfConfig, host: string, cf: CfRow, opts: { attach: boolean; confirmTakeover?: boolean }, made: Made): Promise<Snap> {
  const z = await findZone(cfg, host);
  if (!z) throw new CfError(404); // the zone left the account
  const zoneId = cf.zoneId ?? z.id;
  if (!cf.zoneId) made.zone_id = zoneId;
  const f = await inspectAccount(cfg, host, { id: zoneId, name: z.name });
  const { covering, delegated, route } = f;
  // A stored route means an attach already succeeded (and any takeover was confirmed then): keep it repaired.
  const attached = cf.routeId !== null;
  const attach = opts.attach || attached;
  if (attach) {
    const code = refusal(cfg, host, f, { confirmTakeover: opts.confirmTakeover, ownRecordId: cf.dnsRecordId, attached });
    if (code) throw new AttachError(code);
    // Repair only re-creates a placeholder we had; it never adds a record next to the owner's takeover.
    if (covering.length === 0 && (opts.attach || cf.dnsRecordId !== null)) {
      const rec = await createDns(cfg, zoneId, host);
      made.dns_record_id = rec.id;
      covering.push(rec);
    }
    if (!route) made.route_id = (await createRoute(cfg, zoneId, `${host}/*`)).id;
  }
  return {
    dns: covering.some((r) => r.proxied) ? "found" : covering.length || delegated ? "wrong_target" : "missing",
    // A route to this worker that someone else made also serves the host, so it reads as verified (never adopted).
    ownership: attach || route?.script === cfg.workerName ? "verified" : "pending",
    // Universal SSL covers the apex and one label below it.
    certificate: host.split(".").length - z.name.split(".").length <= 1 ? "issued" : "not_covered",
    errors: [],
  };
}

/** A bug, not a Cloudflare answer: name and a capped message only (CfError messages are code-only, the token lives in a header). */
export function logInternal(domainId: string, e: unknown): void {
  const err = e as { name?: unknown; message?: unknown } | null;
  console.error("linkwarren: internal error during domain sync", JSON.stringify({ domainId, name: String(err?.name), message: String(err?.message).slice(0, 200) }));
}

/** One UPDATE. Each id is compare-and-set against the value this sync read, so a concurrent writer's id is never overwritten. */
/** Null when no domain_cf row matched (the domain was deleted). */
async function save(env: Env, id: string, cf: CfRow, made: Made, fields: Record<string, string | number | null>): Promise<CfRow | null> {
  const read: Record<IdCol, string | null> = { zone_id: cf.zoneId, dns_record_id: cf.dnsRecordId, route_id: cf.routeId, hostname_id: cf.hostnameId };
  const set = Object.keys(fields).map((k) => `${k} = ?`);
  const binds: (string | number | null)[] = Object.values(fields);
  for (const [k, v] of Object.entries(made) as [IdCol, string][]) {
    set.push(`${k} = CASE WHEN ${k} IS ? THEN ? ELSE ${k} END`);
    binds.push(read[k], v);
  }
  const row = await env.DB.prepare(`UPDATE domain_cf SET ${set.join(", ")}, updated_at = ? WHERE domain_id = ? RETURNING *`)
    .bind(...binds, Math.floor(Date.now() / 1000), id).first();
  return row ? rowToCf(row) : null;
}

/** Deletes only ids linkwarren stored; 404 counts as already gone (Task 3 client). Any other failure rejects before later steps. */
export async function detachDomain(_env: Env, cfg: CfConfig, d: DomainRow, cf: CfRow): Promise<void> {
  if (cf.kind === "manual") return;
  // Our ruleset rules go first, matched by ref, so a foreign rule is never touched.
  if (cf.kind === "account" && cf.zoneId) {
    const rules: [Phase, string, unknown][] = [["http_config_settings", secRef(d.id), cf.securityLevel], ["http_ratelimit", rlRef(d.id), cf.rateLimit]];
    for (const [phase, ref, stored] of rules) {
      try {
        await deleteHostRule(cfg, cf.zoneId, phase, ref);
      } catch (e) {
        // A token without the optional rules permission cannot have made a rule we never stored: nothing to remove.
        if (!(stored === null && isForbidden(e))) throw e;
      }
    }
  }
  const routeZone = cf.kind === "outside" ? cfg.saasZoneId : cf.zoneId;
  if (cf.routeId) {
    if (!routeZone) throw new CfError(0);
    await deleteRoute(cfg, routeZone, cf.routeId);
  }
  if (cf.hostnameId) await deleteHostname(cfg, cf.hostnameId);
  if (cf.dnsRecordId) {
    if (!cf.zoneId) throw new CfError(0);
    await deleteDns(cfg, cf.zoneId, cf.dnsRecordId);
  }
}

/** R5: outside needs all three green; account needs a successful attach; manual keeps S1 behaviour. */
export function isVerified(cf: CfRow): boolean {
  if (cf.kind === "manual") return true;
  if (cf.lastError || cf.dns !== "found" || cf.ownership !== "verified") return false;
  return cf.kind === "account" || cf.certificate === "issued";
}
