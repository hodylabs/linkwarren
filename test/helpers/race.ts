import { env } from "cloudflare:workers";

/**
 * Runs `fn` once, just before the Worker's `nth` D1 batch executes, to land a concurrent write between a handler's
 * read and its write. Returns a restore function; call it in a finally.
 */
export function beforeBatch(nth: number, fn: () => Promise<unknown>): () => void {
  const real = env.DB;
  let n = 0;
  (env as { DB: D1Database }).DB = new Proxy(real, {
    get(t, p) {
      if (p === "batch") return async (s: D1PreparedStatement[]) => { if (++n === nth) await fn(); return t.batch(s); };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return () => { (env as { DB: D1Database }).DB = real; };
}
