import { Hono } from "hono";
import type { Env } from "../env";
import { hashKey, KEY_SHAPE } from "../keys";
import { blocked, hit, LIMITS, limitKey } from "../limits";
import type { Grant } from "../principal";
import { rowToUser, type UserRow } from "../types";
import { linkStats } from "./analytics";
import { listDomains } from "./domains";
import { links } from "./links";
import { isV1, nonJsonBody } from "./shared";

/** Who an /api/v1 call acts as. `limiterKey` is `api:k:<keyId>` for keys, `api:c:<connId>` for MCP connections. */
export type Principal = { user: UserRow; grant: Grant; limiterKey: string };
type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };

/** R2: in-process principals, written only by callApi. An outside request is a fresh object and is never in it. */
export const inProcess = new WeakMap<Request, Principal>();

export { isV1 };

const LAST_USED_EVERY = 60;
const invalidKey = { error: "invalid_key" } as const;

type KeyRow = Record<string, unknown> & { key_id: string; key_name: string; can_write: number; can_delete: number; domain_ids: string; last_used_at: number | null };

/** Stored `[]` is unrestricted (null); anything but a JSON array of strings fails closed to no domain at all ([]). */
function keyDomains(raw: string): string[] | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v) || !v.every((d) => typeof d === "string")) return [];
  return v.length ? v : null;
}

export const v1 = new Hono<E>();

// Bearer keys only (R3): never the Access JWT or the session cookie.
v1.use("*", async (c, next) => {
  const p = inProcess.get(c.req.raw);
  if (p) {
    // runTool already applied api:u, api:c and api:ud, so one tool call counts once.
    c.set("user", p.user);
    c.set("grant", p.grant);
    return next();
  }
  const auth = c.req.header("authorization");
  if (auth === undefined) return c.json({ error: "unauthenticated" }, 401);
  const secret = /^Bearer (\S+)$/i.exec(auth)?.[1]; // RFC 6750: the scheme is case-insensitive
  if (!secret || !KEY_SHAPE.test(secret)) return c.json(invalidKey, 401);
  const now = Math.floor(Date.now() / 1000);
  // The user row is re-read on every call: a disabled person's key stops at once.
  let row: KeyRow | null;
  try {
    row = await c.env.DB.prepare(
      `SELECT k.id AS key_id, k.name AS key_name, k.can_write, k.can_delete, k.domain_ids, k.last_used_at, u.*
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.hash = ? AND k.revoked_at IS NULL AND k.expires_at > ? AND u.status = 'active'`,
    ).bind(await hashKey(secret), now).first<KeyRow>();
  } catch {
    return c.json({ error: "unavailable" }, 503); // fail closed, and not a 500 that reads like a bug
  }
  if (!row) return c.json(invalidKey, 401);
  const user = rowToUser(row);
  const keys = [
    [limitKey.apiUser(user.id), LIMITS.apiUser], [limitKey.apiKey(row.key_id), LIMITS.apiKey], [limitKey.apiDay(user.id), LIMITS.apiDay],
    [limitKey.apiInstanceDay, LIMITS.apiInstanceDay],
  ] as const;
  try {
    // Reads first, so a refused call writes nothing.
    if ((await Promise.all(keys.map(([k, l]) => blocked(c.env, k, l)))).some(Boolean) ||
      !(await Promise.all(keys.map(([k, l]) => hit(c.env, k, l)))).every(Boolean))
      return c.json({ error: "rate_limited" }, 429);
  } catch {
    return c.json({ error: "unavailable" }, 503); // fail closed: no limiter, no call
  }
  if (row.last_used_at === null || row.last_used_at < now - LAST_USED_EVERY)
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
        .bind(now, row.key_id, now - LAST_USED_EVERY).run()
        .catch((e) => console.error("last_used_at update failed", e instanceof Error ? e.name : "unknown")),
    );
  c.set("user", user);
  c.set("grant", { write: row.can_write === 1, del: row.can_delete === 1, domains: keyDomains(row.domain_ids), via: `API key ${row.key_name}` });
  await next();
});

// R4: no CSRF or Origin check here (an Authorization header is never sent by a browser on its own); the 415 guard stays.
v1.use("*", async (c, next) => {
  if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method) && nonJsonBody(c.req)) return c.json({ error: "unsupported_media_type" }, 415);
  await next();
});

// Scope gate: reads always; create and edit need write; delete (DELETE, or a bulk delete) needs delete (which implies write).
v1.use("/links/*", async (c, next) => {
  const g = c.var.grant, m = c.req.method;
  // A bulk POST is a delete when its body says so (Hono caches the parsed body for the route).
  const del = m === "DELETE" || (m === "POST" && c.req.path.endsWith("/links/bulk") && (await c.req.json().catch(() => null))?.action === "delete");
  if (del && !(g.write && g.del)) return c.json({ error: "delete_not_allowed" }, 403);
  if ((m === "POST" || m === "PATCH") && !g.write) return c.json({ error: "read_only" }, 403);
  await next();
});

v1.route("/links", links);
v1.get("/domains", (c) => listDomains(c, false));
v1.get("/analytics/links", linkStats);
// Everything else (keys, users, audit, locks, import, domain writes, the full report) is dashboard-session only.
v1.all("*", (c) => c.json({ error: "not_found" }, 404));
