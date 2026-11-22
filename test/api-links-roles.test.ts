import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMBER_DEFAULT } from "../src/roles";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";

// S8 R9: link edits, deletes and slug lock releases follow the person's role; WHICH domains stays per person.
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const count = async (sql: string, ...a: unknown[]) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${sql}`, ...a))!.n;
const role = (id: string, perms: readonly string[]) =>
  run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, `Role ${id}`, JSON.stringify(perms));
const setPerms = (id: string, perms: readonly string[]) => run("UPDATE roles SET perms = ? WHERE id = ?", JSON.stringify(perms), id);

async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(`${who}@example.com`), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const answer = async (r: Response) => [r.status, r.status === 204 ? null : await r.json()];
const forbidden = [403, { error: "forbidden" }];
const seed = (id: string, by: string, domain = "dm") =>
  run(`INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/a',?,?,1,10)`, id, domain, id, id, by, by);

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("UPDATE roles SET perms = ? WHERE id = 'member'", JSON.stringify(MEMBER_DEFAULT));
  await role("ro", []);
  await role("hl", ["links.create"]);
  await role("ea", ["links.create", "links.editAny"]);
  await role("dmg", ["links.create", "domains.manage"]);
  for (const [id, roleId] of [["owner", null], ["a", null], ["v", "ro"], ["h", "hl"], ["e", "ea"], ["d", "dmg"]])
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,'active',1)", id, `${id}@example.com`, id === "owner" ? "owner" : "member", roleId);
  const dom = (id: string, host: string, type: string, owner: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dm", "go.test", "main", "owner");
  await dom("ds", "shared.test", "shared", "owner");
  // a and v use the shared domain; e and d do not.
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds','a'),('ds','v')");
  await seed("la", "a");
  await seed("ls", "a", "ds");
  await seed("lv", "v");
});

describe("links.create", () => {
  it("a role without it: 403 on create (before the body is read), on editing and deleting its own earlier link; 200 reading it", async () => {
    expect(await answer(await call("v", "POST", "/api/links", { domainId: "dm", slug: "n", url: "https://x.com" }))).toEqual(forbidden);
    expect(await answer(await call("v", "POST", "/api/links", "{nope"))).toEqual(forbidden);
    expect(await answer(await call("v", "PATCH", "/api/links/lv", { url: "https://y.com" }))).toEqual(forbidden);
    expect(await answer(await call("v", "DELETE", "/api/links/lv"))).toEqual(forbidden);
    expect((await call("v", "GET", "/api/links/lv")).status).toBe(200);
    expect(await one("SELECT url FROM links WHERE id = 'lv'")).toEqual({ url: "https://x.com/a" });
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("with it, a role creates and edits its own link", async () => {
    const r = await call("h", "POST", "/api/links", { domainId: "dm", slug: "mine", url: "https://x.com" });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await call("h", "PATCH", `/api/links/${id}`, { url: "https://y.com" })).status).toBe(200);
    // but not a teammate's
    expect(await answer(await call("h", "PATCH", "/api/links/la", { url: "https://y.com" }))).toEqual(forbidden);
  });

  it("race: links.create removed between the pre-read and the insert writes nothing and answers 403", async () => {
    const restore = beforeBatch(2, () => setPerms("hl", []));
    let r;
    try { r = await call("h", "POST", "/api/links", { domainId: "dm", slug: "late", url: "https://x.com" }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await count("links WHERE slug = 'late'")).toBe(0);
    expect(await count("audit_log WHERE action = 'link.create'")).toBe(0);
  });

  it("a slug lock still answers 409 locked when the permission holds", async () => {
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dm','held',1,'owner')");
    expect(await answer(await call("h", "POST", "/api/links", { domainId: "dm", slug: "held", url: "https://x.com" }))).toEqual([409, { error: "locked" }]);
  });

  it("race: links.create removed before an own-link PATCH or DELETE write: 403, nothing written", async () => {
    await seed("lh", "h");
    let restore = beforeBatch(2, () => setPerms("hl", []));
    let r;
    try { r = await call("h", "PATCH", "/api/links/lh", { url: "https://y.com" }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await one("SELECT url, updated_at FROM links WHERE id = 'lh'")).toEqual({ url: "https://x.com/a", updated_at: 10 });
    await setPerms("hl", ["links.create"]);
    restore = beforeBatch(2, () => setPerms("hl", []));
    try { r = await call("h", "DELETE", "/api/links/lh"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await count("links WHERE id = 'lh'")).toBe(1);
    expect(await count("slug_locks")).toBe(0);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });
});

describe("links.editAny", () => {
  it("edits and deletes a teammate's link on a usable domain; 403 on a shared domain they cannot use", async () => {
    expect((await call("e", "PATCH", "/api/links/la", { url: "https://y.com" })).status).toBe(200);
    expect(await answer(await call("e", "PATCH", "/api/links/ls", { url: "https://y.com" }))).toEqual(forbidden);
    expect(await answer(await call("e", "DELETE", "/api/links/ls"))).toEqual(forbidden);
    expect((await call("e", "DELETE", "/api/links/la")).status).toBe(204);
    expect(await count("links WHERE id = 'ls'")).toBe(1);
  });

  it("domains.manage alone does not edit or delete a teammate's link", async () => {
    expect(await answer(await call("d", "PATCH", "/api/links/la", { url: "https://y.com" }))).toEqual(forbidden);
    expect(await answer(await call("d", "DELETE", "/api/links/la"))).toEqual(forbidden);
  });

  it("race: links.editAny removed before the PATCH or DELETE write: 403, nothing written", async () => {
    let restore = beforeBatch(2, () => setPerms("ea", ["links.create"]));
    let r;
    try { r = await call("e", "PATCH", "/api/links/la", { url: "https://y.com" }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    await setPerms("ea", ["links.create", "links.editAny"]);
    restore = beforeBatch(2, () => setPerms("ea", ["links.create"]));
    try { r = await call("e", "DELETE", "/api/links/la"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await one("SELECT url FROM links WHERE id = 'la'")).toEqual({ url: "https://x.com/a" });
    expect(await count("slug_locks")).toBe(0);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });
});

describe("slug lock release", () => {
  beforeEach(() => run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dm','gone',1,'owner'),('ds','gone',1,'owner')"));

  it("403 for Member and domains.manage (before any lookup), 204 for links.editAny on a usable domain, 403 on one it cannot use", async () => {
    expect(await answer(await call("a", "DELETE", "/api/locks/dm/gone"))).toEqual(forbidden);
    expect(await answer(await call("d", "DELETE", "/api/locks/dm/gone"))).toEqual(forbidden);
    expect(await answer(await call("a", "DELETE", "/api/locks/nope/gone"))).toEqual(forbidden);
    expect(await answer(await call("e", "DELETE", "/api/locks/ds/gone"))).toEqual(forbidden);
    expect(await count("slug_locks")).toBe(2);
    expect((await call("e", "DELETE", "/api/locks/dm/gone")).status).toBe(204);
    expect(await count("slug_locks WHERE domain_id = 'dm'")).toBe(0);
    expect(await count("audit_log WHERE action = 'lock.release' AND actor_id = 'e'")).toBe(1);
    expect((await call("owner", "DELETE", "/api/locks/ds/gone")).status).toBe(204);
  });

  it("race: links.editAny removed before the release writes nothing and answers 403", async () => {
    const restore = beforeBatch(1, () => setPerms("ea", ["links.create"]));
    let r;
    try { r = await call("e", "DELETE", "/api/locks/dm/gone"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await count("slug_locks WHERE domain_id = 'dm'")).toBe(1);
    expect(await count("audit_log WHERE action = 'lock.release'")).toBe(0);
  });
});
