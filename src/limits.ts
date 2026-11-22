import type { Env } from "./env";
import { sha256Hex } from "./session";

/** R6 fixed windows: n events per s seconds. */
export const LIMITS = {
  address: { n: 5, s: 900 },
  ip: { n: 20, s: 900 },
  instance: { n: 50, s: 3600 },
  failIp: { n: 20, s: 900 },
} as const;
type Limit = { n: number; s: number };

export const limitKey = {
  addr: async (email: string) => `addr:${await sha256Hex(email.toLowerCase())}`,
  ip: (prefix: string | null) => `ip:${prefix ?? "none"}`,
  opts: (prefix: string | null) => `opts:${prefix ?? "none"}`,
  fail: (prefix: string | null) => `fail:${prefix ?? "none"}`,
  inst: "inst",
} as const;

/** Counts one event in one atomic upsert (a window older than s restarts at 1); true when still within the limit. */
export async function hit(env: Env, key: string, l: Limit): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    "INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END RETURNING count",
  ).bind(key, now, now - l.s, now - l.s).first<{ count: number }>();
  return !!r && r.count <= l.n;
}

/** Read only: true when the current window already holds n events, so the next one would be refused. */
export async function blocked(env: Env, key: string, l: Limit): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare("SELECT count FROM auth_limits WHERE key = ? AND window_start > ?").bind(key, now - l.s).first<{ count: number }>();
  return !!r && r.count >= l.n;
}
