import type { Env } from "./env";
export type Ctx = { waitUntil(p: Promise<unknown>): void };
import { type DomainRow, type LinkRow, rowToDomain, rowToLink } from "./types";

const POSITIVE_TTL = 300;
const NEGATIVE_TTL = 60; // KV minimum is 60

const hostKey = (host: string) => `h:${host}`;
// l2: the cached row gained passwordHash and routes (S5); old l: entries are never read and expire on their TTL.
const linkKey = (domainId: string, key: string) => `l2:${domainId}:${key}`;

// KV holds JSON; a stored `null` is a cached miss.
// Cache failures never break a lookup: a failed get falls through to D1, a failed put is dropped.
async function cached<T>(env: Env, key: string, load: () => Promise<T | null>, ctx?: Ctx): Promise<T | null> {
  try {
    const hit = await env.CACHE.get(key, "text");
    if (hit !== null) return JSON.parse(hit) as T | null;
  } catch {}
  const v = await load();
  const put = Promise.resolve()
    .then(() => env.CACHE.put(key, JSON.stringify(v), { expirationTtl: v ? POSITIVE_TTL : NEGATIVE_TTL }))
    .catch(() => {});
  if (ctx) ctx.waitUntil(put);
  else await put;
  return v;
}

export const getDomainByHost = (env: Env, host: string, ctx?: Ctx): Promise<DomainRow | null> =>
  cached(env, hostKey(host), async () => {
    const r = await env.DB.prepare("SELECT * FROM domains WHERE host = ?").bind(host).first();
    return r ? rowToDomain(r) : null;
  }, ctx);

export const getLink = (env: Env, domainId: string, key: string, ctx?: Ctx): Promise<LinkRow | null> =>
  cached(env, linkKey(domainId, key), async () => {
    const r = await env.DB.prepare("SELECT * FROM links WHERE domain_id = ? AND slug_key = ?").bind(domainId, key).first();
    return r ? rowToLink(r) : null;
  }, ctx);

export const invalidateHost = (env: Env, host: string) => env.CACHE.delete(hostKey(host));
export const invalidateLink = (env: Env, domainId: string, key: string) => env.CACHE.delete(linkKey(domainId, key));
