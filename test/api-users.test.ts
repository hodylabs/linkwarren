import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (email: string | null) =>
  dash("/api/users", { headers: email ? { "Cf-Access-Jwt-Assertion": await tokenFor(email) } : {} });

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role, at] of [["uo", "owner@example.com", "owner", 1], ["ua", "a@example.com", "member", 2], ["ub", "b@example.com", "member", 2]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,?)", id, email, role, "active", at);
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.test','main','active','uo',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dp','priv.test','private','active','ua',1)");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dm','ua'), ('dp','ua')"); // owner row must win over a grant
  for (const [i, by] of [["l1", "ua"], ["l2", "ua"], ["l3", "uo"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.test',?,?,1,1)", i, "dm", i, i, by, by);
});

describe("GET /api/users", () => {
  it("owner lists every user with link counts and domain access", async () => {
    const r = await get("owner@example.com");
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: { id: string; linkCount: number; domains: { id: string; host: string; via: string }[] }[] };
    expect(items.map((u) => u.id)).toEqual(["uo", "ua", "ub"]);
    expect(items.map((u) => u.linkCount)).toEqual([1, 2, 0]);
    expect(items[1]).toMatchObject({ email: "a@example.com", role: "member", createdAt: 2 });
    expect(items[1]!.domains).toEqual([{ id: "dp", host: "priv.test", via: "owner" }, { id: "dm", host: "go.test", via: "member" }]);
    expect(items[2]!.domains).toEqual([]);
  });
  it("member 403, unauthenticated 401", async () => {
    const r = await get("a@example.com");
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden" });
    expect((await get(null)).status).toBe(401);
  });
});
