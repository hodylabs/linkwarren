import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitRule, securityRule } from "../src/cf/controls";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const zones = [{ id: "zsaas", name: "saas.test" }, { id: "zo", name: "owned.test" }];
const CF = { CF_API_TOKEN: "tok-SECRET", CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw", CF_SAAS_ZONE_ID: "zsaas", CF_CNAME_TARGET: "edge.test" };
const e = env as unknown as Record<string, string | undefined>;
const configure = (on = true) => { for (const [k, v] of Object.entries(CF)) e[k] = on ? v : undefined; };
const controls = (v: "1" | "0") =>
  run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('cf.controls',?,1,'uo') ON CONFLICT(key) DO UPDATE SET value = excluded.value", v);
const create = async (who: string, host: string) => {
  const r = await call(who, "POST", "/api/domains", { host, type: who === "owner" ? "shared" : "private" });
  expect(r.status).toBe(201);
  return (await r.json<{ id: string }>()).id;
};
const setCf = (id: string, body: unknown, who = "owner") => call(who, "PATCH", `/api/domains/${id}/cloudflare`, body);
const row = (id: string) => one<{ security_level: string | null; rate_limit: number | null }>("SELECT security_level, rate_limit FROM domain_cf WHERE domain_id = ?", id);
const audits = async () => (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'domain.cloudflare'").all<{ detail: string }>()).results.map((r) => JSON.parse(r.detail));
const SEC = "zo/http_config_settings", RL = "zo/http_ratelimit";
const foreign = { id: "f1", ref: "theirs", expression: "true", action: "set_config", action_parameters: { security_level: "low" } };

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domain_cf", "domains", "users", "settings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  configure();
  await controls("1");
});
afterEach(() => {
  configure(false);
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("rule builders", () => {
  it("build the exact rule objects", () => {
    expect(securityRule("d1", "go.owned.test", "high")).toEqual({
      ref: "lw-d1-sec", expression: 'http.host eq "go.owned.test"', action: "set_config", action_parameters: { security_level: "high" }, description: "linkwarren security level",
    });
    expect(rateLimitRule("d1", "go.owned.test", 50)).toEqual({
      ref: "lw-d1-rl", expression: 'http.host eq "go.owned.test"', action: "block",
      ratelimit: { characteristics: ["ip.src", "cf.colo.id"], period: 10, requests_per_period: 50, mitigation_timeout: 10 }, description: "linkwarren rate limit",
    });
  });
  it("refuse a host that could break out of the expression", () => {
    expect(() => securityRule("d1", 'go.owned.test" or true or "', "high")).toThrow();
    expect(() => rateLimitRule("d1", "GO.owned.test", 50)).toThrow();
  });
});

describe("PATCH /api/domains/:id/cloudflare", () => {
  it("the domain list carries the stored controls so the dashboard can show them", async () => {
    installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    expect((await setCf(id, { securityLevel: "high", rateLimit: 40 })).status).toBe(200);
    const list = await (await call("owner", "GET", "/api/domains")).json<{ id: string; cloudflare: { securityLevel: string | null; rateLimit: number | null } }[]>();
    expect(list.find((d) => d.id === id)!.cloudflare).toMatchObject({ securityLevel: "high", rateLimit: 40 });
  });

  it("a second edit while the first is between Cloudflare and D1 is 409 conflict, so both stores keep the same value", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    let inner: unknown[] | null = null;
    vi.mocked(fetch).mockImplementation(async (i, init) => {
      const req = new Request(i as RequestInfo, init);
      const res = await fake.handle(req);
      if (!inner && req.method === "POST" && req.url.includes("/rulesets")) inner = await setCf(id, { securityLevel: "low" }).then(async (x) => [x.status, await x.json()]);
      return res;
    });
    expect((await setCf(id, { securityLevel: "high" })).status).toBe(200);
    expect(inner).toEqual([409, { error: "conflict" }]);
    expect((await row(id))!.security_level).toBe("high");
    expect(fake.state.rulesets[SEC]!.rules.map((x) => (x.action_parameters as { security_level: string }).security_level)).toEqual(["high"]);
  });

  it("high creates the entrypoint with only our rule, stores it, one audit; low patches the same rule", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    fake.calls.length = 0;
    const r = await setCf(id, { securityLevel: "high" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ securityLevel: "high", rateLimit: null });
    const create1 = fake.calls.find((c) => c.method === "POST")!;
    expect(create1.path).toBe("/zones/zo/rulesets");
    expect(create1.body).toEqual({ name: "default", kind: "zone", phase: "http_config_settings", rules: [securityRule(id, "go.owned.test", "high")] });
    expect(fake.state.rulesets[SEC]!.rules).toHaveLength(1);
    const ruleId = fake.state.rulesets[SEC]!.rules[0]!.id;
    expect(await row(id)).toEqual({ security_level: "high", rate_limit: null });
    expect(await audits()).toEqual([{ host: "go.owned.test", securityLevel: "high" }]);

    fake.calls.length = 0;
    expect((await setCf(id, { securityLevel: "low" })).status).toBe(200);
    expect(fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH /zones/zo/rulesets/${fake.state.rulesets[SEC]!.id}/rules/${ruleId}`]);
    expect(fake.state.rulesets[SEC]!.rules).toEqual([{ id: ruleId, ...securityRule(id, "go.owned.test", "low") }]);
    expect((await row(id))!.security_level).toBe("low");
    expect(await audits()).toHaveLength(2);
  });

  it("an entrypoint with a foreign rule keeps it: rules after = foreign + ours, never a PUT or a rules list", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.rulesets[SEC] = { id: "rs-x", kind: "zone", phase: "http_config_settings", rules: [{ ...foreign }] };
    const id = await create("owner", "go.owned.test");
    expect((await setCf(id, { securityLevel: "under_attack" })).status).toBe(200);
    expect(fake.state.rulesets[SEC]!.rules).toEqual([foreign, { id: expect.any(String), ...securityRule(id, "go.owned.test", "under_attack") }]);
    expect(fake.calls.filter((c) => c.path.includes("/rulesets") && c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /zones/zo/rulesets/rs-x/rules"]);
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("entrypoint created by someone else between our GET and create: re-read and add, foreign intact", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.rulesets[SEC] = { id: "rs-x", kind: "zone", phase: "http_config_settings", rules: [{ ...foreign }] };
    const id = await create("owner", "go.owned.test");
    fake.failNext(/rulesets\/phases\/http_config_settings\/entrypoint/, 404, { success: false, errors: [{ code: 10003, message: "x" }], result: null });
    expect((await setCf(id, { securityLevel: "medium" })).status).toBe(200);
    expect(fake.state.rulesets[SEC]!.rules.map((x) => x.ref)).toEqual(["theirs", `lw-${id}-sec`]);
  });

  it("rateLimit 50 adds the block rule; null deletes only ours", async () => {
    const fake = installFakeCloudflare({ zones });
    const fr = { id: "f2", ref: "theirs-rl", expression: "true", action: "block", ratelimit: { characteristics: ["ip.src", "cf.colo.id"], period: 10, requests_per_period: 99, mitigation_timeout: 10 } };
    fake.state.rulesets[RL] = { id: "rs-rl", kind: "zone", phase: "http_ratelimit", rules: [{ ...fr }] };
    const id = await create("owner", "go.owned.test");
    expect((await setCf(id, { rateLimit: 50 })).status).toBe(200);
    expect(fake.state.rulesets[RL]!.rules).toEqual([fr, { id: expect.any(String), ...rateLimitRule(id, "go.owned.test", 50) }]);
    expect((await row(id))!.rate_limit).toBe(50);
    const r = await setCf(id, { rateLimit: null });
    expect(r.status).toBe(200);
    expect(fake.state.rulesets[RL]!.rules).toEqual([fr]);
    expect(await row(id)).toEqual({ security_level: null, rate_limit: null });
    expect((await audits()).at(-1)).toEqual({ host: "go.owned.test", rateLimit: null });
  });

  it("null with no rule in Cloudflare is a no-op there and still clears D1", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    fake.calls.length = 0;
    expect((await setCf(id, { securityLevel: null })).status).toBe(200);
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("validation: rate limit out of range, not an integer, unknown level, empty body", async () => {
    installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    for (const b of [{ rateLimit: 5 }, { rateLimit: 1001 }, { rateLimit: 10.5 }, { securityLevel: "max" }, { other: 1 }])
      expect((await setCf(id, b)).status).toBe(400);
    expect(await (await setCf(id, {})).json()).toEqual({ error: "no_changes" });
  });

  it("member: 403, even on their own domain", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    const own = await create("a", "a.owned.test");
    fake.calls.length = 0;
    expect((await setCf(id, { securityLevel: "high" }, "a")).status).toBe(403);
    expect((await setCf(own, { securityLevel: "high" }, "a")).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("controls off: 409 controls_off, no Cloudflare call", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    await controls("0");
    fake.calls.length = 0;
    const r = await setCf(id, { securityLevel: "high" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "controls_off" });
    expect(fake.calls).toEqual([]);
  });

  it("outside domain, or an account domain without a route: 409 not_same_account", async () => {
    const fake = installFakeCloudflare({ zones });
    const out = await create("owner", "go.outside.test");
    const unattached = await create("a", "a.owned.test"); // member create: read-only, no route
    fake.calls.length = 0;
    for (const id of [out, unattached]) {
      const r = await setCf(id, { securityLevel: "high" });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "not_same_account" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("Cloudflare 403 (permission missing): 409 cloudflare_forbidden, D1 unchanged, no audit", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    fake.failNext(/\/rulesets/, 403);
    const r = await setCf(id, { securityLevel: "high" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "cloudflare_forbidden", securityLevel: null, rateLimit: null });
    expect(await row(id)).toEqual({ security_level: null, rate_limit: null });
    expect(await audits()).toEqual([]);
  });

  it("plan limit: a second rate limit in a Free zone is 409 cloudflare_plan_limit, D1 unchanged", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.ratelimitMax = 1;
    const a = await create("owner", "a.owned.test"), b = await create("owner", "b.owned.test");
    expect((await setCf(a, { rateLimit: 20 })).status).toBe(200);
    const r = await setCf(b, { rateLimit: 20 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "cloudflare_plan_limit", securityLevel: null, rateLimit: null });
    expect((await row(b))!.rate_limit).toBeNull();
    // Changing the existing rule is still allowed.
    expect((await setCf(a, { rateLimit: 30 })).status).toBe(200);
    expect(fake.state.rulesets[RL]!.rules).toHaveLength(1);
  });

  it("a validation 400 (code 20125) on adding is 502 cloudflare_error, never a plan limit", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.rulesets[RL] = { id: "rs-rl", kind: "zone", phase: "http_ratelimit", rules: [] };
    const id = await create("owner", "go.owned.test");
    fake.failNext(/rulesets\/rs-rl\/rules$/, 400, { success: false, errors: [{ code: 20125, message: "x" }], result: null });
    const r = await setCf(id, { rateLimit: 20 });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "cloudflare_error", securityLevel: null, rateLimit: null });
    // Same on a failed entrypoint create that is not "already exists".
    fake.state.rulesets = {};
    fake.failNext(/\/zones\/zo\/rulesets$/, 400, { success: false, errors: [{ code: 20125, message: "x" }], result: null });
    expect((await setCf(id, { rateLimit: 20 })).status).toBe(502);
    expect((await row(id))!.rate_limit).toBeNull();
  });

  it("both controls, second fails: the first is stored and audited alone, the error is returned", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.ratelimitMax = 1;
    const a = await create("owner", "a.owned.test"), id = await create("owner", "go.owned.test");
    expect((await setCf(a, { rateLimit: 20 })).status).toBe(200);
    const r = await setCf(id, { securityLevel: "under_attack", rateLimit: 30 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "cloudflare_plan_limit", securityLevel: "under_attack", rateLimit: null });
    expect(await row(id)).toEqual({ security_level: "under_attack", rate_limit: null });
    expect((await audits()).filter((x) => x.host === "go.owned.test")).toEqual([{ host: "go.owned.test", securityLevel: "under_attack" }]);
  });

  it("a reject committing between Cloudflare and D1: our new rules are removed, 404, no audit", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.rulesets[SEC] = { id: "rs-x", kind: "zone", phase: "http_config_settings", rules: [{ ...foreign }] };
    const id = await create("owner", "go.owned.test");
    const restore = beforeBatch(1, async () => {
      await run("DELETE FROM domain_cf WHERE domain_id = ?", id);
      await run("DELETE FROM domains WHERE id = ?", id);
    });
    let r;
    try {
      r = await setCf(id, { securityLevel: "high", rateLimit: 40 });
    } finally {
      restore();
    }
    expect(r.status).toBe(404);
    expect(fake.state.rulesets[SEC]!.rules).toEqual([foreign]);
    expect(fake.state.rulesets[RL]!.rules).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("other Cloudflare failure: 502 cloudflare_error, D1 unchanged", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    fake.failNext(/\/rulesets/, 500);
    expect((await setCf(id, { securityLevel: "high" })).status).toBe(502);
    expect(await row(id)).toEqual({ security_level: null, rate_limit: null });
  });
});

describe("reject removes our rules", () => {
  it("both rules go before the route; foreign rules stay", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.rulesets[SEC] = { id: "rs-x", kind: "zone", phase: "http_config_settings", rules: [{ ...foreign }] };
    const id = await create("owner", "go.owned.test");
    expect((await setCf(id, { securityLevel: "high", rateLimit: 100 })).status).toBe(200);
    await run("UPDATE domains SET status = 'pending' WHERE id = ?", id);
    fake.calls.length = 0;
    expect((await call("owner", "DELETE", `/api/domains/${id}`)).status).toBe(204);
    const w = fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(w[0]).toMatch(/^\/zones\/zo\/rulesets\/rs-x\/rules\//);
    expect(w[1]).toMatch(/^\/zones\/zo\/rulesets\/[^/]+\/rules\//);
    expect(w[2]).toMatch(/workers\/routes/);
    expect(fake.state.rulesets[SEC]!.rules).toEqual([foreign]);
    expect(fake.state.rulesets[RL]!.rules).toEqual([]);
  });

  it("a token without rules permission still rejects a domain that never had rules", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    await run("UPDATE domains SET status = 'pending' WHERE id = ?", id);
    fake.failNext(/rulesets\/phases\/http_config_settings/, 403);
    fake.failNext(/rulesets\/phases\/http_ratelimit/, 403);
    expect((await call("owner", "DELETE", `/api/domains/${id}`)).status).toBe(204);
    expect(fake.state.routes).toEqual([]);
  });

  it("a stored rule that cannot be read (403) fails the reject: 502, D1 kept", async () => {
    const fake = installFakeCloudflare({ zones });
    const id = await create("owner", "go.owned.test");
    expect((await setCf(id, { securityLevel: "high" })).status).toBe(200);
    await run("UPDATE domains SET status = 'pending' WHERE id = ?", id);
    fake.failNext(/rulesets\/phases\/http_config_settings/, 403);
    expect((await call("owner", "DELETE", `/api/domains/${id}`)).status).toBe(502);
    expect(await row(id)).not.toBeNull();
  });
});
