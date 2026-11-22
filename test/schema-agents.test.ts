import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneExpired, RUN_WRITE_BUDGET } from "../src/cron";

const db = env.DB;
const run = (sql: string, ...a: unknown[]) => db.prepare(sql).bind(...a).run();
const msg = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
};
const key = (id: string, name: string, hash: string, o: { write?: number; del?: number; revoked?: number | null } = {}) =>
  run(
    "INSERT INTO api_keys (id,user_id,name,prefix,hash,can_write,can_delete,expires_at,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, "u1", name, "lw_abcdefg", hash, o.write ?? 0, o.del ?? 0, 9e9, 1, o.revoked ?? null,
  );

beforeEach(async () => {
  await db.batch(["tool_calls", "api_keys", "agent_connections", "users"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
});

describe("agent tables", () => {
  it("refuses delete without write on keys and connections", async () => {
    expect(await msg(key("k1", "a", "h1", { del: 1 }))).toContain("CHECK");
    await key("k2", "b", "h2", { write: 1, del: 1 });
    expect(await msg(run(
      "INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,can_write,can_delete,created_at) VALUES ('c1','u1','x','X','claude.ai',0,1,1)",
    ))).toContain("CHECK");
  });

  it("key hash is unique", async () => {
    await key("k1", "a", "h1");
    expect(await msg(key("k2", "b", "h1"))).toContain("UNIQUE");
  });

  it("two revoked keys may share a name, two active may not", async () => {
    await key("k1", "a", "h1", { revoked: 5 });
    await key("k2", "a", "h2", { revoked: 6 });
    await key("k3", "a", "h3");
    expect(await msg(key("k4", "a", "h4"))).toContain("UNIQUE");
  });

  it("tool_calls is a plain rowid table (no sqlite_sequence entry)", async () => {
    await run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (1,'u1','Claude','c1','list_links','ok')");
    const seq = await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'sqlite_sequence'").first<{ n: number }>();
    if (seq!.n) expect(await db.prepare("SELECT COUNT(*) n FROM sqlite_sequence WHERE name = 'tool_calls'").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await msg(run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (1,'u1','C','c1','t','nope')"))).toContain("CHECK");
  });

  it("the hourly prune deletes tool_calls older than 90 days and keeps newer ones", async () => {
    const now = 2_000_000_000;
    await run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (?,'u1','C','c1','t','ok'), (?,'u1','C','c1','t','ok')",
      now - 7_776_000 - 1, now - 7_776_000 + 3600);
    expect(await pruneExpired(env, now, RUN_WRITE_BUDGET)).toBe(3);
    expect((await db.prepare("SELECT at FROM tool_calls").all<{ at: number }>()).results).toEqual([{ at: now - 7_776_000 + 3600 }]);
  });
});
