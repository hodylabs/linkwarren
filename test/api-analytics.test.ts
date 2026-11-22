import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (path: string, email = "owner@example.com") =>
  dash(`/api/analytics${path}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } });
const json = async (path: string, email?: string) => (await get(path, email)).json() as Promise<any>;

const DAY = 86_400_000;
const dayAt = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const roll = (day: string, link: string, dom: string, qr: number, typed: number) =>
  run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,?,?,?,?,?)", day, link, dom, link, qr, typed);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(
    ["clicks_daily", "clicks_daily_dim", "analytics_state", "links", "slug_locks", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1),('ua','a@example.com','member','active',1),('ub','b@example.com','member','active',1)");
  const dom = (id: string, host: string, type: string, owner: string | null) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dM", "main.test", "main", "uo");
  await dom("dS", "shared.test", "shared", "uo");
  await dom("dB", "b.test", "private", "ub");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dS','ua')");
  for (const [id, d] of [["lM", "dM"], ["lS", "dS"], ["lB", "dB"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/','uo','uo',1,1)", id, d, id, id);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through', ?)", dayAt(-2));
  for (const [l, d] of [["lM", "dM"], ["lS", "dS"], ["lB", "dB"]]) await roll(dayAt(-3), l, d, 1, 2);
  await run("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES (?, 'lM','dM','country','US',5),(?, 'lM','dM','country','DE',2)", dayAt(-3), dayAt(-4));
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected fetch"); });
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/analytics", () => {
  it("unauthenticated is 401", async () => {
    expect((await dash("/api/analytics")).status).toBe(401);
  });
  it("owner sees every domain", async () => {
    const r = await json("?range=7");
    expect(r.totals.clicks).toBe(9);
    expect(r.domains.map((d: any) => d.domainId).sort()).toEqual(["dB", "dM", "dS"]);
    expect(r.live).toBe("off");
  });
  it("member sees main + granted shared only; a revoked grant drops it (Review Focus 2)", async () => {
    let r = await json("?range=7", "a@example.com");
    expect(r.totals.clicks).toBe(6);
    expect(r.domains.map((d: any) => d.domainId).sort()).toEqual(["dM", "dS"]);
    await run("DELETE FROM domain_members WHERE domain_id='dS'");
    r = await json("?range=7", "a@example.com");
    expect(r.totals.clicks).toBe(3);
    expect(r.domains.map((d: any) => d.domainId)).toEqual(["dM"]);
    expect(r.links.map((l: any) => l.linkId)).toEqual(["lM"]);
  });
  it("a disabled main domain drops out for the member, stays for the owner", async () => {
    await run("UPDATE domains SET status='disabled' WHERE id='dM'");
    expect((await json("?range=7", "a@example.com")).domains.map((d: any) => d.domainId)).toEqual(["dS"]);
    expect((await json("?range=7")).domains.map((d: any) => d.domainId)).toContain("dM");
  });
  it("domains= a domain the caller cannot use, or an unknown one, is 403", async () => {
    expect((await get("?domains=dB", "a@example.com")).status).toBe(403);
    expect((await get("?domains=nope", "a@example.com")).status).toBe(403);
    expect((await get("?domains=dM,dS", "a@example.com")).status).toBe(200);
  });
  it("bad input is 400 and never reaches AE", async () => {
    const bad = await get("?range=custom&from=2026-11-10&to=2026-11-01");
    expect([bad.status, await bad.json()]).toEqual([400, { error: "bad_range" }]);
    expect((await get("?range=5")).status).toBe(400);
    const long = await get(`?q=${"a".repeat(49)}`);
    expect([long.status, await long.json()]).toEqual([400, { error: "q_too_long" }]);
    const q = await get("?domains=a%27b");
    expect([q.status, await q.json()]).toEqual([400, { error: "bad_query" }]);
    expect((await get("?bogus=1")).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a failing Analytics Engine degrades to live unavailable, not 500", async () => {
    Object.assign(env, { CF_ACCOUNT_ID: "acc", AE_READ_TOKEN: "tok" });
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    try {
      const res = await get("?range=7");
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).live).toBe("unavailable");
    } finally {
      Object.assign(env, { CF_ACCOUNT_ID: undefined, AE_READ_TOKEN: undefined });
    }
  });
});

describe("GET /api/analytics/links", () => {
  it("returns 7 values oldest first and the top country", async () => {
    const r = await json("/links?ids=lM,lS");
    expect(r.items).toHaveLength(2);
    const m = r.items.find((i: any) => i.linkId === "lM");
    expect(m.days).toEqual([0, 0, 0, 3, 0, 0, 0]);
    expect(m).toMatchObject({ clicks: 3, qr: 1, topCountry: "US" });
    expect(r.items.find((i: any) => i.linkId === "lS").topCountry).toBeNull();
  });
  it("an id on a domain the caller cannot use is 403; unknown ids are dropped", async () => {
    expect((await get("/links?ids=lM,lB", "a@example.com")).status).toBe(403);
    expect((await json("/links?ids=lM,ghost", "a@example.com")).items.map((i: any) => i.linkId)).toEqual(["lM"]);
  });
  it("0, 51 or malformed ids are 400", async () => {
    expect((await get("/links")).status).toBe(400);
    expect((await get("/links?ids=")).status).toBe(400);
    expect((await get(`/links?ids=${Array.from({ length: 51 }, (_, i) => `l${i}`).join(",")}`)).status).toBe(400);
    expect((await get("/links?ids=a%27b")).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
