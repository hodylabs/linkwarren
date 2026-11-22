import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { MCP_KEY, mcpState, rememberMcp, resetMcpCache } from "../mcp/switch";
import { actor, type Grant } from "../principal";
import { ACTOR_OK } from "./users";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
/** Dashboard session only (never under /api/v1): a person manages their own agent connections, the owner everyone's. */
export const agents = new Hono<E>();

export type ConnectionItem = {
  id: string; userId: string; userEmail: string | null; clientName: string; redirectHost: string;
  write: boolean; del: boolean; createdAt: number; lastUsedAt: number | null; calls7d: number;
};

type Row = { id: string; user_id: string; email: string; client_name: string; redirect_host: string; can_write: number; can_delete: number; created_at: number; last_used_at: number | null; calls7d: number };
const WEEK = 604800;
// Usage per connection via the tool_calls(conn_id, at) index: MAX is one index seek, the count a 7-day index range.
const SELECT = `SELECT c.id, c.user_id, u.email, c.client_name, c.redirect_host, c.can_write, c.can_delete, c.created_at,
  (SELECT MAX(at) FROM tool_calls WHERE conn_id = c.id) last_used_at,
  (SELECT COUNT(*) FROM tool_calls WHERE conn_id = c.id AND at > ?) calls7d
  FROM agent_connections c JOIN users u ON u.id = c.user_id WHERE c.revoked_at IS NULL`;
const toItem = (r: Row, withEmail: boolean): ConnectionItem => ({
  id: r.id, userId: r.user_id, userEmail: withEmail ? r.email : null, clientName: r.client_name, redirectHost: r.redirect_host,
  write: r.can_write === 1, del: r.can_delete === 1, createdAt: r.created_at, lastUsedAt: r.last_used_at, calls7d: r.calls7d,
});
const now = () => Math.floor(Date.now() / 1000);
const notFound = { error: "not_found" } as const;
const forbidden = { error: "forbidden" } as const;
/** Checked in the write itself: the caller is still active and still the connection's person or an owner (a demotion mid-request wins). */
const MAY_MANAGE = "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND (role = 'owner' OR id = ?))";
const mayManage = async (env: Env, u: UserRow, userId: string) =>
  !!(await env.DB.prepare(`SELECT ${MAY_MANAGE} ok`).bind(u.id, userId).first<{ ok: number }>())?.ok;

/** An unrevoked connection the caller may manage (own, or the owner for anyone's); unknown and foreign ids both give null. */
const find = (env: Env, u: UserRow, id: string) =>
  env.DB.prepare(`${SELECT} AND c.id = ? AND (c.user_id = ? OR ? = 1)`).bind(now() - WEEK, id, u.id, u.role === "owner" ? 1 : 0).first<Row>();

agents.get("/connections", async (c) => {
  const u = c.var.user;
  const all = u.role === "owner" && c.req.query("all") === "1";
  // shortcut: no pagination, connections per instance are few (same as keys); add a cursor if it grows.
  const rows = all
    ? await c.env.DB.prepare(`${SELECT} ORDER BY c.created_at, c.id`).bind(now() - WEEK).all<Row>()
    : await c.env.DB.prepare(`${SELECT} AND c.user_id = ? ORDER BY c.created_at, c.id`).bind(now() - WEEK, u.id).all<Row>();
  return c.json({ items: rows.results.map((r) => toItem(r, all)) });
});

agents.get("/connections/:id/calls", async (c) => {
  const id = c.req.param("id");
  if (!(await find(c.env, c.var.user, id))) return c.json(notFound, 404);
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
  const row = await find(c.env, u, id);
  if (!row) return c.json(notFound, 404);
  const own = row.user_id === u.id;
  const item = toItem(row, !own);
  // R6: the owner may only lower someone else's connection; raising needs that person's own sign-in.
  if (!own && ((write && !item.write) || (del && !item.del))) return c.json({ error: "owner_cannot_raise" }, 403);
  if (write === item.write && del === item.del) return c.json(item);
  const w = write ? 1 : 0, d = del ? 1 : 0;
  const res = await c.env.DB.batch([
    // Optimistic: write only if the row still holds what we read, so a change in between answers 409 and `before`
    // is never stale; with the owner's lowering-only check above, this can never raise what the person set.
    c.env.DB.prepare(`UPDATE agent_connections SET can_write = ?, can_delete = ? WHERE id = ? AND revoked_at IS NULL AND can_write = ? AND can_delete = ? AND ${MAY_MANAGE}`)
      .bind(w, d, id, item.write ? 1 : 0, item.del ? 1 : 0, u.id, row.user_id),
    auditStmt(c.env, { ...actor(c), action: "agent.access", targetType: "agent_connection", targetId: id,
      detail: { write, del, before: { write: item.write, del: item.del } } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM agent_connections WHERE id = ? AND revoked_at IS NULL)", binds: [id] }),
  ]);
  if (!res[0]!.meta.changes) {
    if (!(await mayManage(c.env, u, row.user_id))) return c.json(forbidden, 403);
    return (await find(c.env, u, id)) ? c.json({ error: "changed" }, 409) : c.json(notFound, 404); // revoked in between
  }
  return c.json({ ...item, write, del });
});

agents.delete("/connections/:id", async (c) => {
  const u = c.var.user, id = c.req.param("id");
  const row = await find(c.env, u, id);
  if (!row) return c.json(notFound, 404);
  const t = now();
  // D1 first: the per-call check refuses the token from here on, whatever happens to the KV grant below.
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND ${MAY_MANAGE}`).bind(t, id, u.id, row.user_id),
    auditStmt(c.env, { ...actor(c), action: "agent.disconnect", targetType: "agent_connection", targetId: id,
      detail: { userId: row.user_id, clientName: row.client_name } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM agent_connections WHERE id = ? AND revoked_at = ?)", binds: [id, t] }),
  ]);
  if (!res[0]!.meta.changes) return (await mayManage(c.env, u, row.user_id)) ? c.json(notFound, 404) : c.json(forbidden, 403);
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

/** The owner's switch for agent connections (R9, R10). Everyone signed in may read it; only the owner changes it. */
agents.get("/mcp", async (c) => {
  try {
    return c.json(await mcpState(c.env));
  } catch {
    return c.json({ error: "unavailable" }, 503);
  }
});

const mcpBody = z.strictObject({ on: z.boolean() });
agents.put("/mcp", async (c) => {
  const u = c.var.user;
  if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const body = mcpBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { on } = body.data;
  // Compare against the stored row, never this isolate's cache: a stale "off" must not swallow an owner's "off".
  resetMcpCache();
  const state = await mcpState(c.env);
  if (state.locked) return c.json({ error: "mcp_locked" }, 409);
  if (state.on === on) return c.json(state);
  const value = on ? "1" : "0";
  // Both statements check the caller is still an active owner, so a demotion that lands first changes nothing.
  const [set] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE ${ACTOR_OK} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(MCP_KEY, value, now(), u.id, u.id),
    auditStmt(c.env, { actorId: u.id, action: "settings.update", targetType: "settings", targetId: MCP_KEY, detail: { key: MCP_KEY, value } },
      { sql: `changes() > 0 AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`, binds: [MCP_KEY, value] }),
  ]);
  if (!set!.meta.changes) return c.json({ error: "forbidden" }, 403);
  rememberMcp(c.env, value);
  return c.json({ on, locked: false });
});
