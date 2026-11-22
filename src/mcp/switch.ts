import type { Env } from "../env";

/** The owner's switch for agent connections (R9, R10): D1 `settings` row "1" / "0". */
export const MCP_KEY = "mcp.enabled";
/** The only staleness: another isolate's save is seen here within this long. */
export const MCP_TTL_MS = 10_000;

// The raw D1 value (null: no row), when it was read and for which instance (dashboard host), so two environments in one
// isolate never share a value; on/off is derived with the current var on every call.
let cache: { host: string; value: string | null; at: number } | null = null;

/**
 * `MCP_ENABLED === "0"` locks off without a read. Otherwise the D1 row decides; with no row, on only when the var is "1".
 * A D1 error throws: callers treat it as off (503).
 */
export async function mcpState(env: Env): Promise<{ on: boolean; locked: boolean }> {
  if (env.MCP_ENABLED === "0") return { on: false, locked: true };
  const t = Date.now();
  const host = env.DASHBOARD_HOST;
  if (!cache || cache.host !== host || t - cache.at >= MCP_TTL_MS || t < cache.at) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(MCP_KEY).first<{ value: string }>();
    cache = { host, value: row?.value ?? null, at: t };
  }
  return { on: cache.value === null ? env.MCP_ENABLED === "1" : cache.value === "1", locked: false };
}

/** After a save in this isolate: the new value applies here at once. */
export function rememberMcp(env: Env, value: "1" | "0"): void {
  cache = { host: env.DASHBOARD_HOST, value, at: Date.now() };
}

/** Forces the next read from D1: before a save, and in tests that change the row directly. */
export function resetMcpCache(): void {
  cache = null;
}
