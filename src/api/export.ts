import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { actorCan, can, requirePerm } from "../roles";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const exportApi = new Hono<E>();

/**
 * The only tables and columns the export reads (R11). Never: sessions, login_tokens, passkeys, auth_challenges, auth_limits,
 * locks, analytics_state, links.password_hash, api_keys.hash, qr_codes.secret, settings rows `secret.%` (encrypted secrets, src/secrets.ts).
 * `computed`: name -> boolean SQL expression. `where`: a fixed filter. SQL is built only from this constant, never from input.
 */
export const EXPORT_TABLES: readonly { table: string; columns: readonly string[]; computed?: Record<string, string>; where?: string; analytics?: true; audit?: true }[] = [
  // Roles before users: a restore inserts them before users.role_id refers to them (S8).
  { table: "roles", columns: ["id", "name", "perms", "builtin", "created_at", "updated_at", "updated_by"] },
  { table: "users", columns: ["id", "email", "name", "role", "role_id", "status", "created_at"] },
  { table: "domains", columns: ["id", "host", "type", "status", "owner_id", "bare_redirect", "notfound_redirect", "case_sensitive", "noindex", "reserved_extra", "created_at"] },
  { table: "domain_cf", columns: ["domain_id", "kind", "zone_id", "dns_record_id", "route_id", "hostname_id", "dns", "ownership", "certificate", "errors", "last_error", "checked_at", "security_level", "rate_limit", "updated_at"] },
  { table: "domain_members", columns: ["domain_id", "user_id"] },
  {
    table: "links",
    columns: ["id", "domain_id", "slug", "slug_key", "url", "redirect_code", "starts_at", "expires_at", "pass_query", "created_by", "updated_by", "created_at", "updated_at", "routes", "forward_to", "kind"],
    computed: { protected: "password_hash IS NOT NULL" },
  },
  // S9: the contact card of each vCard link (`data` its fields as JSON, `photo` base64).
  { table: "vcards", columns: ["link_id", "data", "photo"] },
  // S9: never the encrypted Wi-Fi password (`secret`), only whether one is stored.
  {
    table: "qr_codes",
    columns: ["id", "name", "kind", "data", "style", "created_by", "updated_by", "created_at", "updated_at"],
    computed: { hasPassword: "secret IS NOT NULL" },
  },
  { table: "slug_locks", columns: ["domain_id", "slug_key", "locked_at", "locked_by"] },
  // Only for people who may read the audit log (owners always): `data` alone never crosses the `audit` boundary.
  { table: "audit_log", columns: ["id", "at", "actor_id", "via", "action", "target_type", "target_id", "detail"], audit: true },
  { table: "settings", columns: ["key", "value", "updated_at", "updated_by"], where: "key NOT LIKE 'secret.%'" },
  // Rollups are kept forever and can hold millions of rows: out unless the owner asks (each exported row is one D1 read).
  { table: "clicks_daily", columns: ["day", "link_id", "domain_id", "slug", "qr", "typed", "bots", "visitors"], analytics: true },
  { table: "clicks_daily_dim", columns: ["day", "link_id", "domain_id", "dim", "value", "clicks"], analytics: true },
  { table: "api_keys", columns: ["id", "user_id", "name", "prefix", "can_write", "can_delete", "domain_ids", "expires_at", "created_at", "last_used_at", "revoked_at"] },
  { table: "agent_connections", columns: ["id", "user_id", "client_id", "client_name", "redirect_host", "can_write", "can_delete", "created_at", "revoked_at"] },
  { table: "tool_calls", columns: ["id", "at", "user_id", "via", "conn_id", "tool", "status"] },
];
const NAMES = EXPORT_TABLES.map((t) => t.table) as [string, ...string[]];
const PAGE = 500;
/** A page stops adding rows past this much JSON (Workers Free 10 ms CPU), and `next` continues from the last row sent. */
const PAGE_BYTES = 1_000_000;
/** A run id from /start is valid this long (a `locks` row `export:<id>`, never exported). */
const RUN_TTL_S = 6 * 3600;
const q = (id: string) => `"${id}"`;
const outColumns = (t: (typeof EXPORT_TABLES)[number]) => [...t.columns, ...Object.keys(t.computed ?? {})];

// S8 R12: `data` exports the whole instance; every page re-checks it.
exportApi.use("*", requirePerm("data"));

/** R7 logo (KV `instance:logo`, metadata `{ type }`) as base64, or null. */
async function logo(env: Env): Promise<{ type: string; data: string } | null> {
  const r = await env.CACHE.getWithMetadata<{ type?: string }>("instance:logo", "arrayBuffer");
  if (!r.value || typeof r.metadata?.type !== "string") return null;
  const b = new Uint8Array(r.value);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { type: r.metadata.type, data: btoa(s) };
}

const startBody = z.strictObject({ includeAnalytics: z.boolean().default(false) });
exportApi.post("/start", async (c) => {
  const body = startBody.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { includeAnalytics } = body.data;
  const tables = EXPORT_TABLES.filter((t) => (includeAnalytics || !t.analytics) && (!t.audit || can(c.var.user, "audit")));
  // Estimates: MAX(rowid) is one index seek per table (never a scan); an upper bound when rows were deleted.
  const est = await c.env.DB.batch(tables.map((t) => c.env.DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${q(t.table)}`)));
  const rows = est.map((r) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0));
  const estimatedReads = rows.reduce((a, b) => a + b, 0);
  const run = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  const names = tables.map((t) => t.table);
  // The run and its audit re-check `data` in SQL: lost meanwhile, neither is written.
  const may = actorCan(c.var.user.id, "data");
  const [, lock] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM locks WHERE key LIKE 'export:%' AND until <= ?").bind(now),
    c.env.DB.prepare(`INSERT INTO locks (key, token, until) SELECT ?,?,? WHERE ${may.sql}`).bind(`export:${run}`, `${c.var.user.id}|${includeAnalytics ? 1 : 0}`, now + RUN_TTL_S, ...may.binds),
    auditStmt(c.env, { actorId: c.var.user.id, action: "export.run", targetType: "instance", targetId: "export", detail: { tables: names, includeAnalytics, estimatedReads } }, may),
  ]);
  if (!lock!.meta.changes) return c.json({ error: "forbidden" }, 403);
  return c.json({
    format: "linkwarren-export",
    version: 1,
    exportedAt: now,
    run,
    includeAnalytics,
    estimatedReads,
    tables: tables.map((t, i) => ({ name: t.table, columns: outColumns(t), rows: rows[i]! })),
    logo: await logo(c.env),
  });
});

const pageBody = z.strictObject({ run: z.string().uuid(), table: z.enum(NAMES), after: z.number().int().nullable() });
exportApi.post("/page", async (c) => {
  const body = pageBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const t = EXPORT_TABLES.find((x) => x.table === body.data.table)!;
  if (t.audit && !can(c.var.user, "audit")) return c.json({ error: "forbidden" }, 403);
  const { after, run } = body.data;
  const live = await c.env.DB.prepare("SELECT token FROM locks WHERE key = ? AND until > ?").bind(`export:${run}`, Math.floor(Date.now() / 1000)).first<{ token: string }>();
  const [owner, analytics] = (live?.token ?? "").split("|");
  if (!live || owner !== c.var.user.id) return c.json({ error: "export_expired" }, 409);
  if (t.analytics && analytics !== "1") return c.json({ error: "analytics_not_included" }, 409);
  const cols = [...t.columns.map(q), ...Object.entries(t.computed ?? {}).map(([n, sql]) => `(${sql}) AS ${q(n)}`)];
  const where = [...(after === null ? [] : ["rowid > ?"]), ...(t.where ? [t.where] : [])];
  // Keyset paging on rowid: stable order, no OFFSET scan.
  const sql = `SELECT rowid AS _r, ${cols.join(", ")} FROM ${q(t.table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid LIMIT ${PAGE}`;
  const rows = (await c.env.DB.prepare(sql).bind(...(after === null ? [] : [after])).all<Record<string, unknown>>()).results;
  const computed = Object.keys(t.computed ?? {});
  const parts: string[] = [];
  let bytes = 0, last: number | null = null;
  for (const { _r, ...r } of rows) {
    for (const k of computed) r[k] = !!r[k];
    const s = JSON.stringify(r);
    parts.push(s);
    bytes += s.length;
    last = _r as number;
    if (bytes >= PAGE_BYTES) break;
  }
  const next = parts.length < rows.length || rows.length === PAGE ? last : null;
  return c.body(`{"rows":[${parts.join(",")}],"next":${next === null ? "null" : next}}`, 200, { "content-type": "application/json" });
});
