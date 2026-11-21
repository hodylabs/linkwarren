import { invalidateHost, invalidateLink } from "../cache";
import type { Env } from "../env";
import { rowToDomain, type DomainRow } from "../types";
import { checkDestination } from "../validate";

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

/** Validates the destination and returns the normalized href, or an error code. */
export async function destination(env: Env, raw: string): Promise<{ href: string } | { error: string }> {
  const r = checkDestination(raw, [...(await allHosts(env)), env.DASHBOARD_HOST, ...(env.CF_CNAME_TARGET ? [env.CF_CNAME_TARGET] : [])]);
  if (!r.ok) return { error: r.reason === "too_long" ? "url_too_long" : r.reason };
  if (r.url.href.length > 2048) return { error: "url_too_long" };
  return { href: r.url.href };
}

/** Links (any domain) whose destination points at `host` on any scheme or port; they would loop once it is active. substr compare, not LIKE: D1 rejects LIKE patterns over 50 bytes and hosts reach 253. */
export async function loopLinks(env: Env, host: string): Promise<number> {
  const p = ["http", "https"].flatMap((s) => [`${s}://${host}/`, `${s}://${host}:`]);
  const r = await env.DB.prepare(`SELECT COUNT(*) n FROM links WHERE ${p.map(() => "substr(url, 1, ?) = ?").join(" OR ")}`)
    .bind(...p.flatMap((x) => [x.length, x])).first<{ n: number }>();
  return r?.n ?? 0;
}

/** For responses after a committed write: a failed count omits the field instead of turning the write into a 500. */
export const loopField = (env: Env, host: string) =>
  loopLinks(env, host).then((loopLinks) => ({ loopLinks }), (e) => { console.warn("loopLinks failed", String(e)); return {}; });
