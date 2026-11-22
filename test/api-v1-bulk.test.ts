import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const count = async (sql: string) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${sql}`))!.n;
const EMAIL: Record<string, string> = { uo: "owner@example.com", ua: "a@example.com" };
const now = () => Math.floor(Date.now() / 1000);

/** A key made the way a person makes one: POST /api/keys on the dashboard. */
async function key(who: string, o: { write?: boolean; del?: boolean; domainIds?: string[]; name?: string } = {}) {
  const r = await dash("/api/keys", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json" },
    body: JSON.stringify({ name: o.name ?? "ci", write: o.write ?? false, del: o.del ?? false, domainIds: o.domainIds ?? [], expiresInDays: 90 }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { secret: string }).secret;
}
/** A script: no Origin, only the Authorization header. */
const bulk = (secret: string, body: unknown) =>
  exports.default.fetch("https://dash.test/api/v1/links/bulk", {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
const dashBulk = async (who: string, body: unknown) =>
  dash("/api/links/bulk", {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json" }, body: JSON.stringify(body),
  });
type Result = { id: string; ok: boolean; error?: string };
const byId = async (r: Response) => {
  expect(r.status).toBe(200);
  const b = (await r.json()) as { results: Result[]; pending: string[] };
  return { ...Object.fromEntries(b.results.map((x) => [x.id, x.ok ? "ok" : x.error])), pending: b.pending };
};
const limits = async () =>
  Object.fromEntries((await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all<{ key: string; count: number }>()).results.map((r) => [r.key, r.count]));
const setLimit = (k: string, n: number) => run("INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, ?)", k, now(), n);
const seed = (id: string, d = "dm", by = "ua") =>
  run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", id, d, id, id, by, by);
const many = async (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  await env.DB.batch(ids.map((id) => env.DB.prepare(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'dm',?,?,'https://x.com/','ua','ua',1,1)").bind(id, id, id)));
  return ids;
};

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "auth_limits", "links", "slug_locks", "audit_log", "domain_members", "domains", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, role] of [["uo", "owner"], ["ua", "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, EMAIL[id], role);
  for (const [id, host] of [["dm", "go.test"], ["da", "a.test"]])
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'main','active','uo',1)", id, host);
  for (const id of ["l1", "l2"]) await seed(id);
  await seed("la", "da");
});

describe("scope", () => {
  it("read key: 403 read_only, nothing written", async () => {
    const r = await bulk(await key("ua"), { action: "redirect", ids: ["l1"], passQuery: false });
    expect([r.status, await r.json()]).toEqual([403, { error: "read_only" }]);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("write key without delete: delete is 403 delete_not_allowed at the v1 gate, nothing written", async () => {
    const r = await bulk(await key("ua", { write: true }), { action: "delete", ids: ["l1", "l2"] });
    expect([r.status, await r.json()]).toEqual([403, { error: "delete_not_allowed" }]);
    expect(await count("links WHERE id IN ('l1','l2')")).toBe(2);
    expect(await count("slug_locks")).toBe(0);
    // Decided at the v1 gate from the body's action, before the route's own schema (which would answer 400 here).
    const g = await bulk(await key("ua", { write: true, name: "ci2" }), { action: "delete", ids: ["l1"], extra: 1 });
    expect([g.status, await g.json()]).toEqual([403, { error: "delete_not_allowed" }]);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("write+delete key deletes; audit via is the key", async () => {
    const r = await bulk(await key("ua", { write: true, del: true, name: "cleanup" }), { action: "delete", ids: ["l1", "l2"] });
    expect(await byId(r)).toEqual({ l1: "ok", l2: "ok", pending: [] });
    expect(await count("links WHERE id IN ('l1','l2')")).toBe(0);
    expect((await env.DB.prepare("SELECT DISTINCT via FROM audit_log WHERE action = 'link.delete'").all()).results).toEqual([{ via: "API key cleanup" }]);
  });

  it("key restricted to go.test: its link ok, the a.test link forbidden", async () => {
    const s = await key("uo", { write: true, domainIds: ["dm"] });
    expect(await byId(await bulk(s, { action: "redirect", ids: ["l1", "la"], passQuery: false }))).toEqual({ l1: "ok", la: "forbidden", pending: [] });
  });

  it("the link's own creator with a key restricted to go.test cannot edit or delete their a.test link, one at a time or in bulk", async () => {
    const s = await key("ua", { write: true, del: true, domainIds: ["dm"] });
    const one1 = (method: string, body?: unknown) => exports.default.fetch("https://dash.test/api/v1/links/la", {
      method, headers: { authorization: `Bearer ${s}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect((await one1("PATCH", { url: "https://y.com/" })).status).toBe(403);
    expect((await one1("DELETE")).status).toBe(403);
    for (const b of [{ action: "redirect", ids: ["la"], passQuery: false }, { action: "delete", ids: ["la"] }, { action: "move", ids: ["la"], domainId: "dm", oldAddress: "copy" }])
      expect(await byId(await bulk(s, b))).toEqual({ la: "forbidden", pending: [] });
    expect(await one("SELECT domain_id, url, pass_query FROM links WHERE id = 'la'")).toEqual({ domain_id: "da", url: "https://x.com/", pass_query: 1 });
    expect(await count("links")).toBe(3);
  });

  it("move to a domain outside the key's domains: 403 forbidden whole", async () => {
    const s = await key("uo", { write: true, domainIds: ["dm"] });
    const r = await bulk(s, { action: "move", ids: ["l1"], domainId: "da", oldAddress: "forward" });
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await one("SELECT domain_id FROM links WHERE id = 'l1'")).toEqual({ domain_id: "dm" });
  });
});

describe("daily units (R3): one per link processed", () => {
  it("api:ud at 960, 50 links: 429 rate_limited; only the middleware's one unit is spent, nothing else by the route", async () => {
    const ids = await many(50);
    const s = await key("ua", { write: true });
    await setLimit("api:ud:ua", 960);
    const r = await bulk(s, { action: "redirect", ids, passQuery: false });
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
    const l = await limits();
    expect(l["api:ud:ua"]).toBe(961);
    expect(l["api:day"]).toBe(1);
    expect(l["bulk:kv"]).toBeUndefined();
    expect(await count("links WHERE pass_query = 0")).toBe(0);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("api:ud at 900, 50 links: 200 and the count is 950 (1 middleware, 49 route)", async () => {
    const ids = await many(50);
    const s = await key("ua", { write: true });
    await setLimit("api:ud:ua", 900);
    const r = await bulk(s, { action: "redirect", ids, passQuery: false });
    expect(r.status).toBe(200);
    const l = await limits();
    expect(l["api:ud:ua"]).toBe(950);
    expect(l["api:day"]).toBe(50);
    expect(await count("links WHERE pass_query = 0")).toBe(50);
  });

  it("a 3-link password set charges 1 unit in total (2 pending)", async () => {
    await seed("l3");
    const r = await bulk(await key("ua", { write: true }), { action: "password", ids: ["l1", "l2", "l3"], password: "correct horse battery" });
    expect(await byId(r)).toEqual({ l1: "ok", pending: ["l2", "l3"] });
    const l = await limits();
    expect([l["api:ud:ua"], l["api:day"]]).toEqual([1, 1]);
  });

  it("api:day enforced the same way", async () => {
    const ids = await many(50);
    const s = await key("ua", { write: true });
    await setLimit("api:day", 2960);
    const r = await bulk(s, { action: "redirect", ids, passQuery: false });
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
    const l = await limits();
    expect([l["api:day"], l["api:ud:ua"], l["bulk:kv"]]).toEqual([2961, 1, undefined]);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("refused links count too: 2 not_found plus 1 ok is 3 units", async () => {
    const r = await bulk(await key("ua", { write: true }), { action: "redirect", ids: ["l1", "nope1", "nope2"], passQuery: false });
    expect(await byId(r)).toEqual({ l1: "ok", nope1: "not_found", nope2: "not_found", pending: [] });
    expect((await limits())["api:ud:ua"]).toBe(3);
  });

  it("a kv_budget refusal charges no daily units beyond the middleware's one (a refused request writes nothing)", async () => {
    await setLimit("bulk:kv", 499);
    const r = await bulk(await key("ua", { write: true }), { action: "redirect", ids: ["l1", "l2"], passQuery: false });
    expect([r.status, await r.json()]).toEqual([429, { error: "kv_budget" }]);
    const l = await limits();
    expect([l["api:ud:ua"], l["api:day"], l["bulk:kv"]]).toEqual([1, 1, 499]);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("the dashboard route charges no daily units but does charge bulk:kv", async () => {
    await setLimit("api:ud:ua", 900);
    expect(await byId(await dashBulk("ua", { action: "redirect", ids: ["l1", "l2"], passQuery: false }))).toEqual({ l1: "ok", l2: "ok", pending: [] });
    const l = await limits();
    expect([l["api:ud:ua"], l["api:day"], l["bulk:kv"]]).toEqual([900, undefined, 2]);
  });
});
