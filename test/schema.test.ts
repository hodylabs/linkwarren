import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const db = env.DB;
const run = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();
const msg = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
};

const user = (id: string, email: string) =>
  run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,?)", id, email, "member", "active", 1);
const domain = (id: string, host: string, owner: string) =>
  run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,?)", id, host, "main", "active", owner, 1);
const link = (id: string, dom: string, key: string, code = 302) =>
  run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, dom, key, key, "https://x.test", code, "u1", "u1", 1, 1,
  );

describe("schema", () => {
  it("enforces per-domain slug_key uniqueness", async () => {
    await user("u1", "o@x.com");
    await domain("d1", "a.test", "u1");
    await domain("d2", "b.test", "u1");
    await link("l1", "d1", "spring");
    expect(await msg(link("l2", "d1", "spring"))).toContain("UNIQUE");
    await link("l3", "d2", "spring");
  });

  it("makes user email unique case-insensitively", async () => {
    await user("u2", "A@x.com");
    expect(await msg(user("u3", "a@x.com"))).toContain("UNIQUE");
  });

  it("rejects redirect_code 307", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','member','active',1)");
    await domain("d3", "c.test", "u1");
    expect(await msg(link("l4", "d3", "k", 307))).toContain("CHECK");
  });
});
