import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const audits = async (action: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = ?", action))!.n;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return exports.default.fetch(`https://dash.test${path}`, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const create = (who: string, host: string, type: string) => call(who, "POST", "/api/domains", { host, type });
const status = async (r: Response, s: number, j?: unknown) => { expect(r.status).toBe(s); if (j !== undefined) expect(await r.json()).toEqual(j); };

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  const dom = (id: string, host: string, type: string, status: string, owner: string, cs = 0) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES (?,?,?,?,?,?,1)", id, host, type, status, owner, cs);
  await dom("dm", "go.test", "main", "active", "uo");
  await dom("ds", "shared.test", "shared", "active", "uo");
  await dom("dp", "priv.test", "private", "pending", "ua");
  await dom("dc", "case.test", "main", "active", "uo", 1);
});

describe("create", () => {
  it("owner creates any type, active, one audit", async () => {
    const r = await create("owner", "New.Example.com.", "shared");
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ host: "new.example.com", type: "shared", status: "active", ownerId: "uo" });
    expect(await audits("domain.create")).toBe(1);
  });
  it("member: shared 403, main 403, private 201 pending owned by member", async () => {
    await status(await create("a", "x.example.com", "shared"), 403, { error: "forbidden" });
    await status(await create("a", "y.example.com", "main"), 403);
    const r = await create("a", "z.example.com", "private");
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ type: "private", status: "pending", ownerId: "ua" });
  });
  it("duplicate host in any case or with trailing dot is 409 host_taken", async () => {
    await status(await create("owner", "GO.TEST", "main"), 409, { error: "host_taken" });
    await status(await create("owner", "go.test.", "main"), 409, { error: "host_taken" });
    await status(await create("owner", "go.test:443", "main"), 409, { error: "host_taken" });
  });
  it("dashboard host 400 dashboard_host", async () => {
    await status(await create("owner", "DASH.test.", "main"), 400, { error: "dashboard_host" });
  });
  it("rejects invalid hostnames and bad bodies", async () => {
    for (const h of ["localhost", "nodot", "1.2.3.4", "[::1]", "a_b.example.com", "-a.example.com", "a..example.com", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, "x.com/path", ""])
      expect([h, (await create("owner", h, "main")).status]).toEqual([h, 400]);
    await status(await create("owner", "ok.example.com", "weird"), 400);
    await status(await call("owner", "POST", "/api/domains", { host: "ok.example.com", type: "main", extra: 1 }), 400);
  });
  it("creating clears a cached negative lookup so the host resolves", async () => {
    expect((await exports.default.fetch("https://fresh.example.com/x", { redirect: "manual" })).status).toBe(404);
    await create("owner", "fresh.example.com", "main");
    const r = await exports.default.fetch("https://fresh.example.com/x", { redirect: "manual" });
    expect(r.status).toBe(404); // known host, unknown slug; the cache now holds the domain, not a miss
    expect(await env.CACHE.get("h:fresh.example.com")).toContain("fresh.example.com");
  });
});

describe("approve and disable", () => {
  it("member approve 403; owner approve activates, audits and the redirect resolves", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l1','dp','p','p','https://x.com/',?,?,1,1)", "ua", "ua");
    expect(await (await exports.default.fetch("https://priv.test/p", { redirect: "manual" })).text()).toMatch(/not active yet/i);
    await status(await call("a", "POST", "/api/domains/dp/approve"), 403);
    const r = await call("owner", "POST", "/api/domains/dp/approve");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active" });
    expect(await audits("domain.approve")).toBe(1);
    const red = await exports.default.fetch("https://priv.test/p", { redirect: "manual" });
    expect([red.status, red.headers.get("location")]).toEqual([302, "https://x.com/"]);
  });
  it("approve of an active domain is an idempotent 200", async () => {
    expect((await call("owner", "POST", "/api/domains/dm/approve")).status).toBe(200);
  });
  it("disable: owner only, 404 unknown", async () => {
    await status(await call("a", "POST", "/api/domains/dp/disable"), 403);
    await status(await call("owner", "POST", "/api/domains/nope/disable"), 404);
    const r = await call("owner", "POST", "/api/domains/dm/disable");
    expect(await r.json()).toMatchObject({ status: "disabled" });
    expect(await audits("domain.disable")).toBe(1);
  });
});

describe("settings", () => {
  it("another member 403; domain owner and owner can patch", async () => {
    await status(await call("b", "PATCH", "/api/domains/dp", { noindex: false }), 403);
    expect((await call("a", "PATCH", "/api/domains/dp", { noindex: false })).status).toBe(200);
    expect(await audits("domain.update")).toBe(1);
    expect(await one("SELECT noindex FROM domains WHERE id='dp'")).toEqual({ noindex: 0 });
  });
  it("redirect targets are validated and normalized; null clears", async () => {
    await status(await call("owner", "PATCH", "/api/domains/dm", { bareRedirect: "javascript:alert(1)" }), 400);
    await status(await call("owner", "PATCH", "/api/domains/dm", { notfoundRedirect: "https://go.test/x" }), 400, { error: "loop" });
    const r = await call("owner", "PATCH", "/api/domains/dm", { bareRedirect: "HTTPS://Example.COM" });
    expect(await r.json()).toMatchObject({ bareRedirect: "https://example.com/" });
    const c = await call("owner", "PATCH", "/api/domains/dm", { bareRedirect: null });
    expect(await c.json()).toMatchObject({ bareRedirect: null });
  });
  it("reservedExtra: slugs validated, max 100", async () => {
    await status(await call("owner", "PATCH", "/api/domains/dm", { reservedExtra: ["bad slug"] }), 400);
    await status(await call("owner", "PATCH", "/api/domains/dm", { reservedExtra: Array.from({ length: 101 }, (_, i) => `s${i}`) }), 400);
    const r = await call("owner", "PATCH", "/api/domains/dm", { reservedExtra: ["promo"] });
    expect(await r.json()).toMatchObject({ reservedExtra: ["promo"] });
  });
  it("invalidates the cached domain row", async () => {
    await exports.default.fetch("https://go.test/none", { redirect: "manual" });
    await call("owner", "PATCH", "/api/domains/dm", { notfoundRedirect: "https://nf.example.com/" });
    const r = await exports.default.fetch("https://go.test/none", { redirect: "manual" });
    expect(r.headers.get("location")).toBe("https://nf.example.com/");
  });
  it("case_conflict when turning caseSensitive off with case twins; rekeys otherwise; ON rekeys to exact slug", async () => {
    const ins = (id: string, slug: string, key: string) =>
      run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?, 'dc', ?, ?, 'https://x.com/','uo','uo',1,1)", id, slug, key);
    await ins("t1", "Fall", "Fall");
    await ins("t2", "fall", "fall");
    await status(await call("owner", "PATCH", "/api/domains/dc", { caseSensitive: false }), 409, { error: "case_conflict" });
    expect(await one("SELECT case_sensitive c FROM domains WHERE id='dc'")).toEqual({ c: 1 });
    await run("DELETE FROM links WHERE id='t2'");
    expect((await call("owner", "PATCH", "/api/domains/dc", { caseSensitive: false })).status).toBe(200);
    expect(await one("SELECT slug_key k FROM links WHERE id='t1'")).toEqual({ k: "fall" });
    expect((await call("owner", "PATCH", "/api/domains/dc", { caseSensitive: true })).status).toBe(200);
    expect(await one("SELECT slug_key k FROM links WHERE id='t1'")).toEqual({ k: "Fall" });
  });
  it("404 unknown; strict body", async () => {
    await status(await call("owner", "PATCH", "/api/domains/nope", { noindex: true }), 404);
    await status(await call("owner", "PATCH", "/api/domains/dm", { host: "x.example.com" }), 400);
  });
});

describe("members", () => {
  it("owner only; grants use of a shared domain; replaces the set; audits", async () => {
    await status(await call("a", "PUT", "/api/domains/ds/members", { userIds: ["ua"] }), 403);
    const link = { domainId: "ds", slug: "s", url: "https://x.com" };
    expect((await call("a", "POST", "/api/links", link)).status).toBe(403);
    expect((await call("owner", "PUT", "/api/domains/ds/members", { userIds: ["ua", "ua", "ub"] })).status).toBe(200);
    expect((await call("a", "POST", "/api/links", link)).status).toBe(201);
    await call("owner", "PUT", "/api/domains/ds/members", { userIds: ["ub"] });
    expect(await env.DB.prepare("SELECT user_id FROM domain_members WHERE domain_id='ds'").all()).toMatchObject({ results: [{ user_id: "ub" }] });
    expect(await audits("domain.members")).toBe(2);
  });
  it("400 for main domains and unknown users (state unchanged), 404 unknown domain", async () => {
    await status(await call("owner", "PUT", "/api/domains/dm/members", { userIds: [] }), 400);
    await status(await call("owner", "PUT", "/api/domains/ds/members", { userIds: ["ua", "ghost"] }), 400, { error: "unknown_user" });
    expect((await one<{ n: number }>("SELECT COUNT(*) n FROM domain_members"))!.n).toBe(0);
    await status(await call("owner", "PUT", "/api/domains/nope/members", { userIds: [] }), 404);
  });
});

describe("list", () => {
  it("owner sees all; member sees usable only, with linkCount and isMember", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l1','dm','a','a','https://x.com/','uo','uo',1,1)");
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds','ua')");
    const all = (await (await call("owner", "GET", "/api/domains")).json()) as { id: string }[];
    expect(all.map((d) => d.id).sort()).toEqual(["dc", "dm", "dp", "ds"]);
    const mine = (await (await call("a", "GET", "/api/domains")).json()) as { id: string; linkCount: number; isMember: boolean }[];
    expect(mine.map((d) => d.id).sort()).toEqual(["dc", "dm", "dp", "ds"]);
    expect(mine.find((d) => d.id === "dm")).toMatchObject({ linkCount: 1, isMember: false });
    expect(mine.find((d) => d.id === "ds")).toMatchObject({ isMember: true });
    const b = (await (await call("b", "GET", "/api/domains")).json()) as { id: string }[];
    expect(b.map((d) => d.id).sort()).toEqual(["dc", "dm"]);
  });
});
