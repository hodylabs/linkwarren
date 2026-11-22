import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_DEFAULT } from "../src/roles";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";
import { beforeBatch } from "./helpers/race";

// S8 R8: domain administration follows the role (domains.manage); adding private domains is domains.own. WHICH domains
// a person can use stays per person: domains.manage administers every domain without making it usable.
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const count = async (sql: string, ...a: unknown[]) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${sql}`, ...a))!.n;
const role = (id: string, perms: readonly string[]) =>
  run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, `Role ${id}`, JSON.stringify(perms));
const setPerms = (id: string, perms: readonly string[]) => run("UPDATE roles SET perms = ? WHERE id = ?", JSON.stringify(perms), id);
const lose = () => setPerms("dmg", []);

async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(`${who}@example.com`), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const answer = async (r: Response) => [r.status, r.status === 204 ? null : await r.json()];
const forbidden = [403, { error: "forbidden" }];
const statusOf = async (id: string) => (await one<{ status: string }>("SELECT status FROM domains WHERE id = ?", id))?.status ?? null;
const zones = [{ id: "zsaas", name: "saas.test" }, { id: "zo", name: "owned.test" }];
const CF = { CF_API_TOKEN: "tok-SECRET", CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw", CF_SAAS_ZONE_ID: "zsaas" };
const e = env as unknown as Record<string, string | undefined>;
const configure = (on = true) => { for (const [k, v] of Object.entries(CF)) e[k] = on ? v : undefined; };
const writes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method !== "GET");

/** Runs `fn` once, just before the first direct execution of a statement whose SQL contains `match` (not inside a batch). */
function beforeQuery(match: string, fn: () => Promise<unknown>) {
  const real = env.DB.prepare.bind(env.DB);
  let done = false;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
      if (p === "first" || p === "all" || p === "run" || p === "raw")
        return async (...a: unknown[]) => { if (!done) { done = true; await fn(); } return (t[p] as (...x: unknown[]) => unknown).apply(t, a); };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => (done || !q.includes(match) ? real(q) : wrap(real(q))));
}

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domain_cf", "domains", "users", "locks", "settings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("UPDATE roles SET perms = ? WHERE id = 'member'", JSON.stringify(MEMBER_DEFAULT));
  await role("dmg", ["domains.manage"]);
  await role("none", ["links.create"]);
  // "old" is the earliest owner but disabled, so the first ACTIVE owner is "owner"; "late" is a later owner.
  for (const [id, r, roleId, status, at] of [["old", "owner", null, "disabled", 0], ["owner", "owner", null, "active", 1], ["late", "owner", null, "active", 2],
    ["a", "member", null, "active", 3], ["d", "member", "dmg", "active", 4], ["n", "member", "none", "active", 5]] as const)
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,?,?)", id, `${id}@example.com`, r, roleId, status, at);
  const dom = (id: string, host: string, type: string, status: string, owner: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,1)", id, host, type, status, owner);
  await dom("dm", "go.test", "main", "active", "owner");
  await dom("ds", "shared.test", "shared", "active", "owner");
  await dom("dp", "mine.test", "private", "pending", "a");
  await run("INSERT INTO domain_cf (domain_id, kind, last_error, updated_at) VALUES ('dm', 'outside', 'cloudflare_error', 1)");
});
afterEach(() => {
  configure(false);
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("POST /api/domains", () => {
  it("domains.manage adds a shared domain: active at once, owned by the first active owner, audited as the holder", async () => {
    const r = await call("d", "POST", "/api/domains", { host: "team.test", type: "shared" });
    expect(r.status).toBe(201);
    const body = await r.json<{ id: string; status: string; ownerId: string; loopLinks?: number }>();
    expect(body).toMatchObject({ status: "active", ownerId: "owner", loopLinks: 0 });
    expect(await one("SELECT status, owner_id FROM domains WHERE id = ?", body.id)).toEqual({ status: "active", owner_id: "owner" });
    expect(await one("SELECT actor_id FROM audit_log WHERE action = 'domain.create' AND target_id = ?", body.id)).toEqual({ actor_id: "d" });
  });

  it("domains.manage adds a main domain owned by the first active owner and a private one owned by themselves, both active", async () => {
    const m = await (await call("d", "POST", "/api/domains", { host: "main2.test", type: "main" })).json<{ id: string }>();
    expect(await one("SELECT status, owner_id FROM domains WHERE id = ?", m.id)).toEqual({ status: "active", owner_id: "owner" });
    const p = await (await call("d", "POST", "/api/domains", { host: "own.test", type: "private" })).json<{ id: string }>();
    expect(await one("SELECT status, owner_id FROM domains WHERE id = ?", p.id)).toEqual({ status: "active", owner_id: "d" });
  });

  it("domains.manage has no pending cap", async () => {
    for (const h of ["p1.test", "p2.test", "p3.test"]) await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'private','pending','d',1)", h, h);
    expect((await call("d", "POST", "/api/domains", { host: "p4.test", type: "private" })).status).toBe(201);
  });

  it("an owner still owns what they add", async () => {
    const r = await (await call("late", "POST", "/api/domains", { host: "late.test", type: "shared" })).json<{ id: string }>();
    expect(await one("SELECT owner_id FROM domains WHERE id = ?", r.id)).toEqual({ owner_id: "late" });
  });

  it("Member (domains.own) adds a private domain pending, owned by themselves, and no main or shared one (unchanged)", async () => {
    const r = await call("a", "POST", "/api/domains", { host: "a2.test", type: "private" });
    expect(r.status).toBe(201);
    const { id } = await r.json<{ id: string }>();
    expect(await one("SELECT status, owner_id FROM domains WHERE id = ?", id)).toEqual({ status: "pending", owner_id: "a" });
    expect(await answer(await call("a", "POST", "/api/domains", { host: "a3.test", type: "shared" }))).toEqual(forbidden);
  });

  it("a role with neither permission: 403 before the body is read, nothing written", async () => {
    expect(await answer(await call("n", "POST", "/api/domains", { host: "n.test", type: "private" }))).toEqual(forbidden);
    expect(await answer(await call("n", "POST", "/api/domains", "{nope"))).toEqual(forbidden);
    expect(await count("domains WHERE host = 'n.test'")).toBe(0);
  });

  it("race: domains.manage removed between the checks and the insert writes nothing and answers 403", async () => {
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "POST", "/api/domains", { host: "race.test", type: "shared" }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await count("domains WHERE host = 'race.test'")).toBe(0);
    expect(await count("audit_log WHERE action = 'domain.create'")).toBe(0);
  });

  it("race: domains.own removed before the insert writes nothing and answers 403", async () => {
    const restore = beforeBatch(1, () => setPerms("member", []));
    let r;
    try { r = await call("a", "POST", "/api/domains", { host: "race2.test", type: "private" }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await count("domains WHERE host = 'race2.test'")).toBe(0);
  });

  it("with Cloudflare, a domains.manage holder's account create attaches at once (like the owner's); a Member's makes no write", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    const r = await call("a", "POST", "/api/domains", { host: "m.owned.test", type: "private" });
    expect(r.status).toBe(201);
    expect(writes(fake.calls)).toEqual([]);
    const s = await call("d", "POST", "/api/domains", { host: "s.owned.test", type: "shared" });
    expect(s.status).toBe(201);
    expect(await s.json()).toMatchObject({ status: "active", ownerId: "owner", cloudflare: { kind: "account", attached: true } });
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["s.owned.test/*"]);
  });

  it("with Cloudflare, a takeover is asked of a domains.manage holder", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "r1", zoneId: "zo", type: "A", name: "www.owned.test", content: "192.0.2.1", proxied: true, comment: null });
    const r = await call("d", "POST", "/api/domains", { host: "www.owned.test", type: "shared" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "dns_record_exists" });
    expect(writes(fake.calls)).toEqual([]);
  });
});

describe("approve, disable, reject", () => {
  it("Member 403 (even on their own pending domain), domains.manage 200 on approve and disable, 204 on reject", async () => {
    expect(await answer(await call("a", "POST", "/api/domains/dp/approve"))).toEqual(forbidden);
    expect(await answer(await call("a", "POST", "/api/domains/dp/disable"))).toEqual(forbidden);
    expect(await answer(await call("a", "DELETE", "/api/domains/dp"))).toEqual(forbidden);
    expect(await answer(await call("n", "POST", "/api/domains/dp/approve", "{nope"))).toEqual(forbidden);
    expect(await statusOf("dp")).toBe("pending");
    const ap = await call("d", "POST", "/api/domains/dp/approve");
    expect(ap.status).toBe(200);
    expect(await statusOf("dp")).toBe("active");
    expect((await call("d", "POST", "/api/domains/dp/disable")).status).toBe(200);
    expect(await statusOf("dp")).toBe("disabled");
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dq','q.test','private','pending','a',1)");
    expect((await call("d", "DELETE", "/api/domains/dq")).status).toBe(204);
    expect(await statusOf("dq")).toBeNull();
    const actors = (await env.DB.prepare("SELECT action, actor_id FROM audit_log ORDER BY id").all()).results;
    expect(actors).toEqual([{ action: "domain.approve", actor_id: "d" }, { action: "domain.disable", actor_id: "d" }, { action: "domain.reject", actor_id: "d" }]);
  });

  it("race: approve with domains.manage lost before the Cloudflare attach makes no Cloudflare write and no change", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    const id = (await (await call("a", "POST", "/api/domains", { host: "links.owned.test", type: "private" })).json<{ id: string }>()).id;
    beforeQuery("SELECT * FROM domain_cf WHERE domain_id = ?", lose);
    expect(await answer(await call("d", "POST", `/api/domains/${id}/approve`))).toEqual(forbidden);
    expect(writes(fake.calls)).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(await count("audit_log WHERE action = 'domain.approve'")).toBe(0);
  });

  it("race: approve of a manual domain with domains.manage lost before the status write changes nothing", async () => {
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "POST", "/api/domains/dp/approve"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await statusOf("dp")).toBe("pending");
    expect(await count("audit_log")).toBe(0);
  });

  it("race: disable with domains.manage lost before the write changes nothing", async () => {
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "POST", "/api/domains/ds/disable"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await statusOf("ds")).toBe("active");
    expect(await count("audit_log")).toBe(0);
  });

  it("race: reject with domains.manage lost before the Cloudflare cleanup makes no Cloudflare write and deletes nothing", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    await run("INSERT INTO domain_cf (domain_id, kind, zone_id, route_id, updated_at) VALUES ('dp', 'account', 'zo', 'rt1', 1)");
    beforeQuery("SELECT * FROM domain_cf WHERE domain_id = ?", lose);
    expect(await answer(await call("d", "DELETE", "/api/domains/dp"))).toEqual(forbidden);
    expect(writes(fake.calls)).toEqual([]);
    expect(await statusOf("dp")).toBe("pending");
    expect(await count("audit_log")).toBe(0);
  });

  it("race: reject with domains.manage lost before the delete batch deletes nothing", async () => {
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "DELETE", "/api/domains/dp"); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await statusOf("dp")).toBe("pending");
    expect(await count("audit_log")).toBe(0);
  });
});

describe("PUT /api/domains/:id/members", () => {
  it("Member 403 before the body is read; domains.manage 200, may add themselves, and then can use the domain", async () => {
    expect(await answer(await call("a", "PUT", "/api/domains/ds/members", { userIds: ["a"] }))).toEqual(forbidden);
    expect(await answer(await call("a", "PUT", "/api/domains/ds/members", "{nope"))).toEqual(forbidden);
    expect(await count("domain_members")).toBe(0);
    const before = await (await call("d", "GET", "/api/domains")).json<{ id: string }[]>();
    expect(before.map((x) => x.id)).not.toContain("ds");
    expect(await answer(await call("d", "PUT", "/api/domains/ds/members", { userIds: ["a", "d"] }))).toEqual([200, { userIds: ["a", "d"] }]);
    expect(await one("SELECT actor_id, detail FROM audit_log WHERE action = 'domain.members'")).toEqual({ actor_id: "d", detail: JSON.stringify({ host: "shared.test", userIds: ["a", "d"] }) });
    const after = await (await call("d", "GET", "/api/domains")).json<{ id: string }[]>();
    expect(after.map((x) => x.id)).toContain("ds");
  });

  it("race: domains.manage removed between the read and the batch writes nothing and answers 403", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds','a')");
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "PUT", "/api/domains/ds/members", { userIds: ["d"] }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect((await env.DB.prepare("SELECT user_id FROM domain_members").all()).results).toEqual([{ user_id: "a" }]);
    expect(await count("audit_log")).toBe(0);
  });
});

describe("canManageDomain call sites: domain settings, the live check and the list's Cloudflare details", () => {
  it("PATCH /api/domains/:id: Member 403 on a domain they do not own, domains.manage 200", async () => {
    expect(await answer(await call("a", "PATCH", "/api/domains/ds", { noindex: false }))).toEqual(forbidden);
    expect((await call("d", "PATCH", "/api/domains/ds", { noindex: false })).status).toBe(200);
    expect(await one("SELECT noindex FROM domains WHERE id = 'ds'")).toEqual({ noindex: 0 });
    expect(await one("SELECT actor_id FROM audit_log WHERE action = 'domain.update'")).toEqual({ actor_id: "d" });
  });

  it("PATCH /api/domains/:id: the domain's own owner keeps it without domains.manage (baseline)", async () => {
    expect((await call("a", "PATCH", "/api/domains/dp", { noindex: false })).status).toBe(200);
  });

  it("race: PATCH /api/domains/:id with domains.manage lost before the batch writes nothing and answers 403", async () => {
    const restore = beforeBatch(1, lose);
    let r;
    try { r = await call("d", "PATCH", "/api/domains/ds", { noindex: false }); } finally { restore(); }
    expect(await answer(r)).toEqual(forbidden);
    expect(await one("SELECT noindex FROM domains WHERE id = 'ds'")).toEqual({ noindex: 1 });
    expect(await count("audit_log")).toBe(0);
  });

  it("GET /api/domains/:id/cloudflare: Member 403, domains.manage 200 even on a domain they cannot use", async () => {
    expect(await answer(await call("a", "GET", "/api/domains/ds/cloudflare"))).toEqual(forbidden);
    expect((await call("d", "GET", "/api/domains/ds/cloudflare")).status).toBe(200);
  });

  it("race: the live check with domains.manage lost before the claim makes no Cloudflare call and no D1 write", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    await run("UPDATE domains SET host = 'x.owned.test' WHERE id = 'ds'");
    await run("INSERT INTO domain_cf (domain_id, kind, zone_id, updated_at) VALUES ('ds', 'account', 'zo', 1)");
    beforeQuery("UPDATE domain_cf SET updated_at", lose);
    const r = await call("d", "GET", "/api/domains/ds/cloudflare");
    expect(r.status).toBe(200);
    expect(fake.calls).toEqual([]);
    expect(await one("SELECT updated_at FROM domain_cf WHERE domain_id = 'ds'")).toEqual({ updated_at: 1 });
  });

  it("the list shows full Cloudflare details to domains.manage, the reduced view to Member", async () => {
    type L = { id: string; cloudflare: { lastError: string | null } }[];
    const m = await (await call("a", "GET", "/api/domains")).json<L>();
    expect(m.find((x) => x.id === "dm")!.cloudflare.lastError).toBeNull();
    const d = await (await call("d", "GET", "/api/domains")).json<L>();
    expect(d.find((x) => x.id === "dm")!.cloudflare.lastError).toBe("cloudflare_error");
  });
});

describe("PATCH /api/domains/:id/cloudflare", () => {
  const controls = () => run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('cf.controls','1',1,'owner')");
  it("Member 403 before the body is read; domains.manage 200", async () => {
    configure();
    installFakeCloudflare({ zones });
    await controls();
    const id = (await (await call("owner", "POST", "/api/domains", { host: "c.owned.test", type: "shared" })).json<{ id: string }>()).id;
    expect(await answer(await call("a", "PATCH", `/api/domains/${id}/cloudflare`, { securityLevel: "high" }))).toEqual(forbidden);
    expect(await answer(await call("a", "PATCH", `/api/domains/${id}/cloudflare`, "{nope"))).toEqual(forbidden);
    expect(await answer(await call("d", "PATCH", `/api/domains/${id}/cloudflare`, { securityLevel: "high" }))).toEqual([200, { securityLevel: "high", rateLimit: null }]);
    expect(await one("SELECT actor_id FROM audit_log WHERE action = 'domain.cloudflare'")).toEqual({ actor_id: "d" });
  });

  it("race: domains.manage lost before the first Cloudflare write: no rule change, nothing stored, 403", async () => {
    configure();
    const fake = installFakeCloudflare({ zones });
    await controls();
    const id = (await (await call("owner", "POST", "/api/domains", { host: "c.owned.test", type: "shared" })).json<{ id: string }>()).id;
    const before = writes(fake.calls).length;
    beforeQuery("SELECT value FROM settings WHERE key = 'cf.controls'", lose);
    expect(await answer(await call("d", "PATCH", `/api/domains/${id}/cloudflare`, { securityLevel: "high" }))).toEqual(forbidden);
    expect(writes(fake.calls).length).toBe(before);
    expect(await one("SELECT security_level FROM domain_cf WHERE domain_id = ?", id)).toEqual({ security_level: null });
    expect(await count("audit_log WHERE action = 'domain.cloudflare'")).toBe(0);
  });
});
