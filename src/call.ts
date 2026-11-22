import { app } from "./app";
import { inProcess, isV1, type Principal } from "./api/v1";
import type { Env } from "./env";

export type { Principal };

/** R2: calls /api/v1 in-process as `p` (MCP tools), through the same routes and checks a key call gets. */
export async function callApi(
  env: Env, ctx: ExecutionContext, p: Principal, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const req = new Request("https://" + env.DASHBOARD_HOST + "/api/v1" + path, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  // A path with dot segments must not resolve outside the machine API.
  if (!isV1(new URL(req.url).pathname)) throw new Error("callApi: path outside /api/v1");
  inProcess.set(req, p);
  const res = await app.fetch(req, env, ctx);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}
