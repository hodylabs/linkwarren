import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { MCP_KEY, mcpState, rememberMcp, resetMcpCache } from "../mcp/switch";
import { actor, type Grant } from "../principal";
import { actorCan, can, mayManage, parsePerms, requirePerm, within } from "../roles";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Dashboard session only (never under /api/v1): a person manages their own agent connections; owners everyone's, people
 * managers those of people within their role (R4). */
export const agents = new Hono<E>();

export type ConnectionItem = {
  id: string; userId: string; userEmail: string | null; clientName: string; redirectHost: string;
  write: boolean; del: boolean; createdAt: number; lastUsedAt: number | null; calls7d: number;
};

type Row = { id: string; user_id: string; email: string; urole: string; uperms: string; client_name: string; redirect_host: string; can_write: number; can_delete: number; created_at: number; last_used_at: number | null; calls7d: number };
const WEEK = 604800;
// Usage per connection via the tool_calls(conn_id, at) index: MAX is one index seek, the count a 7-day index range.
const SELECT = `SELECT c.id, c.user_id, u.email, u.role urole, ur.perms uperms, c.client_name, c.redirect_host, c.can_write, c.can_delete, c.created_at,
  (SELECT MAX(at) FROM tool_calls WHERE conn_id = c.id) last_used_at,
  (SELECT COUNT(*) FROM tool_calls WHERE conn_id = c.id AND at > ?) calls7d
  FROM agent_connections c JOIN users u ON u.id = c.user_id JOIN roles ur ON ur.id = COALESCE(u.role_id, u.role) WHERE c.revoked_at IS NULL`;
const toItem = (r: Row, withEmail: boolean): ConnectionItem => ({
  id: r.id, userId: r.user_id, userEmail: withEmail ? r.email : null, clientName: r.client_name, redirectHost: r.redirect_host,
  write: r.can_write === 1, del: r.can_delete === 1, createdAt: r.created_at, lastUsedAt: r.last_used_at, calls7d: r.calls7d,
});
const now = () => Math.floor(Date.now() / 1000);
const notFound = { error: "not_found" } as const;
/** Why a write guarded by mayManage wrote nothing: 403 when the caller lost the right (role_above_you for a people manager
 * whose target moved out of reach), else null (the connection changed or went). */
async function lost(env: Env, u: UserRow, userId: string): Promise<string | null> {
  const g = mayManage(userId, u.id), a = actorCan(u.id, "people.manage");
  const w = await env.DB.prepare(`SELECT ${g.sql} ok, ${a.sql} a`).bind(...g.binds, ...a.binds).first<{ ok: number; a: number }>();
  return w?.ok ? null : userId !== u.id && w?.a ? "role_above_you" : "forbidden";
}

/**
 * An unrevoked connection the caller may manage, or the refusal: unknown and foreign ids both give 404 to anyone who does
 * not manage people; a people manager gets 403 role_above_you for an owner's or a stronger person's (R4).
 */
async function find(env: Env, u: UserRow, id: string): Promise<{ row: Row } | { error: string; status: 403 | 404 }> {
  const row = await env.DB.prepare(`${SELECT} AND c.id = ?`).bind(now() - WEEK, id).first<Row>();
  if (!row || (row.user_id !== u.id && !can(u, "people.manage"))) return { error: "not_found", status: 404 };
  if (row.user_id !== u.id && u.role !== "owner" && (row.urole === "owner" || !within(parsePerms(row.uperms), u))) return { error: "role_above_you", status: 403 };
  return { row };
}

agents.get("/connections", async (c) => {
  const u = c.var.user;
  const all = can(u, "people.manage") && c.req.query("all") === "1";
  // mayManage re-checks people.manage in the query, so a permission lost after the snapshot lists only their own.
  const w = mayManage({ col: "c.user_id" }, u.id);
  // shortcut: no pagination, connections per instance are few (same as keys); add a cursor if it grows.
  const rows = all
    ? await c.env.DB.prepare(`${SELECT} AND ${w.sql} ORDER BY c.created_at, c.id`).bind(now() - WEEK, ...w.binds).all<Row>()
    : await c.env.DB.prepare(`${SELECT} AND c.user_id = ? ORDER BY c.created_at, c.id`).bind(now() - WEEK, u.id).all<Row>();
  return c.json({ items: rows.results.map((r) => toItem(r, all)) });
});

agents.get("/connections/:id/calls", async (c) => {
  const id = c.req.param("id");
  const f = await find(c.env, c.var.user, id);
  if ("error" in f) return c.json({ error: f.error }, f.status);
  const rows = await c.env.DB.prepare("SELECT at, tool, status FROM tool_calls WHERE conn_id = ? ORDER BY at DESC, id DESC LIMIT 20").bind(id).all<{ at: number; tool: string; status: string }>();
  return c.json({ items: rows.results });
});

const accessBody = z.strictObject({ write: z.boolean(), del: z.boolean() });

agents.patch("/connections/:id", async (c) => {
  const u = c.var.user, id = c.req.param("id");
  const body = accessBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { write, del } = body.data;
  if (del && !write) return c.json({ error: "del_needs_write" }, 400);
  const f = await find(c.env, u, id);
  if ("error" in f) return c.json({ error: f.error }, f.status);
  const { row } = f;
  const own = row.user_id === u.id;
  const item = toItem(row, !own);
  const raise = (write && !item.write) || (del && !item.del);
  // S8 R7: raising needs `agents` (lowering stays open, R3); re-checked in the update's batch below.
  if (own && raise && !can(u, "agents")) return c.json({ error: "forbidden" }, 403);
  // R6: an owner or people manager may only lower someone else's connection; raising needs that person's own sign-in.
  if (!own && raise) return c.json({ error: "owner_cannot_raise" }, 403);
  if (write === item.write && del === item.del) return c.json(item);
  const w = write ? 1 : 0, d = del ? 1 : 0, g = mayManage(row.user_id, u.id);
  const ag = raise ? actorCan(u.id, "agents") : { sql: "1", binds: [] };
  const res = await c.env.DB.batch([
    // Optimistic: write only if the row still holds what we read, so a change in between answers 409 and `before`
    // is never stale; with the owner's lowering-only check above, this can never raise what the person set.
    c.env.DB.prepare(`UPDATE agent_connections SET can_write = ?, can_delete = ? WHERE id = ? AND revoked_at IS NULL AND can_write = ? AND can_delete = ? AND ${g.sql} AND ${ag.sql}`)
      .bind(w, d, id, item.write ? 1 : 0, item.del ? 1 : 0, ...g.binds, ...ag.binds),
    auditStmt(c.env, { ...actor(c), action: "agent.access", targetType: "agent_connection", targetId: id,
      detail: { write, del, before: { write: item.write, del: item.del } } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM agent_connections WHERE id = ? AND revoked_at IS NULL)", binds: [id] }),
  ]);
  if (!res[0]!.meta.changes) {
    const why = await lost(c.env, u, row.user_id);
    if (why) return c.json({ error: why }, 403);
    if (raise && !(await c.env.DB.prepare(`SELECT ${ag.sql} ok`).bind(...ag.binds).first<{ ok: number }>())?.ok) return c.json({ error: "forbidden" }, 403);
    return "row" in (await find(c.env, u, id)) ? c.json({ error: "changed" }, 409) : c.json(notFound, 404); // revoked in between
  }
  return c.json({ ...item, write, del });
});

agents.delete("/connections/:id", async (c) => {
  const u = c.var.user, id = c.req.param("id");
  const f = await find(c.env, u, id);
  if ("error" in f) return c.json({ error: f.error }, f.status);
  const { row } = f;
  const t = now(), g = mayManage(row.user_id, u.id);
  // D1 first: the per-call check refuses the token from here on, whatever happens to the KV grant below.
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND ${g.sql}`).bind(t, id, ...g.binds),
    auditStmt(c.env, { ...actor(c), action: "agent.disconnect", targetType: "agent_connection", targetId: id,
      detail: { userId: row.user_id, clientName: row.client_name } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM agent_connections WHERE id = ? AND revoked_at = ?)", binds: [id, t] }),
  ]);
  if (!res[0]!.meta.changes) {
    const why = await lost(c.env, u, row.user_id);
    return why ? c.json({ error: why }, 403) : c.json(notFound, 404);
  }
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) throw new Error("no oauth helpers");
    // Each page is one KV list (1,000 lists/day on Free, shared by the account); a person has few grants, so usually one.
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(row.user_id, { cursor });
      for (const g of page.items) if ((g.metadata as { connId?: unknown } | undefined)?.connId === id) await oauth.revokeGrant(g.id, row.user_id);
      cursor = page.cursor;
    } while (cursor);
  } catch (err) {
    console.error("grant revoke failed", err instanceof Error ? err.name : "unknown"); // D1 already blocks the tools
  }
  return c.body(null, 204);
});

/** The switch for agent connections (R9, R10). Everyone signed in may read it; people with `settings` change it (S8 R5). */
agents.get("/mcp", async (c) => {
  try {
    return c.json(await mcpState(c.env));
  } catch {
    return c.json({ error: "unavailable" }, 503);
  }
});

const mcpBody = z.strictObject({ on: z.boolean() });
agents.put("/mcp", requirePerm("settings"), async (c) => {
  const u = c.var.user;
  const body = mcpBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { on } = body.data;
  // Compare against the stored row, never this isolate's cache: a stale "off" must not swallow an owner's "off".
  resetMcpCache();
  const state = await mcpState(c.env);
  if (state.locked) return c.json({ error: "mcp_locked" }, 409);
  if (state.on === on) return c.json(state);
  const value = on ? "1" : "0";
  // The upsert re-checks `settings` and the audit needs the row it wrote, so a permission lost first changes nothing.
  const g = actorCan(u.id, "settings");
  const [set] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE ${g.sql} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(MCP_KEY, value, now(), u.id, ...g.binds),
    auditStmt(c.env, { actorId: u.id, action: "settings.update", targetType: "settings", targetId: MCP_KEY, detail: { key: MCP_KEY, value } },
      { sql: `changes() > 0 AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`, binds: [MCP_KEY, value] }),
  ]);
  if (!set!.meta.changes) return c.json({ error: "forbidden" }, 403);
  rememberMcp(c.env, value);
  return c.json({ on, locked: false });
});
