// Path-mode harness (S8c): the dashboard at short.test/dashboard, requests straight through the wrapper.
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import { wrapper } from "../../src/index";

export const testCtx = (): ExecutionContext =>
  ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

export const pathEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, DASHBOARD_HOST: "short.test", DASHBOARD_PATH: "/dashboard", AUTH_MODE: "app", ...over }) as Env;

/** `path` on short.test, or a full URL for another host. */
export const call = (path: string, init?: RequestInit, e: Env = pathEnv()): Promise<Response> =>
  wrapper(new Request(path.startsWith("https://") ? path : `https://short.test${path}`, { redirect: "manual", ...init }), e, testCtx());

/** short.test as an active main domain with one link: short.test/hello -> https://dest.example.com/hello. */
export async function seedShort(): Promise<void> {
  const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
  await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('pu1','path-owner@example.com','owner','active',1)");
  await run("INSERT OR IGNORE INTO domains (id,host,type,status,owner_id,created_at) VALUES ('pd1','short.test','main','active','pu1',1)");
  await run(
    "INSERT OR IGNORE INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES ('pl1','pd1','hello','hello','https://dest.example.com/hello',302,'pu1','pu1',1,1)",
  );
}
