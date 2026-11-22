import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const count = async (sql: string, ...a: unknown[]) => (await one<{ n: number }>(sql, ...a))!.n;
const audits = (action: string) => count("SELECT COUNT(*) n FROM audit_log WHERE action = ?", action);
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const create = async (who: string, host: string) => {
  const r = await call(who, "POST", "/api/domains", { host, type: who === "owner" ? "main" : "private" });
  expect(r.status).toBe(201);
  return (await r.json<{ id: string }>()).id;
};
const approve = (id: string, body?: unknown) => call("owner", "POST", `/api/domains/${id}/approve`, body);
const reject = (id: string, who = "owner") => call(who, "DELETE", `/api/domains/${id}`);
const statusOf = async (id: string) => (await one<{ status: string }>("SELECT status FROM domains WHERE id = ?", id))?.status ?? null;
const zones = [{ id: "zsaas", name: "saas.test" }, { id: "zo", name: "owned.test" }];
const CF = { CF_API_TOKEN: "tok-SECRET", CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw", CF_SAAS_ZONE_ID: "zsaas" };
const e = env as unknown as Record<string, string | undefined>;
const configure = (on = true) => { for (const [k, v] of Object.entries(CF)) e[k] = on ? v : undefined; };
const writes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method !== "GET");
type Fake = ReturnType<typeof installFakeCloudflare>;
/** DNS at the target, hostname ownership and certificate active. */
const green = (f: Fake, host: string) => {
  f.state.doh[`CNAME:${host}`] = ["edge.test."];
  for (const h of f.state.hostnames) { h.status = "active"; h.ssl = { status: "active" }; }
};

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domain_cf", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  configure();
});
afterEach(() => {
  configure(false);
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("approve gate", () => {
  it("outside with DNS missing: 409 not_verified with the view, still pending, no approve audit", async () => {
    installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    const r = await approve(id);
    expect(r.status).toBe(409);
    const j = await r.json<Record<string, any>>();
    expect(j.error).toBe("not_verified");
    expect(j.cloudflare).toMatchObject({ kind: "outside", dns: "missing" });
    expect(await statusOf(id)).toBe("pending");
    expect(await audits("domain.approve")).toBe(0);
  });
  it("outside all green: 200 active, audit detail has the check, response has cloudflare and loopLinks", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    green(fake, "go.outside.test");
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active", loopLinks: 0, cloudflare: { dns: "found", ownership: "verified", certificate: "issued" } });
    const a = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'domain.approve'");
    expect(JSON.parse(a!.detail)).toMatchObject({ from: "pending", check: { dns: "found", ownership: "verified", certificate: "issued" } });
  });
  it("account: approving the member's links.owned.test attaches, then active", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("a", "links.owned.test");
    expect(writes(fake.calls)).toEqual([]);
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active", cloudflare: { kind: "account", ownership: "verified", attachOnApproval: false } });
    expect(fake.state.dns.map((d) => d.name)).toEqual(["links.owned.test"]);
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["links.owned.test/*"]);
  });
  it("account takeover: 409 dns_record_exists without confirmTakeover and zero writes; with it route only, active", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "r1", zoneId: "zo", type: "A", name: "www.owned.test", content: "192.0.2.1", proxied: true, comment: null });
    const id = await create("a", "www.owned.test");
    const r = await approve(id);
    expect([r.status, await r.json()]).toEqual([409, { error: "dns_record_exists" }]);
    expect(writes(fake.calls)).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    const ok = await approve(id, { confirmTakeover: true });
    expect(ok.status).toBe(200);
    expect(await statusOf(id)).toBe("active");
    expect(fake.state.dns.map((d) => d.id)).toEqual(["r1"]);
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["www.owned.test/*"]);
  });
  it("a Cloudflare failure during the fresh sync is 502 cloudflare_error, still pending", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    fake.failNext(/custom_hostnames\?/, 500);
    const r = await approve(id);
    expect([r.status, await r.json()]).toEqual([502, { error: "cloudflare_error" }]);
    expect(await statusOf(id)).toBe("pending");
  });
  it("an unknown body is 400", async () => {
    installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    expect((await approve(id, { nope: 1 })).status).toBe(400);
  });
  it("manual approve is unchanged from S1", async () => {
    configure(false);
    const id = await create("a", "priv.test");
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active", cloudflare: { kind: "manual" } });
    expect(await audits("domain.approve")).toBe(1);
  });
  it("half-attached active account domain: approve finishes the attach with a domain.attach audit and no status batch", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "x.owned.test");
    fake.state.routes.length = 0;
    await run("UPDATE domain_cf SET route_id = NULL WHERE domain_id = ?", id);
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "active", cloudflare: { kind: "account", ownership: "verified" } });
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["x.owned.test/*"]);
    expect([await audits("domain.attach"), await audits("domain.approve")]).toEqual([1, 0]);
    const a = await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'domain.attach'");
    expect(JSON.parse(a!.detail)).toEqual({ host: "x.owned.test" });
    // Attached now: a second approve is the S1 idempotent 200 with no Cloudflare writes.
    const n = writes(fake.calls).length;
    expect((await approve(id)).status).toBe(200);
    expect(writes(fake.calls)).toHaveLength(n);
    expect(await audits("domain.attach")).toBe(1);
  });
});

describe("reject", () => {
  async function seeded(fake: Fake) {
    const id = await create("a", "go.outside.test");
    for (const s of ["p", "q", "r"])
      await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/','ua','ua',1,1)", `l${s}`, id, s, s);
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES (?,'old',1,'ua')", id);
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES (?,'ua')", id);
    expect(fake.state.hostnames).toHaveLength(1);
    expect(fake.state.routes).toHaveLength(1);
    return id;
  }
  const leftovers = async (id: string) => Promise.all(["domains WHERE id", "links WHERE domain_id", "slug_locks WHERE domain_id", "domain_members WHERE domain_id", "domain_cf WHERE domain_id"]
    .map((t) => count(`SELECT COUNT(*) n FROM ${t} = ?`, id)));

  it("member 403, active 409 not_pending", async () => {
    installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    expect((await reject(id, "a")).status).toBe(403);
    const act = await create("owner", "x.owned.test");
    const r = await reject(act);
    expect([r.status, await r.json()]).toEqual([409, { error: "not_pending" }]);
    expect((await reject("nope")).status).toBe(404);
  });
  it("pending with 3 links and a lock: 204, everything gone in D1 and Cloudflare, one audit, the host answers 404", async () => {
    const fake = await installFakeCloudflare({ zones });
    const id = await seeded(fake);
    const before = await exports.default.fetch("https://go.outside.test/p", { redirect: "manual" });
    expect(await before.text()).toMatch(/not active yet/i); // warms the KV host and link entries
    const r = await reject(id);
    expect(r.status).toBe(204);
    expect(await leftovers(id)).toEqual([0, 0, 0, 0, 0]);
    expect(await count("SELECT COUNT(*) n FROM slug_locks")).toBe(0); // no lock written on reject
    const a = await one<{ detail: string; n: number }>("SELECT detail, (SELECT COUNT(*) FROM audit_log WHERE action = 'domain.reject') n FROM audit_log WHERE action = 'domain.reject'");
    expect([a!.n, JSON.parse(a!.detail)]).toEqual([1, { host: "go.outside.test", links: 3, owner: "ua" }]);
    expect([fake.state.hostnames, fake.state.routes]).toEqual([[], []]);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM audit_log").all())).not.toContain("tok-SECRET");
    const after = await exports.default.fetch("https://go.outside.test/p", { redirect: "manual" });
    expect(after.status).toBe(404);
    expect(await after.text()).not.toMatch(/not active yet/i);
  });
  it("route delete fails with 500: 502 cloudflare_error and nothing in D1 changed", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await seeded(fake);
    fake.failNext(/workers\/routes\//, 500);
    const r = await reject(id);
    expect([r.status, await r.json()]).toEqual([502, { error: "cloudflare_error" }]);
    expect(await leftovers(id)).toEqual([1, 3, 1, 1, 1]);
    expect(await audits("domain.reject")).toBe(0);
  });
  it("hostname already gone (404) still answers 204", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await seeded(fake);
    fake.state.hostnames.length = 0;
    expect((await reject(id)).status).toBe(204);
    expect(fake.state.routes).toEqual([]);
  });
  it("an id stored by a concurrent sync after detach read the row is cleaned up after the delete", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await seeded(fake);
    // Lands between detach and the delete batch: a sync that created a new route and stored its id.
    const restore = beforeBatch(1, async () => {
      fake.state.routes.push({ id: "late", zoneId: "zsaas", pattern: "go.outside.test/*", script: "lw" });
      await run("UPDATE domain_cf SET route_id = 'late' WHERE domain_id = ?", id);
    });
    try {
      expect((await reject(id)).status).toBe(204);
    } finally { restore(); }
    expect(fake.state.routes).toEqual([]);
  });
});

describe("approve racing reject", () => {
  it("approve lands first: reject is 409 conflict, one approve audit, and the domain is repaired in Cloudflare", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    green(fake, "go.outside.test");
    let inner: Response | null = null;
    // Approve runs to completion after reject read the pending status, just before reject's first Cloudflare delete.
    vi.mocked(fetch).mockImplementation(async (i, init) => {
      const req = new Request(i as RequestInfo, init);
      if (!inner && req.method === "DELETE") inner = await approve(id);
      return fake.handle(req);
    });
    const r = await reject(id);
    expect(inner!.status).toBe(200);
    expect([r.status, await r.json()]).toEqual([409, { error: "conflict" }]);
    expect([await audits("domain.approve"), await audits("domain.reject")]).toEqual([1, 0]);
    expect(await statusOf(id)).toBe("active");
    expect(fake.state.hostnames).toHaveLength(1);
    expect(fake.state.routes).toHaveLength(1);
  });
  it("reject lands first: approve is 404, one reject audit, nothing left", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("a", "go.outside.test");
    green(fake, "go.outside.test");
    let inner: Response | null = null;
    const restore = beforeBatch(1, async () => { inner = await reject(id); });
    let r: Response;
    try { r = await approve(id); } finally { restore(); }
    expect(inner!.status).toBe(204);
    expect(r.status).toBe(404);
    expect([await audits("domain.approve"), await audits("domain.reject")]).toEqual([0, 1]);
    expect(await statusOf(id)).toBeNull();
    expect([fake.state.hostnames, fake.state.routes]).toEqual([[], []]);
  });
});
