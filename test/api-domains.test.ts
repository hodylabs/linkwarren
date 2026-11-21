import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const audits = async (action: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = ?", action))!.n;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
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
  it("approve from disabled reactivates", async () => {
    await run("UPDATE domains SET status='disabled' WHERE id='dm'");
    expect(await (await call("owner", "POST", "/api/domains/dm/approve")).json()).toMatchObject({ status: "active" });
    expect(await audits("domain.approve")).toBe(1);
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
  it("locks stay case-insensitive: a deleted Fall blocks Fall and fall after flipping ON", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('t1','dm','Fall','fall','https://x.com/','uo','uo',1,1)");
    await status(await call("owner", "DELETE", "/api/links/t1"), 204);
    expect((await call("owner", "PATCH", "/api/domains/dm", { caseSensitive: true })).status).toBe(200);
    for (const slug of ["Fall", "fall"])
      await status(await call("owner", "POST", "/api/links", { domainId: "dm", slug, url: "https://x.com" }), 409, { error: "locked" });
  });
  it("OFF is refused when a lock and a live link are case twins with different keys; nothing changes", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('t1','dc','Fall','Fall','https://x.com/','uo','uo',1,1)");
    await status(await call("owner", "DELETE", "/api/links/t1"), 204);
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('t2','dc','fall','fall','https://x.com/','uo','uo',1,1)");
    await status(await call("owner", "PATCH", "/api/domains/dc", { caseSensitive: false }), 409, { error: "case_conflict" });
    expect(await one("SELECT case_sensitive c FROM domains WHERE id='dc'")).toEqual({ c: 1 });
    expect(await one("SELECT slug_key k FROM links WHERE id='t2'")).toEqual({ k: "fall" });
    expect(await audits("domain.update")).toBe(0);
  });
  it("twin locks survive a flip", async () => {
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dc','Fall',1,'uo'),('dc','fall',1,'uo')");
    expect((await call("owner", "PATCH", "/api/domains/dc", { caseSensitive: false })).status).toBe(200);
    expect((await one<{ n: number }>("SELECT COUNT(*) n FROM slug_locks WHERE domain_id='dc'"))!.n).toBe(2);
  });
  it("a flip drops stale cached link entries under both spellings", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('t1','dm','Fall','fall','https://x.com/','uo','uo',1,1)");
    await env.CACHE.put("l:dm:fall", "null");
    await env.CACHE.put("l:dm:Fall", "null");
    await call("owner", "PATCH", "/api/domains/dm", { caseSensitive: true });
    await new Promise((r) => setTimeout(r, 50));
    expect([await env.CACHE.get("l:dm:fall"), await env.CACHE.get("l:dm:Fall")]).toEqual([null, null]);
  });
  it("a redirect target whose normalized href exceeds 2048 is refused", async () => {
    const raw = `https://example.com/${"a".repeat(2000)}${"\u00e9".repeat(10)}`; // raw 2030 chars, href 2080
    await status(await call("owner", "PATCH", "/api/domains/dm", { bareRedirect: raw }), 400, { error: "url_too_long" });
  });
  it("empty patch is 400 no_changes with no write and no audit", async () => {
    await status(await call("owner", "PATCH", "/api/domains/dm", {}), 400, { error: "no_changes" });
    expect(await audits("domain.update")).toBe(0);
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
  it("a member cannot set members on their own private domain", async () => {
    await status(await call("a", "PUT", "/api/domains/dp/members", { userIds: ["ub"] }), 403);
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

describe("onboarding rules", () => {
  const link = (id: string, url: string) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?, 'dm', ?, ?, ?, 'uo','uo',1,1)", id, id, id, url);
  const pendingOf = async (u: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM domains WHERE owner_id = ? AND status = 'pending'", u))!.n;

  it("a member's pending cap is 3: the 4th is 409 with no row and no audit", async () => {
    await status(await create("a", "p2.example.com", "private"), 201);
    await status(await create("a", "p3.example.com", "private"), 201); // dp is already pending
    const before = await audits("domain.create");
    await status(await create("a", "p4.example.com", "private"), 409, { error: "pending_limit" });
    expect(await one("SELECT 1 FROM domains WHERE host = 'p4.example.com'")).toBeNull();
    expect(await audits("domain.create")).toBe(before);
    expect(await one("SELECT 1 FROM domain_cf c LEFT JOIN domains d ON d.id = c.domain_id WHERE d.id IS NULL")).toBeNull();
  });
  it("approving one frees a slot; the owner is not capped", async () => {
    await create("a", "p2.example.com", "private"); await create("a", "p3.example.com", "private");
    await status(await call("owner", "POST", "/api/domains/dp/approve"), 200);
    await status(await create("a", "p4.example.com", "private"), 201);
    for (const h of ["o1", "o2", "o3", "o4"]) await status(await create("owner", `${h}.example.com`, "shared"), 201);
  });
  it("two concurrent 4th creates leave exactly 3 pending", async () => {
    await create("a", "p2.example.com", "private");
    const rs = await Promise.all([create("a", "r1.example.com", "private"), create("a", "r2.example.com", "private")]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await pendingOf("ua")).toBe(3);
  });
  it("create writes a manual domain_cf row", async () => {
    const d = (await (await create("owner", "cf.example.com", "shared")).json()) as { id: string };
    expect(await one("SELECT kind, dns FROM domain_cf WHERE domain_id = ?", d.id)).toEqual({ kind: "manual", dns: "unknown" });
  });
  it("the CNAME target host is reserved", async () => {
    await status(await create("owner", "edge.test", "shared"), 400, { error: "reserved_host" });
    await status(await create("a", "Edge.Test.", "private"), 400, { error: "reserved_host" });
  });
  it("owner create reports loopLinks (any scheme/port); a member's response has no such key", async () => {
    await link("la", "https://promo.example.com/a"); await link("lb", "http://promo.example.com:8080/b");
    await link("lc", "https://other.example.com/a"); await link("ld", "https://x.com/?u=https://promo.example.com/z");
    const o = (await (await create("owner", "promo.example.com", "shared")).json()) as Record<string, unknown>;
    expect(o.loopLinks).toBe(2);
    const m = (await (await create("a", "promo2.example.com", "private")).json()) as Record<string, unknown>;
    expect("loopLinks" in m).toBe(false);
  });
  it("loopLinks works for a 60-char host (no LIKE pattern limit)", async () => {
    const host = `${"a".repeat(50)}.example.com`;
    await link("lh", `https://${host}/a`); await link("li", `http://${host}:81/b`);
    const o = (await (await create("owner", host, "shared")).json()) as Record<string, unknown>;
    expect(o.loopLinks).toBe(2);
  });
  it("approve as owner returns loopLinks", async () => {
    await link("la", "https://priv.test/a");
    const j = (await (await call("owner", "POST", "/api/domains/dp/approve")).json()) as { status: string; loopLinks: number };
    expect([j.status, j.loopLinks]).toEqual(["active", 1]);
  });
});
