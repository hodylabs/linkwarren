import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const create = (who: string, host: string, extra: Record<string, unknown> = {}) =>
  call(who, "POST", "/api/domains", { host, type: who === "owner" ? "main" : "private", ...extra });
const poll = (who: string, id: string) => call(who, "GET", `/api/domains/${id}/cloudflare`);
const zones = [{ id: "zsaas", name: "saas.test" }, { id: "zo", name: "owned.test" }];
const CF = { CF_API_TOKEN: "tok-SECRET", CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw", CF_SAAS_ZONE_ID: "zsaas" };
const e = env as unknown as Record<string, string | undefined>;
const configure = (on = true) => { for (const [k, v] of Object.entries(CF)) e[k] = on ? v : undefined; };
const writes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method !== "GET");
const domainCount = async () => (await one<{ n: number }>("SELECT COUNT(*) n FROM domains"))!.n;
let now = Date.UTC(2026, 10, 1);
const advance = (s: number) => vi.setSystemTime((now += s * 1000));

beforeAll(setupAccess);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await env.DB.batch(["links", "audit_log", "domain_members", "domain_cf", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  configure();
});
afterEach(() => {
  configure(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("create: outside", () => {
  it("member adds go.outside.test: pending, CNAME instructions, one hostname and one route, DNS missing and ownership pending", async () => {
    const fake = installFakeCloudflare({ zones });
    const r = await create("a", "go.outside.test");
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j).toMatchObject({ host: "go.outside.test", status: "pending" });
    expect(j).not.toHaveProperty("loopLinks");
    expect(j.cloudflare).toMatchObject({
      kind: "outside", dns: "missing", ownership: "pending", certificate: "pending", lastError: null, attachOnApproval: false,
      instructions: { type: "CNAME", name: "go", target: "edge.test", apex: false },
    });
    expect(fake.state.hostnames.map((h) => h.hostname)).toEqual(["go.outside.test"]);
    expect(fake.state.routes.map((x) => [x.zoneId, x.pattern])).toEqual([["zsaas", "go.outside.test/*"]]);
  });
  it("apex hosts get @ and apex: true, ccTLD pairs included", async () => {
    installFakeCloudflare({ zones });
    for (const [host, name, apex] of [["outside.test", "@", true], ["example.co.uk", "@", true], ["go.example.co.uk", "go", false], ["a.b.outside.test", "a.b", false]] as const) {
      await run("DELETE FROM domains");
      const j = await (await create("a", host)).json<Record<string, any>>();
      expect([host, j.cloudflare.instructions]).toEqual([host, { type: "CNAME", name, target: "edge.test", apex }]);
    }
  });
  it("DoH pointing at the target reads found", async () => {
    installFakeCloudflare({ zones, doh: { "CNAME:go.outside.test": ["edge.test."] } });
    const j = await (await create("a", "go.outside.test")).json<Record<string, any>>();
    expect(j.cloudflare.dns).toBe("found");
  });
  it("outside without SaaS config: 400 outside_not_configured, nothing written", async () => {
    e.CF_SAAS_ZONE_ID = undefined;
    const fake = installFakeCloudflare({ zones });
    const r = await create("owner", "go.outside.test");
    expect([r.status, await r.json()]).toEqual([400, { error: "outside_not_configured" }]);
    expect(await domainCount()).toBe(0);
    expect(writes(fake.calls)).toEqual([]);
  });
  it("Cloudflare unreachable before any write: 502 cloudflare_unreachable, nothing written", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.failNext(/^\/zones\?/, 0);
    const r = await create("owner", "go.outside.test");
    expect([r.status, await r.json()]).toEqual([502, { error: "cloudflare_unreachable" }]);
    expect(await domainCount()).toBe(0);
  });
  it("Cloudflare 500 on hostname create: 201 with lastError, the poll after 10 s completes it", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.failNext(/custom_hostnames$/, 500);
    const r = await create("a", "go.outside.test");
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j.cloudflare.lastError).toBe("cloudflare_500");
    expect(fake.state.hostnames).toEqual([]);
    advance(11);
    const p = await poll("a", j.id);
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ kind: "outside", lastError: null, ownership: "pending" });
    expect(fake.state.hostnames).toHaveLength(1);
  });
});

describe("create: account", () => {
  it("member adds links.owned.test: account, attachOnApproval, zero Cloudflare writes", async () => {
    const fake = installFakeCloudflare({ zones });
    const r = await create("a", "links.owned.test");
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j.cloudflare).toMatchObject({ kind: "account", attachOnApproval: true, instructions: null, ownership: "pending" });
    expect(writes(fake.calls)).toEqual([]);
  });
  it("owner adds x.owned.test: attached, found/verified/issued", async () => {
    const fake = installFakeCloudflare({ zones });
    const r = await create("owner", "x.owned.test");
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j).toMatchObject({ status: "active", loopLinks: 0 });
    expect(j.cloudflare).toMatchObject({ kind: "account", dns: "found", ownership: "verified", certificate: "issued", attachOnApproval: false, lastError: null });
    expect(fake.state.dns.map((d) => [d.type, d.name])).toEqual([["AAAA", "x.owned.test"]]);
    expect(fake.state.routes.map((x) => [x.zoneId, x.pattern, x.script])).toEqual([["zo", "x.owned.test/*", "lw"]]);
  });
  it("owner adds www.owned.test over an existing proxied record: 409 without confirmTakeover, route only with it", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "r1", zoneId: "zo", type: "A", name: "www.owned.test", content: "192.0.2.1", proxied: true, comment: null });
    const r = await create("owner", "www.owned.test");
    expect([r.status, await r.json()]).toEqual([409, { error: "dns_record_exists" }]);
    expect(await domainCount()).toBe(0);
    expect(writes(fake.calls)).toEqual([]);
    const ok = await create("owner", "www.owned.test", { confirmTakeover: true });
    expect(ok.status).toBe(201);
    expect((await ok.json<Record<string, any>>()).cloudflare).toMatchObject({ dns: "found", ownership: "verified" });
    expect(fake.state.dns.map((d) => d.id)).toEqual(["r1"]);
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["www.owned.test/*"]);
  });
  it("pre-insert refusals use the same checks as syncDomain and write nothing", async () => {
    const cases: [string, (f: ReturnType<typeof installFakeCloudflare>) => void, boolean, string][] = [
      ["a.owned.test", (f) => f.state.dns.push({ id: "r", zoneId: "zo", type: "A", name: "a.owned.test", content: "192.0.2.1", proxied: false, comment: null }), true, "dns_not_proxied"],
      ["a.b.owned.test", (f) => f.state.dns.push({ id: "r", zoneId: "zo", type: "CNAME", name: "*.owned.test", content: "x.example.com", proxied: true, comment: null }), false, "dns_record_exists"],
      ["a.b.owned.test", (f) => f.state.dns.push({ id: "r", zoneId: "zo", type: "NS", name: "b.owned.test", content: "ns.example.com", proxied: false, comment: null }), true, "dns_not_proxied"],
      ["a.owned.test", (f) => f.state.routes.push({ id: "rt", zoneId: "zo", pattern: "*.owned.test/*", script: "other" }), true, "route_in_use"],
    ];
    for (const [host, seed, confirmTakeover, code] of cases) {
      const fake = installFakeCloudflare({ zones });
      seed(fake);
      const r = await create("owner", host, { confirmTakeover });
      expect([host, code, r.status, await r.json()]).toEqual([host, code, 409, { error: code }]);
      expect(writes(fake.calls)).toEqual([]);
      expect(await domainCount()).toBe(0);
      vi.restoreAllMocks();
    }
  });
  it("a duplicate host is host_taken before any Cloudflare call", async () => {
    const fake = installFakeCloudflare({ zones });
    expect((await create("owner", "x.owned.test")).status).toBe(201);
    const n = fake.calls.length;
    const r = await create("owner", "X.owned.test");
    expect([r.status, await r.json()]).toEqual([409, { error: "host_taken" }]);
    expect(fake.calls).toHaveLength(n);
  });
});

describe("not configured", () => {
  it("kind manual and zero fetch calls on create, list and poll", async () => {
    configure(false);
    installFakeCloudflare({ zones });
    const r = await create("owner", "go.outside.test");
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j.cloudflare).toMatchObject({ kind: "manual", instructions: null, attachOnApproval: false });
    expect((await (await call("owner", "GET", "/api/domains")).json<any[]>())[0].cloudflare.kind).toBe("manual");
    advance(60);
    expect((await (await poll("owner", j.id)).json<Record<string, any>>()).kind).toBe("manual");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("GET /api/domains", () => {
  it("items carry the stored view without Cloudflare calls", async () => {
    const fake = installFakeCloudflare({ zones });
    await create("a", "go.outside.test");
    const n = fake.calls.length;
    const items = await (await call("a", "GET", "/api/domains")).json<any[]>();
    expect(items.find((d) => d.host === "go.outside.test").cloudflare).toMatchObject({ kind: "outside", instructions: { name: "go" } });
    expect(fake.calls).toHaveLength(n);
  });
  it("a domain without a domain_cf row reads as manual", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('d1','old.example.com','main','active','uo',1)");
    const items = await (await call("owner", "GET", "/api/domains")).json<any[]>();
    expect(items[0].cloudflare).toMatchObject({ kind: "manual" });
  });
});

describe("GET /api/domains/:id/cloudflare", () => {
  it("two polls within 10 s make one round of Cloudflare calls", async () => {
    const fake = installFakeCloudflare({ zones });
    const { id } = await (await create("a", "go.outside.test")).json<{ id: string }>();
    const afterCreate = fake.calls.length;
    expect((await poll("a", id)).status).toBe(200); // snapshot is fresh
    expect(fake.calls).toHaveLength(afterCreate);
    advance(11);
    await poll("a", id);
    const afterFirst = fake.calls.length;
    expect(afterFirst).toBeGreaterThan(afterCreate);
    advance(5);
    await poll("a", id);
    expect(fake.calls).toHaveLength(afterFirst);
  });
  it("a member's poll never attaches: account stays unattached with zero writes", async () => {
    const fake = installFakeCloudflare({ zones });
    const { id } = await (await create("a", "links.owned.test")).json<{ id: string }>();
    advance(11);
    const p = await poll("a", id);
    expect(await p.json()).toMatchObject({ kind: "account", attachOnApproval: true });
    expect(writes(fake.calls)).toEqual([]);
  });
  it("member polling someone else's domain is 403, unknown is 404, owner may poll any", async () => {
    installFakeCloudflare({ zones });
    const { id } = await (await create("a", "go.outside.test")).json<{ id: string }>();
    expect([(await poll("b", id)).status, (await poll("b", "nope")).status, (await poll("owner", id)).status]).toEqual([403, 404, 200]);
  });
  it("a Cloudflare failure during refresh answers 200 with the stored view and lastError", async () => {
    const fake = installFakeCloudflare({ zones });
    const { id } = await (await create("a", "go.outside.test")).json<{ id: string }>();
    advance(11);
    fake.failNext(/custom_hostnames\?hostname=/, 500);
    const p = await poll("a", id);
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ kind: "outside", lastError: "cloudflare_500", ownership: "pending" });
  });
});
