import type { Env } from "./env";
import { type DomainRow, type LinkRow, rowToDomain, rowToLink } from "./types";

const POSITIVE_TTL = 300;
const NEGATIVE_TTL = 60; // KV minimum is 60

const hostKey = (host: string) => `h:${host}`;
const linkKey = (domainId: string, key: string) => `l:${domainId}:${key}`;

// KV holds JSON; a stored `null` is a cached miss.
async function cached<T>(env: Env, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = await env.CACHE.get(key, "text");
  if (hit !== null) return JSON.parse(hit) as T | null;
  const v = await load();
  await env.CACHE.put(key, JSON.stringify(v), { expirationTtl: v ? POSITIVE_TTL : NEGATIVE_TTL });
  return v;
}

export const getDomainByHost = (env: Env, host: string): Promise<DomainRow | null> =>
  cached(env, hostKey(host), async () => {
    const r = await env.DB.prepare("SELECT * FROM domains WHERE host = ?").bind(host).first();
    return r ? rowToDomain(r) : null;
  });

export const getLink = (env: Env, domainId: string, key: string): Promise<LinkRow | null> =>
  cached(env, linkKey(domainId, key), async () => {
    const r = await env.DB.prepare("SELECT * FROM links WHERE domain_id = ? AND slug_key = ?").bind(domainId, key).first();
    return r ? rowToLink(r) : null;
  });

export const invalidateHost = (env: Env, host: string) => env.CACHE.delete(hostKey(host));
export const invalidateLink = (env: Env, domainId: string, key: string) => env.CACHE.delete(linkKey(domainId, key));
