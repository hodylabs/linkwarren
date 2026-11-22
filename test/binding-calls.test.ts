import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

// Workers Free bills about 0.55 ms CPU per D1/KV binding call (see docs/deploy.md): these are the per-request maxima.
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
type Calls = { d1: number; kv: number };
const real = { DB: env.DB, CACHE: env.CACHE, OAUTH_KV: env.OAUTH_KV };
let calls: Calls = { d1: 0, kv: 0 };

/** Counts every first/all/run/raw and every batch (one call each), and every KV operation. */
function countBindings() {
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => stmt(t.bind(...a));
        if (k === "first" || k === "all" || k === "run" || k === "raw") return (...a: unknown[]) => { calls.d1++; return (t[k] as (...x: unknown[]) => unknown)(...a); };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    unwrap.set(p, s);
    return p;
  };
  const e = env as unknown as Record<string, unknown>;
  e.DB = new Proxy(real.DB, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => stmt(t.prepare(sql));
      if (k === "batch") return (s: D1PreparedStatement[]) => { calls.d1++; return t.batch(s.map((x) => unwrap.get(x) ?? x)); };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  for (const name of ["CACHE", "OAUTH_KV"] as const)
    e[name] = new Proxy(real[name], {
      get(t, k) {
        const v = Reflect.get(t, k);
        return typeof v === "function" ? (...a: unknown[]) => { calls.kv++; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v;
      },
    });
}
const restore = () => Object.assign(env, real);

async function measure(fn: () => Promise<Response>): Promise<Calls & { status: number }> {
  calls = { d1: 0, kv: 0 };
  countBindings();
  try {
    const r = await fn();
    await r.arrayBuffer();
    return { ...calls, status: r.status };
  } finally { restore(); }
}

let secret = "";
const v1 = (path: string, init: { method?: string; json?: unknown } = {}) =>
  exports.default.fetch(`https://dash.test/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${secret}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "auth_limits", "links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ua','a@example.com','member','active',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dA','a.test','main','active','ua',1)");
  for (let i = 0; i < 5; i++)
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/','ua','ua',1,1)", `l${i}`, "dA", `s${i}`, `s${i}`);
  const r = await dash("/api/keys", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor("a@example.com"), "content-type": "application/json" },
    body: JSON.stringify({ name: "ci", write: true, del: true, domainIds: [], expiresInDays: 90 }),
  });
  secret = ((await r.json()) as { secret: string }).secret;
  // Sets last_used_at, so the once-a-minute update stays out of the measured calls.
  await run("UPDATE api_keys SET last_used_at = ?", Math.floor(Date.now() / 1000));
});
afterEach(restore);

describe("binding calls per /api/v1 request", () => {
  it("GET /links?q= is at most 3 D1 calls", async () => {
    const m = await measure(() => v1("/links?q=s"));
    expect(m).toMatchObject({ status: 200, kv: 0 });
    expect(m.d1).toBeLessThanOrEqual(3);
  });

  it("POST /links is at most 4 D1 calls and 1 KV", async () => {
    const m = await measure(() => v1("/links", { method: "POST", json: { domainId: "dA", slug: "new", url: "https://y.com/" } }));
    expect(m.status).toBe(201);
    expect([m.d1, m.kv]).toEqual([4, 1]);
  });

  it("PATCH and DELETE /links/:id are at most 4 D1 calls and 1 KV", async () => {
    const p = await measure(() => v1("/links/l0", { method: "PATCH", json: { url: "https://z.com/" } }));
    expect(p.status).toBe(200);
    expect([p.d1, p.kv]).toEqual([4, 1]);
    const d = await measure(() => v1("/links/l1", { method: "DELETE" }));
    expect(d.status).toBe(204);
    expect([d.d1, d.kv]).toEqual([4, 1]);
  });

  it("a bulk schedule of 5 links is at most 7 D1 calls plus one KV delete per link", async () => {
    const m = await measure(() => v1("/links/bulk", { method: "POST", json: { action: "schedule", ids: ["l0", "l1", "l2", "l3", "l4"], endNow: true } }));
    expect(m.status).toBe(200);
    expect(m.d1).toBeLessThanOrEqual(7);
    expect(m.kv).toBe(5);
  });

  it("a refused (rate limited) request is 3 D1 calls and writes nothing", async () => {
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:day', ?, 3000)", Math.floor(Date.now() / 1000));
    const m = await measure(() => v1("/links?q=s"));
    expect([m.status, m.d1, m.kv]).toEqual([429, 3, 0]);
  });
});
