import { Hono } from "hono";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { endSessionStmt } from "../session";
import { rowToUser, type UserListItem, type UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const users = new Hono<E>();

users.get("/", async (c) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const [u, counts, access] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM users ORDER BY created_at, id").all(),
    c.env.DB.prepare("SELECT created_by, COUNT(*) n FROM links GROUP BY created_by").all<{ created_by: string; n: number }>(),
    // Owned domains first (via='owner'), then grants; the per-user loop below keeps the first sighting so owner rows win.
    c.env.DB.prepare(
      `SELECT * FROM (SELECT owner_id uid, id, host, 'owner' via, 0 rk FROM domains
       UNION ALL SELECT m.user_id, d.id, d.host, 'member', 1 FROM domain_members m JOIN domains d ON d.id = m.domain_id)
       ORDER BY uid, rk, host`,
    ).all<{ uid: string; id: string; host: string; via: "owner" | "member" }>(),
  ]);
  const n = new Map(counts.results.map((r) => [r.created_by, r.n]));
  const doms = new Map<string, UserListItem["domains"]>();
  for (const a of access.results) {
    const list = doms.get(a.uid) ?? [];
    if (!list.some((d) => d.id === a.id)) list.push({ id: a.id, host: a.host, via: a.via });
    doms.set(a.uid, list);
  }
  // shortcut: no pagination, the user table is small (same as domains); add a cursor if it grows.
  const items: UserListItem[] = u.results.map((r) => {
    const x = rowToUser(r);
    return { ...x, linkCount: n.get(x.id) ?? 0, domains: doms.get(x.id) ?? [] };
  });
  return c.json({ items });
});

users.delete("/:id/sessions", async (c) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  if (!(await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").bind(id).first<{ n: number }>();
  await c.env.DB.batch([
    auditStmt(c.env, { actorId: c.var.user.id, action: "session.end_all", targetType: "user", targetId: id, detail: { count: n?.n ?? 0 } },
      { sql: "EXISTS (SELECT 1 FROM users WHERE id = ?)", binds: [id] }),
    endSessionStmt(c.env, { userId: id }),
  ]);
  return c.body(null, 204);
});
