import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const exportApi = new Hono<E>();

/**
 * The only tables and columns the export reads (R11). Never: sessions, login_tokens, passkeys, auth_challenges, auth_limits,
 * locks, analytics_state, links.password_hash, api_keys.hash, settings rows `secret.%` (encrypted secrets, src/secrets.ts).
 * `computed`: name -> boolean SQL expression. `where`: a fixed filter. SQL is built only from this constant, never from input.
 */
export const EXPORT_TABLES: readonly { table: string; columns: readonly string[]; computed?: Record<string, string>; where?: string }[] = [
  { table: "users", columns: ["id", "email", "name", "role", "status", "created_at"] },
  { table: "domains", columns: ["id", "host", "type", "status", "owner_id", "bare_redirect", "notfound_redirect", "case_sensitive", "noindex", "reserved_extra", "created_at"] },
  { table: "domain_cf", columns: ["domain_id", "kind", "zone_id", "dns_record_id", "route_id", "hostname_id", "dns", "ownership", "certificate", "errors", "last_error", "checked_at", "security_level", "rate_limit", "updated_at"] },
  { table: "domain_members", columns: ["domain_id", "user_id"] },
  {
    table: "links",
    columns: ["id", "domain_id", "slug", "slug_key", "url", "redirect_code", "starts_at", "expires_at", "pass_query", "created_by", "updated_by", "created_at", "updated_at", "routes", "forward_to"],
    computed: { protected: "password_hash IS NOT NULL" },
  },
  { table: "slug_locks", columns: ["domain_id", "slug_key", "locked_at", "locked_by"] },
  { table: "audit_log", columns: ["id", "at", "actor_id", "via", "action", "target_type", "target_id", "detail"] },
  { table: "settings", columns: ["key", "value", "updated_at", "updated_by"], where: "key NOT LIKE 'secret.%'" },
  { table: "clicks_daily", columns: ["day", "link_id", "domain_id", "slug", "qr", "typed", "bots", "visitors"] },
  { table: "clicks_daily_dim", columns: ["day", "link_id", "domain_id", "dim", "value", "clicks"] },
  { table: "api_keys", columns: ["id", "user_id", "name", "prefix", "can_write", "can_delete", "domain_ids", "expires_at", "created_at", "last_used_at", "revoked_at"] },
  { table: "agent_connections", columns: ["id", "user_id", "client_id", "client_name", "redirect_host", "can_write", "can_delete", "created_at", "revoked_at"] },
  { table: "tool_calls", columns: ["id", "at", "user_id", "via", "conn_id", "tool", "status"] },
];
const NAMES = EXPORT_TABLES.map((t) => t.table) as [string, ...string[]];
const PAGE = 500;
const q = (id: string) => `"${id}"`;
const outColumns = (t: (typeof EXPORT_TABLES)[number]) => [...t.columns, ...Object.keys(t.computed ?? {})];

exportApi.use("*", async (c, next) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
});

/** R7 logo (KV `instance:logo`, metadata `{ type }`) as base64, or null. */
async function logo(env: Env): Promise<{ type: string; data: string } | null> {
  const r = await env.CACHE.getWithMetadata<{ type?: string }>("instance:logo", "arrayBuffer");
  if (!r.value || typeof r.metadata?.type !== "string") return null;
  const b = new Uint8Array(r.value);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { type: r.metadata.type, data: btoa(s) };
}

exportApi.post("/start", async (c) => {
  await c.env.DB.batch([auditStmt(c.env, { actorId: c.var.user.id, action: "export.run", targetType: "instance", targetId: "export", detail: { tables: NAMES } })]);
  return c.json({
    format: "linkwarren-export",
    version: 1,
    exportedAt: Math.floor(Date.now() / 1000),
    tables: EXPORT_TABLES.map((t) => ({ name: t.table, columns: outColumns(t) })),
    logo: await logo(c.env),
  });
});

const pageBody = z.strictObject({ table: z.enum(NAMES), after: z.number().int().nullable() });
exportApi.post("/page", async (c) => {
  const body = pageBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const t = EXPORT_TABLES.find((x) => x.table === body.data.table)!;
  const { after } = body.data;
  const cols = [...t.columns.map(q), ...Object.entries(t.computed ?? {}).map(([n, sql]) => `(${sql}) AS ${q(n)}`)];
  const where = [...(after === null ? [] : ["rowid > ?"]), ...(t.where ? [t.where] : [])];
  // Keyset paging on rowid: stable order, no OFFSET scan.
  const sql = `SELECT rowid AS _r, ${cols.join(", ")} FROM ${q(t.table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid LIMIT ${PAGE}`;
  const rows = (await c.env.DB.prepare(sql).bind(...(after === null ? [] : [after])).all<Record<string, unknown>>()).results;
  const computed = Object.keys(t.computed ?? {});
  const out = rows.map(({ _r, ...r }) => {
    for (const k of computed) r[k] = !!r[k];
    return r;
  });
  return c.json({ rows: out, next: rows.length === PAGE ? (rows[PAGE - 1]!._r as number) : null });
});
