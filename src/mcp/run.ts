import { getMcpAuthContext } from "agents/mcp/server";
import type { Principal } from "../call";
import type { Env } from "../env";
import { hitCount, LIMITS, limitKey, windowCount } from "../limits";
import { rowToUser } from "../types";

export const REFUSED = "This connection was disconnected or its person no longer has access.";
const RATE = "Rate limited, try again in a minute.";
const DAILY = "Daily limit reached, try again tomorrow (UTC).";

/** An /api/v1 answer of 400 or more, or a tool-level refusal of its input; the agent sees only `{ error, status }`. */
export class ApiError extends Error {
  constructor(readonly error: string, readonly status: number) { super(error); }
}

type ConnRow = Record<string, unknown> & { client_name: string; can_write: number; can_delete: number };
type Resolved = { p: Principal; connId: string } | { refused: string };

/** R6: the connection and its person are re-read on every call, so a revoke, downgrade or disable applies to the next one. */
async function resolve(env: Env): Promise<Resolved> {
  const props = getMcpAuthContext()?.props;
  const userId = props?.userId, connId = props?.connId;
  if (typeof userId !== "string" || typeof connId !== "string") return { refused: REFUSED };
  const row = await env.DB.prepare(
    `SELECT c.client_name, c.can_write, c.can_delete, u.*
     FROM agent_connections c JOIN users u ON u.id = c.user_id
     WHERE c.id = ? AND c.user_id = ? AND c.revoked_at IS NULL AND u.status = 'active'`,
  ).bind(connId, userId).first<ConnRow>();
  // Refused calls write nothing (no tool_calls row): a token still valid after a disconnect cannot spend D1 writes.
  if (!row) return { refused: REFUSED };
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
  return "p" in r ? r.p : r;
}

type Status = "ok" | "refused" | "error" | "rate_limited";
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const json = (v: Record<string, unknown>, isError = false): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v, ...(isError ? { isError } : {}) });

type Key = readonly [string, { n: number; s: number; utc?: boolean }, boolean];

/**
 * Over a limit: the message and whether to log the call, or null when it may run.
 * Reads first. Only the first refused call in a window (count exactly n) is counted (n + 1) and logged;
 * later ones are read only and write nothing, so a retry loop costs no D1 writes.
 */
async function limited(env: Env, p: Principal): Promise<{ msg: string; log: boolean } | null> {
  const keys: Key[] = [
    [limitKey.apiUser(p.user.id), LIMITS.apiUser, false], [p.limiterKey, LIMITS.apiConn, false],
    [limitKey.apiDay(p.user.id), LIMITS.apiDay, true], [limitKey.apiInstanceDay, LIMITS.apiInstanceDay, true],
  ];
  const msg = (over: Key[]) => ({ msg: over.some((k) => k[2]) ? DAILY : RATE });
  const counts = await Promise.all(keys.map(([k, l]) => windowCount(env, k, l)));
  const over = keys.filter((k, i) => counts[i]! >= k[1].n);
  if (over.length) {
    const first = keys.filter((k, i) => counts[i] === k[1].n);
    const now = await Promise.all(first.map(([k, l]) => hitCount(env, k, l)));
    // Calls racing at the threshold all read n: only the one whose atomic increment returned n + 1 logs.
    return { ...msg(over), log: first.some((k, i) => now[i] === k[1].n + 1) };
  }
  const after = await Promise.all(keys.map(([k, l]) => hitCount(env, k, l)));
  const crossed = keys.filter((k, i) => after[i]! > k[1].n); // a concurrent call took the last slot
  return crossed.length ? { ...msg(crossed), log: keys.some((k, i) => after[i] === k[1].n + 1) } : null;
}

/**
 * Every tool runs through here: principal, limits, the call, one tool_calls row (never arguments or results).
 * No row for a refused principal, a call refused read-only by a limit, or a limiter failure.
 * `fn` returning `{ refused: true }` is a deliberate refusal (delete_link without confirm), logged as `refused`.
 */
export async function runTool(name: string, env: Env, ctx: ExecutionContext, fn: (p: Principal) => Promise<Record<string, unknown>>): Promise<ToolResult> {
  let status: Status = "error", log: { userId: string; connId: string; via: string } | undefined;
  let out: ToolResult;
  try {
    const r = await resolve(env);
    if ("refused" in r) out = text(r.refused);
    else {
      const over = await limited(env, r.p).catch((e: unknown) => {
        console.error("mcp limiter failed", e instanceof Error ? e.name : "unknown");
        return "down" as const;
      });
      // Fail closed, and no tool_calls row: a retry loop against a broken limiter must not write one per call.
      if (over === "down") return json({ error: "unavailable", status: 503 }, true);
      log = { userId: r.p.user.id, connId: r.connId, via: r.p.grant.via ?? "" };
      if (over) {
        status = "rate_limited";
        if (!over.log) log = undefined;
        out = text(over.msg);
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
