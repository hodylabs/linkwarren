import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const get = async (path: string, email = "owner@example.com") =>
  dash(`/api/analytics${path}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } });
const json = async (path: string, email?: string) => (await get(path, email)).json() as Promise<any>;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z"); // fixed clock: no 00:00 UTC flake
const dayAt = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const roll = (day: string, link: string, dom: string, qr: number, typed: number) =>
  run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,?,?,?,?,?)", day, link, dom, link, qr, typed);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(setupAccess);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Configure AE for one test and restore the original env values afterwards. */
async function withAe<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { CLICKS: env.CLICKS, CF_ACCOUNT_ID: env.CF_ACCOUNT_ID, AE_READ_TOKEN: env.AE_READ_TOKEN };
  Object.assign(env, { CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc", AE_READ_TOKEN: "tok" });
  try {
    return await fn();
  } finally {
    Object.assign(env, prev);
  }
}

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
    await withAe(async () => {
      const bad = await get("?range=custom&from=2026-11-10&to=2026-11-01");
      expect([bad.status, await bad.json()]).toEqual([400, { error: "bad_range" }]);
      expect((await get("?range=5")).status).toBe(400);
      const long = await get(`?q=${"a".repeat(49)}`);
      expect([long.status, await long.json()]).toEqual([400, { error: "q_too_long" }]);
      const q = await get("?domains=a%27b");
      expect([q.status, await q.json()]).toEqual([400, { error: "bad_query" }]);
      expect((await get("?bogus=1")).status).toBe(400);
      expect((await get("?domains=dB", "a@example.com")).status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
  it("a failing Analytics Engine degrades to live unavailable, not 500", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    await withAe(async () => {
      const res = await get("?range=7");
      expect(res.status).toBe(200);
      const r = (await res.json()) as any;
      expect(r.live).toBe("unavailable");
      expect(r.totals.clicks).toBe(9);
    });
  });
});

describe("GET /api/analytics/links", () => {
  it("returns 7 values oldest first and the top country", async () => {
    await roll(dayAt(-5), "lM", "dM", 3, 4);
    const r = await json("/links?ids=lM,lS");
    expect(r.items).toHaveLength(2);
    const m = r.items.find((i: any) => i.linkId === "lM");
    expect(m.days).toEqual([0, 7, 0, 3, 0, 0, 0]); // today-5 = 7, today-3 = 3, so a reversed array differs
    expect(m).toMatchObject({ clicks: 10, qr: 4, topCountry: "US" });
    expect(r.items.find((i: any) => i.linkId === "lS").topCountry).toBeNull();
    expect(r.live).toBe("off");
  });
  it("a link moved onto a usable domain shows only the clicks recorded on domains the caller may use", async () => {
    await run("UPDATE links SET domain_id = 'dM' WHERE id = 'lB'"); // moved from b's private domain to main
    await roll(dayAt(-4), "lB", "dM", 0, 1);
    await run("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES (?, 'lB','dB','country','FR',9)", dayAt(-3));
    const m = (await json("/links?ids=lB", "a@example.com")).items[0];
    expect(m).toMatchObject({ clicks: 1, days: [0, 0, 1, 0, 0, 0, 0], topCountry: null });
    expect((await json("/links?ids=lB")).items[0]).toMatchObject({ clicks: 4, topCountry: "FR" }); // the owner may use both
  });
  it("the live sparkline read is limited to the member's usable domains", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    await withAe(async () => {
      await json("/links?ids=lM", "a@example.com");
      await json("/links?ids=lM");
    });
    const [member, owner] = fetchSpy.mock.calls.map((c: unknown[]) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(Object.entries(member.params).filter(([k]) => /^d\d+$/.test(k)).map(([, v]) => v).sort()).toEqual(["dM", "dS"]);
    expect(member.query).toContain("blob1 = $d");
    expect(owner.query).not.toContain("blob1 = $d");
  });
  it("an id on a domain the caller cannot use is 403; unknown ids are dropped", async () => {
    expect((await get("/links?ids=lM,lB", "a@example.com")).status).toBe(403);
    expect((await json("/links?ids=lM,ghost", "a@example.com")).items.map((i: any) => i.linkId)).toEqual(["lM"]);
  });
  it("0, 51 or malformed ids are 400", async () => {
    await withAe(async () => {
      expect((await get("/links")).status).toBe(400);
      expect((await get("/links?ids=")).status).toBe(400);
      expect((await get(`/links?ids=${Array.from({ length: 51 }, (_, i) => `l${i}`).join(",")}`)).status).toBe(400);
      expect((await get("/links?ids=a%27b")).status).toBe(400);
      expect((await get("/links?ids=lB", "a@example.com")).status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
  it("merges Analytics Engine clicks for yesterday and today onto the right sparkline points", async () => {
    fetchSpy.mockImplementation(async () =>
      Response.json({
        data: [
          { bucket: `${dayAt(-1)} 00:00:00`, linkId: "lM", qr: 4, typed: 1 },
          { bucket: `${dayAt(0)} 00:00:00`, linkId: "lM", qr: 0, typed: 6 },
          { bucket: `${dayAt(0)} 00:00:00`, linkId: "ghost", qr: 0, typed: 9 },
        ],
      }),
    );
    await withAe(async () => {
      const r = await json("/links?ids=lM,lS");
      const m = r.items.find((i: any) => i.linkId === "lM");
      expect(m.days).toEqual([0, 0, 0, 3, 0, 5, 6]); // D1 day today-3, AE today-1 and today
      expect(m).toMatchObject({ clicks: 14, qr: 5 });
      expect(r.items.find((i: any) => i.linkId === "lS").days).toEqual([0, 0, 0, 3, 0, 0, 0]);
      expect(r.live).toBe("ok");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // one AE query, not the five-query aggregate
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.params.from).toBe(`${dayAt(-1)}T00:00:00Z`); // AE starts after the D1 watermark (today-2)
  });
  it("token set but no CLICKS binding: live off and no Analytics Engine call (M1)", async () => {
    await withAe(async () => {
      const prev = env.CLICKS;
      Object.assign(env, { CLICKS: undefined });
      try {
        expect((await json("/links?ids=lM")).live).toBe("off");
        expect((await json("?range=7")).live).toBe("off");
      } finally {
        Object.assign(env, { CLICKS: prev });
      }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("Analytics Engine answering 500 keeps the D1 points and reports live unavailable", async () => {
    fetchSpy.mockImplementation(async () => new Response("no", { status: 500 }));
    await withAe(async () => {
      const res = await get("/links?ids=lM");
      expect(res.status).toBe(200);
      const r = (await res.json()) as any;
      expect(r.live).toBe("unavailable");
      expect(r.items[0]).toMatchObject({ days: [0, 0, 0, 3, 0, 0, 0], clicks: 3, topCountry: "US" });
    });
  });
});
