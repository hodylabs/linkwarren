import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (qs = "", email = "owner@example.com") =>
  dash(`/api/audit${qs}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } });
type Page = { items: { id: number; actorId: string; actorEmail: string | null; actorName: string | null; via: string | null; action: string; targetType: string; detail: unknown }[]; next: string | null };
const page = async (qs = "") => (await (await get(qs)).json()) as Page;
const seed = (actor: string, action: string, target: string, via: string | null = null, detail = "{}") =>
  run("INSERT INTO audit_log (at,actor_id,via,action,target_type,target_id,detail) VALUES (1,?,?,?,?,'t',?)", actor, via, action, target, detail);

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["audit_log", "domain_members", "links", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,name,role,status,created_at) VALUES ('uo','owner@example.com','Olive','owner','active',1)");
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ua','a@example.com','member','active',1)");
});

describe("GET /api/audit", () => {
  it("owner and the audit permission only (S8): a member 403, an audit role reads it", async () => {
    expect([(await get("", "a@example.com")).status, await (await get("", "a@example.com")).json()]).toEqual([403, { error: "forbidden" }]);
    await run("DELETE FROM roles WHERE builtin = 0");
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('au','Auditor','[\"audit\"]',0,1,1), ('ot','Other','[\"settings\",\"data\"]',0,1,1)");
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('uu','u@example.com','member','au','active',1), ('ux','x@example.com','member','ot','active',1)");
    await seed("uo", "link.create", "link");
    const r = await get("", "u@example.com");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Page).items.map((i) => i.action)).toEqual(["link.create"]);
    expect((await get("", "x@example.com")).status).toBe(403);
  });
  it("paginates 50 newest first, then the rest with next null", async () => {
    for (let i = 0; i < 60; i++) await seed("uo", "link.create", "link");
    const p1 = await page();
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0]!.id).toBeGreaterThan(p1.items[49]!.id);
    expect(p1.next).toBe(String(p1.items[49]!.id));
    expect(p1.items[0]).toMatchObject({ actorEmail: "owner@example.com", actorName: "Olive" });
    const p2 = await page(`?cursor=${p1.next}`);
    expect(p2.items).toHaveLength(10);
    expect(p2.next).toBeNull();
    expect(p2.items[0]!.id).toBeLessThan(p1.items[49]!.id);
  });
  it("filters and combinations", async () => {
    await seed("uo", "link.create", "link", "mcp");
    await seed("ua", "linkx.other", "link");
    await seed("ua", "domain.create", "domain");
    await seed("uo", "link.delete", "link");
    const ids = async (qs: string) => (await page(qs)).items.map((i) => i.action);
    expect(await ids("?actor=ua")).toEqual(["domain.create", "linkx.other"]);
    expect(await ids("?via=present")).toEqual(["link.create"]);
    expect(await ids("?via=absent")).toEqual(["link.delete", "domain.create", "linkx.other"]);
    expect(await ids("?action=link.")).toEqual(["link.delete", "link.create"]);
    expect(await ids("?target=domain")).toEqual(["domain.create"]);
    expect(await ids("?actor=uo&via=absent&target=link")).toEqual(["link.delete"]);
  });
  it("unknown actor rows keep null actor columns", async () => {
    await seed("gone", "link.create", "link");
    expect((await page()).items[0]).toMatchObject({ actorId: "gone", actorEmail: null, actorName: null });
  });
  it("bad params are 400", async () => {
    for (const qs of ["?action=LINK", "?target=nope", "?via=x", "?actor=", "?cursor=abc", "?cursor=0", "?cursor=-1", "?cursor=1.5"]) {
      const r = await get(qs);
      expect(r.status, qs).toBe(400);
    }
    const r = await get("?cursor=");
    expect(await r.json()).toEqual({ error: "bad_cursor" });
    expect(await (await get("?target=nope")).json()).toEqual({ error: "bad_query" });
  });
  it("redacts secrets at any depth and survives bad detail", async () => {
    await seed("uo", "x.a", "link", null, '{"host":"h","token":"t","nested":{"apiKey":"k"},"list":[{"Password":"p","ok":1}]}');
    await seed("uo", "x.b", "link", null, "not json");
    const [b, a] = (await page()).items;
    expect(a!.detail).toEqual({ host: "h", nested: {}, list: [{ ok: 1 }] });
    expect(b!.detail).toEqual({});
  });
});
