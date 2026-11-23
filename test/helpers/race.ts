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

/**
 * Runs `fn` once, just before the first direct run (`all`, `first`, `run`, `raw`) of a statement whose SQL contains `match`,
 * to land a concurrent write between a handler's snapshot and a single-statement read. Returns a restore function.
 */
export function beforeQuery(match: string, fn: () => Promise<unknown>): () => void {
  const real = env.DB;
  let done = false;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
      if (p === "first" || p === "all" || p === "run" || p === "raw")
        return async (...a: unknown[]) => { if (!done) { done = true; await fn(); } return (t[p] as (...x: unknown[]) => unknown).apply(t, a); };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  (env as { DB: D1Database }).DB = new Proxy(real, {
    get(t, p) {
      if (p === "prepare") return (q: string) => (done || !q.includes(match) ? t.prepare(q) : wrap(t.prepare(q)));
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return () => { (env as { DB: D1Database }).DB = real; };
}

/** Runs `fn` once, right after the Worker's `nth` D1 batch committed. Returns a restore function; call it in a finally. */
export function afterBatch(nth: number, fn: () => Promise<unknown>): () => void {
  const real = env.DB;
  let n = 0;
  (env as { DB: D1Database }).DB = new Proxy(real, {
    get(t, p) {
      if (p === "batch") return async (s: D1PreparedStatement[]) => { const r = await t.batch(s); if (++n === nth) await fn(); return r; };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return () => { (env as { DB: D1Database }).DB = real; };
}
