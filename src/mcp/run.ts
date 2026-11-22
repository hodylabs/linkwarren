import { getMcpAuthContext } from "agents/mcp/server";
import type { Principal } from "../call";
import type { Env } from "../env";
import { blocked, hit, LIMITS, limitKey } from "../limits";
import { rowToUser } from "../types";

export const REFUSED = "This connection was disconnected or its person no longer has access.";
const RATE = "Rate limited, try again in a minute.";
const DAILY = "Daily limit reached, try again tomorrow (UTC).";

/** An /api/v1 answer of 400 or more, or a tool-level refusal of its input; the agent sees only `{ error, status }`. */
export class ApiError extends Error {
  constructor(readonly error: string, readonly status: number) { super(error); }
}

type ConnRow = Record<string, unknown> & { conn_id: string; client_name: string; can_write: number; can_delete: number; revoked_at: number | null };
type Resolved = { p: Principal; connId: string } | { refused: string; log?: { userId: string; connId: string; via: string } };

/** R6: the connection and its person are re-read on every call, so a revoke, downgrade or disable applies to the next one. */
async function resolve(env: Env): Promise<Resolved> {
  const props = getMcpAuthContext()?.props;
  const userId = props?.userId, connId = props?.connId;
  if (typeof userId !== "string" || typeof connId !== "string") return { refused: REFUSED };
  const row = await env.DB.prepare(
    `SELECT c.id AS conn_id, c.client_name, c.can_write, c.can_delete, c.revoked_at, u.*
     FROM agent_connections c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.user_id = ?`,
  ).bind(connId, userId).first<ConnRow>();
  if (!row) return { refused: REFUSED };
  // Checked here rather than in the WHERE so a refused call can still be logged against its connection.
  if (row.revoked_at !== null || row.status !== "active")
    return { refused: REFUSED, log: { userId, connId, via: row.client_name } };
  return {
    connId,
    p: {
      user: rowToUser(row),
      grant: { write: row.can_write === 1, del: row.can_delete === 1, domains: null, via: row.client_name },
      limiterKey: limitKey.apiConn(connId),
    },
  };
}

export async function principalFor(env: Env): Promise<Principal | { refused: string }> {
  const r = await resolve(env);
  return "p" in r ? r.p : { refused: r.refused };
}

type Status = "ok" | "refused" | "error" | "rate_limited";
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const json = (v: Record<string, unknown>, isError = false): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v, ...(isError ? { isError } : {}) });

/** Over a limit: which message, or null when the call may run. Reads first, so a refused call writes nothing. */
async function limited(env: Env, p: Principal): Promise<string | null> {
  const day = [limitKey.apiDay(p.user.id), LIMITS.apiDay] as const;
  const keys = [[limitKey.apiUser(p.user.id), LIMITS.apiUser], [p.limiterKey, LIMITS.apiConn], day] as const;
  const b = await Promise.all(keys.map(([k, l]) => blocked(env, k, l)));
  if (b[2]) return DAILY;
  if (b.some(Boolean)) return RATE;
  const h = await Promise.all(keys.map(([k, l]) => hit(env, k, l)));
  if (!h[2]) return DAILY;
  return h.every(Boolean) ? null : RATE;
}

/**
 * Every tool runs through here: principal, limits, the call, one tool_calls row (never arguments or results).
 * `fn` returning `{ refused: true }` is a deliberate refusal (delete_link without confirm), logged as `refused`.
 */
export async function runTool(name: string, env: Env, ctx: ExecutionContext, fn: (p: Principal) => Promise<Record<string, unknown>>): Promise<ToolResult> {
  let status: Status = "error", log: { userId: string; connId: string; via: string } | undefined;
  let out: ToolResult;
  try {
    const r = await resolve(env);
    if ("refused" in r) {
      status = "refused";
      log = r.log;
      out = text(r.refused);
    } else {
      log = { userId: r.p.user.id, connId: r.connId, via: r.p.grant.via ?? "" };
      const over = await limited(env, r.p);
      if (over) {
        status = "rate_limited";
        out = text(over);
      } else {
        const result = await fn(r.p);
        status = result.refused === true ? "refused" : "ok";
        out = json(result);
      }
    }
  } catch (e) {
    status = "error";
    if (e instanceof ApiError) out = json({ error: e.error, status: e.status }, true);
    else {
      console.error("mcp tool failed", name, e instanceof Error ? e.name : "unknown"); // never the message: it may carry input
      out = json({ error: "internal", status: 500 }, true);
    }
  }
  if (log) {
    const l = log;
    ctx.waitUntil(
      env.DB.prepare("INSERT INTO tool_calls (at, user_id, via, conn_id, tool, status) VALUES (?,?,?,?,?,?)")
        .bind(Math.floor(Date.now() / 1000), l.userId, l.via, l.connId, name, status).run()
        .catch((e) => console.error("tool_calls insert failed", e instanceof Error ? e.name : "unknown")),
    );
  }
  return out;
}
