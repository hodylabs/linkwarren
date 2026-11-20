import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const audit = new Hono<E>();

export type AuditItem = {
  id: number; at: number; actorId: string; actorEmail: string | null; actorName: string | null; via: string | null;
  action: string; targetType: string; targetId: string; detail: Record<string, unknown>;
};

const PAGE = 50;
const SECRET = /secret|token|password|authorization|cookie|api_?key/i;

/** Drops secret-looking object keys at any depth. */
export function redactDetail(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactDetail);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, redactDetail(x)]));
  return v;
}

const query = z.strictObject({
  actor: z.string().min(1).max(64).optional(),
  via: z.enum(["present", "absent"]).optional(),
  action: z.string().regex(/^[a-z.]{1,40}$/).optional(),
  target: z.enum(["link", "domain", "user", "lock", "import"]).optional(),
});
const CURSOR = /^[1-9]\d{0,15}$/;

audit.get("/", async (c) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const raw = new URL(c.req.url).searchParams;
  const cursor = raw.get("cursor");
  if (cursor !== null && !CURSOR.test(cursor)) return c.json({ error: "bad_cursor" }, 400);
  raw.delete("cursor");
  const q = query.safeParse(Object.fromEntries(raw));
  if (!q.success) return c.json({ error: "bad_query" }, 400);
  const { actor, via, action, target } = q.data;
  const where: string[] = [], binds: unknown[] = [];
  if (cursor) { where.push("a.id < ?"); binds.push(Number(cursor)); }
  if (actor) { where.push("a.actor_id = ?"); binds.push(actor); }
  if (via) where.push(via === "present" ? "a.via IS NOT NULL" : "a.via IS NULL");
  if (action) { where.push("substr(a.action, 1, ?) = ?"); binds.push(action.length, action); }
  if (target) { where.push("a.target_type = ?"); binds.push(target); }
  const rows = (await c.env.DB.prepare(
    `SELECT a.*, u.email actor_email, u.name actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`,
  ).bind(...binds, PAGE + 1).all<Record<string, unknown>>()).results;
  const items: AuditItem[] = rows.slice(0, PAGE).map((r) => {
    let detail: unknown = {};
    try { detail = redactDetail(JSON.parse(r.detail as string)); } catch { /* unparseable detail becomes {} */ }
    return {
      id: r.id as number, at: r.at as number, actorId: r.actor_id as string,
      actorEmail: r.actor_email as string | null, actorName: r.actor_name as string | null, via: r.via as string | null,
      action: r.action as string, targetType: r.target_type as string, targetId: r.target_id as string,
      detail: detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {},
    };
  });
  return c.json({ items, next: rows.length > PAGE ? String(items[PAGE - 1]!.id) : null });
});
