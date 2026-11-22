import { invalidateHost, invalidateLink } from "../cache";
import { cnameTarget } from "../cf/api";
import type { Env } from "../env";
import { rowToDomain, type DomainRow } from "../types";
import { checkDestination } from "../validate";

/**
 * The JSON-only 415 guard (best effort). "Has a body" is decided from headers: browsers send content-length: 0 on bodyless
 * DELETE/POST, and Workers then expose a non-null empty stream.
 */
export function nonJsonBody(req: { header(name: string): string | undefined }): boolean {
  const hasBody = Number(req.header("content-length") ?? 0) > 0 || req.header("transfer-encoding") !== undefined;
  return hasBody && !/^application\/json\s*(;|$)/i.test(req.header("content-type") ?? "");
}

export const getDomain = async (env: Env, id: string): Promise<DomainRow | null> => {
  const r = await env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first();
  return r ? rowToDomain(r) : null;
};
export const isMember = async (env: Env, domainId: string, userId: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM domain_members WHERE domain_id = ? AND user_id = ?").bind(domainId, userId).first());
// Active only: a pending or disabled domain does not serve, so a link to it is not a loop (yet).
export const allHosts = async (env: Env) =>
  (await env.DB.prepare("SELECT host FROM domains WHERE status = 'active'").all<{ host: string }>()).results.map((r) => r.host);

// A failed purge must not turn a committed write into a 500; entries expire by TTL anyway.
const swallow = (p: Promise<unknown>) => p.catch((e) => console.warn("cache invalidate failed", String(e)));
export const purge = (env: Env, domainId: string, key: string) => swallow(invalidateLink(env, domainId, key));
export const purgeHost = (env: Env, host: string) => swallow(invalidateHost(env, host));
export const purgeMany = (env: Env, domainId: string, keys: string[]) =>
  swallow(Promise.all(keys.map((k) => invalidateLink(env, domainId, k))));

/**
 * Validates the destination and returns the normalized href, or an error code. `also`: more hosts that count as short hosts.
 * `hosts`: the allHosts list already read in this request (saves one D1 read per call).
 */
export async function destination(env: Env, raw: string, also: string[] = [], hosts?: string[]): Promise<{ href: string } | { error: string }> {
  const target = cnameTarget(env);
  const r = checkDestination(raw, [...(hosts ?? (await allHosts(env))), env.DASHBOARD_HOST, ...(target ? [target] : []), ...also]);
  if (!r.ok) return { error: r.reason === "too_long" ? "url_too_long" : r.reason };
  if (r.url.href.length > 2048) return { error: "url_too_long" };
  return { href: r.url.href };
}

/**
 * Links (any domain) whose destination points at `host` on any scheme or port, with or without the trailing dot (validation ignores
 * it, stored URLs keep it); they would loop once it is active. substr compare, not LIKE: D1 rejects LIKE patterns over 50 bytes and hosts reach 253.
 */
export async function loopLinks(env: Env, host: string): Promise<number> {
  const p = ["http", "https"].flatMap((s) => [host, `${host}.`].flatMap((h) => [`${s}://${h}/`, `${s}://${h}:`]));
  const r = await env.DB.prepare(`SELECT COUNT(*) n FROM links WHERE ${p.map(() => "substr(url, 1, ?) = ?").join(" OR ")}`)
    .bind(...p.flatMap((x) => [x.length, x])).first<{ n: number }>();
  return r?.n ?? 0;
}

// Longer than the slowest Cloudflare-then-D1 flow (each call times out at 10 s); a crashed request blocks the domain at most this long.
const LEASE_S = 120;
/**
 * The fencing token of a held lease. `sql`/`binds` guard a D1 statement on it, so a holder whose lease expired and was
 * reclaimed writes nothing; `held` checks it before a Cloudflare write.
 */
export type Lease = { sql: string; binds: unknown[]; held: () => Promise<boolean> };
/**
 * Runs `fn` holding the domain's lease, or returns null when another approve, reject or controls change holds it.
 * These flows write Cloudflare first and D1 after, so two of them interleaving could leave the two stores disagreeing.
 * An expired lease can be reclaimed while its holder still runs, so every write `fn` makes must be guarded on the lease.
 */
export async function withDomainLock(env: Env, domainId: string, fn: (lease: Lease) => Promise<Response>): Promise<Response | null> {
  const key = `domain:${domainId}`, token = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  const got = await env.DB.prepare(
    "INSERT INTO locks (key, token, until) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET token = excluded.token, until = excluded.until WHERE locks.until <= ?",
  ).bind(key, token, now + LEASE_S, now).run();
  if (!got.meta.changes) return null;
  const sql = "EXISTS (SELECT 1 FROM locks WHERE key = ? AND token = ?)";
  const held = async () => !!(await env.DB.prepare(`SELECT ${sql} AS ok`).bind(key, token).first<{ ok: number }>())?.ok;
  try {
    return await fn({ sql, binds: [key, token], held });
  } finally {
    // Our token only: a lease another request reclaimed stays theirs.
    await env.DB.prepare("DELETE FROM locks WHERE key = ? AND token = ?").bind(key, token).run()
      .catch((e) => console.warn("linkwarren: could not release a domain lock", JSON.stringify({ domainId, error: String(e).slice(0, 200) })));
  }
}

/** For responses after a committed write: a failed count omits the field instead of turning the write into a 500. */
export const loopField = (env: Env, host: string) =>
  loopLinks(env, host).then((loopLinks) => ({ loopLinks }), (e) => { console.warn("loopLinks failed", String(e)); return {}; });
