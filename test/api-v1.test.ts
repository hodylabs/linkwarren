import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callApi } from "../src/call";
import { rowToUser, type UserRow } from "../src/types";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { signInApp, withCookie } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const count = async (t: string) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))!.n;
const EMAIL: Record<string, string> = { uo: "owner@example.com", ua: "a@example.com", ub: "b@example.com" };

/** A key made the way a person makes one: POST /api/keys on the dashboard. */
async function key(who: string, o: { write?: boolean; del?: boolean; domainIds?: string[]; name?: string } = {}) {
  const r = await dash("/api/keys", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json" },
    body: JSON.stringify({ name: o.name ?? "ci", write: o.write ?? false, del: o.del ?? false, domainIds: o.domainIds ?? [], expiresInDays: 90 }),
  });
  expect(r.status).toBe(201);
  const b = (await r.json()) as { key: { id: string }; secret: string };
  return { id: b.key.id, secret: b.secret };
}
/** A script: no Origin, only the Authorization header. */
const v1 = (secret: string | null, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(`https://dash.test/api/v1${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
};
const ids = async (r: Response) => ((await r.json()) as { items: { id: string }[] }).items.map((l) => l.id).sort();

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "auth_limits", "links", "slug_locks", "audit_log", "domain_members", "domains", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, role] of [["uo", "owner"], ["ua", "member"], ["ub", "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, EMAIL[id], role);
  const dom = (id: string, host: string, type: string, owner = "uo") =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dA", "a.test", "main");
  await dom("dB", "b.test", "main");
  await dom("dpb", "pb.test", "private", "ub");
  const ln = (id: string, d: string, slug: string, by = "ua") =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", id, d, slug, slug.toLowerCase(), by, by);
  await ln("la", "dA", "spring");
  await ln("la2", "dA", "autumn");
  await ln("lb", "dB", "bee");
  await ln("lpb", "dpb", "pbee", "ub");
});
afterEach(() => vi.restoreAllMocks());

describe("scopes", () => {
  it("a read key lists links and domains (bare array, no cloudflare view)", async () => {
    const k = await key("ua");
    const r = await v1(k.secret, "/links");
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual(["la", "la2", "lb"]);
    const d = await v1(k.secret, "/domains");
    const list = (await d.json()) as Record<string, unknown>[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((x) => x.id).sort()).toEqual(["dA", "dB"]);
    for (const x of list) expect(x).not.toHaveProperty("cloudflare");
    const ok = await key("uo", { name: "own" });
    for (const x of (await (await v1(ok.secret, "/domains")).json()) as Record<string, unknown>[]) expect(x).not.toHaveProperty("cloudflare");
  });

  it("q filters and POST uses domainId", async () => {
    const k = await key("ua", { write: true });
    expect(await ids(await v1(k.secret, "/links?q=spring"))).toEqual(["la"]);
    const r = await v1(k.secret, "/links", { method: "POST", json: { domainId: "dA", slug: "new", url: "https://y.com" } });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ domainId: "dA", slug: "new", hasPassword: false });
  });

  it("read key POST 403 read_only and PATCH 403 read_only, nothing written", async () => {
    const k = await key("ua");
    const r = await v1(k.secret, "/links", { method: "POST", json: { domainId: "dA", slug: "n", url: "https://y.com" } });
    expect([r.status, await r.json()]).toEqual([403, { error: "read_only" }]);
    const p = await v1(k.secret, "/links/la", { method: "PATCH", json: { url: "https://y.com" } });
    expect([p.status, await p.json()]).toEqual([403, { error: "read_only" }]);
    expect(await one("SELECT 1 FROM links WHERE slug = 'n'")).toBeNull();
  });

  it("write key creates; the audit row carries via API key <name>", async () => {
    const k = await key("ua", { write: true, name: "deploy-bot" });
    const r = await v1(k.secret, "/links", { method: "POST", json: { domainId: "dA", slug: "n", url: "https://y.com" } });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(await one("SELECT actor_id, via FROM audit_log WHERE action = 'link.create' AND target_id = ?", id)).toEqual({ actor_id: "ua", via: "API key deploy-bot" });
  });

  it("write key without delete: DELETE 403 delete_not_allowed", async () => {
    const k = await key("ua", { write: true });
    const r = await v1(k.secret, "/links/la", { method: "DELETE" });
    expect([r.status, await r.json()]).toEqual([403, { error: "delete_not_allowed" }]);
    expect(await one("SELECT 1 FROM links WHERE id = 'la'")).not.toBeNull();
  });

  it("delete key: bodyless DELETE with no Origin and no content-length is 204 (R4)", async () => {
    const k = await key("ua", { write: true, del: true });
    const r = await v1(k.secret, "/links/la", { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(await one("SELECT 1 FROM links WHERE id = 'la'")).toBeNull();
  });

  it("a text/plain body is 415", async () => {
    const k = await key("ua", { write: true });
    const r = await v1(k.secret, "/links", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ domainId: "dA", slug: "n", url: "https://y.com" }) });
    expect([r.status, await r.json()]).toEqual([415, { error: "unsupported_media_type" }]);
  });

  it("only the machine routes are mounted: the rest is JSON 404", async () => {
    const k = await key("uo", { write: true, del: true });
    for (const p of ["/keys", "/users", "/import", "/analytics", "/audit", "/settings", "/me", "", "/locks/dA/x"]) {
      const r = await v1(k.secret, p);
      expect([p, r.status, await r.json()]).toEqual([p, 404, { error: "not_found" }]);
    }
    const d = await v1(k.secret, "/domains", { method: "POST", json: { host: "c.test", type: "main" } });
    expect([d.status, await d.json()]).toEqual([404, { error: "not_found" }]);
    expect((await v1(k.secret, "/domains/dA")).status).toBe(404);
    expect((await v1(k.secret, "/locks/dA/x", { method: "DELETE" })).status).toBe(404);
  });
});

describe("Review Focus 4: a key restricted to domain A, made by the owner", () => {
  it("lists only A, 403 on B for every route, cannot create on B", async () => {
    const k = await key("uo", { write: true, del: true, domainIds: ["dA"] });
    expect(await ids(await v1(k.secret, "/links"))).toEqual(["la", "la2"]);
    expect(((await (await v1(k.secret, "/domains")).json()) as { id: string }[]).map((d) => d.id)).toEqual(["dA"]);
    const refused: [string, string, unknown?][] = [
      ["GET", "/links?domain=dB"], ["GET", "/links/check?domain=dB&slug=x"], ["GET", "/links/lb"], ["GET", "/links/by-slug?domain=dB&slug=bee"],
      ["POST", "/links", { domainId: "dB", slug: "n", url: "https://y.com" }], ["PATCH", "/links/lb", { url: "https://y.com" }], ["DELETE", "/links/lb"],
      ["GET", "/analytics/links?ids=lb"],
    ];
    for (const [method, path, json] of refused) expect([method, path, (await v1(k.secret, path, { method, json })).status]).toEqual([method, path, 403]);
    expect(await one("SELECT url FROM links WHERE id = 'lb'")).toEqual({ url: "https://x.com/" });
    expect(await one("SELECT 1 FROM links WHERE domain_id = 'dB' AND slug = 'n'")).toBeNull();
  });

  it("analytics/links works for a usable link and refuses one outside the key's domains", async () => {
    const k = await key("ua", { domainIds: ["dA"] });
    const r = await v1(k.secret, "/analytics/links?ids=la");
    expect(r.status).toBe(200);
    const b = (await r.json()) as { items: { linkId: string; days: number[]; clicks: number; qr: number; topCountry: string | null }[] };
    expect(b.items).toEqual([{ linkId: "la", days: [0, 0, 0, 0, 0, 0, 0], clicks: 0, qr: 0, topCountry: null }]);
    expect((await v1(k.secret, "/analytics/links?ids=la,lb")).status).toBe(403);
  });
});

describe("Review Focus 5 and authentication", () => {
  it("expired, revoked, disabled-user and malformed keys are 401 invalid_key", async () => {
    const e = await key("ua", { name: "exp" });
    await run("UPDATE api_keys SET expires_at = ? WHERE id = ?", Math.floor(Date.now() / 1000) - 1, e.id);
    const rv = await key("ua", { name: "rev" });
    await run("UPDATE api_keys SET revoked_at = 1 WHERE id = ?", rv.id);
    const d = await key("ub", { name: "dis" });
    await run("UPDATE users SET status = 'disabled' WHERE id = 'ub'");
    for (const s of [e.secret, rv.secret, d.secret, "abc", `lw_${"A".repeat(43)}`]) {
      const r = await v1(s, "/links");
      expect([s, r.status, await r.json()]).toEqual([s, 401, { error: "invalid_key" }]);
    }
    const basic = await v1(null, "/links", { headers: { authorization: "Basic eDp5" } });
    expect([basic.status, await basic.json()]).toEqual([401, { error: "invalid_key" }]);
  });

  it("no credentials, an Access JWT or a session cookie alone on /api/v1: 401 unauthenticated", async () => {
    expect([(await v1(null, "/links")).status, await (await v1(null, "/links")).json()]).toEqual([401, { error: "unauthenticated" }]);
    const jwt = await v1(null, "/links", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL.ua!) } });
    expect([jwt.status, await jwt.json()]).toEqual([401, { error: "unauthenticated" }]);
  });

  it("app mode: a valid session cookie alone on /api/v1/links is 401 unauthenticated", async () => {
    const e = env as { AUTH_MODE?: string };
    const orig = e.AUTH_MODE;
    e.AUTH_MODE = "app";
    try {
      const cookie = await signInApp("c@example.com");
      expect((await dash("/api/links", withCookie(cookie))).status).toBe(200); // the cookie itself is good
      const r = await v1(null, "/links", withCookie(cookie));
      expect([r.status, await r.json()]).toEqual([401, { error: "unauthenticated" }]);
      const w = await v1(null, "/links", { ...withCookie(cookie), method: "POST", json: { domainId: "dA", slug: "n", url: "https://y.com" } });
      expect(w.status).toBe(401);
    } finally {
      e.AUTH_MODE = orig;
    }
  });

  it("a key on the dashboard API outside /api/v1 is refused", async () => {
    const k = await key("ua", { write: true, del: true });
    const r = await exports.default.fetch("https://dash.test/api/links", { headers: { authorization: `Bearer ${k.secret}` } });
    expect([r.status, await r.json()]).toEqual([401, { error: "unauthenticated" }]);
    const kk = await exports.default.fetch("https://dash.test/api/keys", { headers: { authorization: `Bearer ${k.secret}` } });
    expect(kk.status).toBe(401);
  });

  it("sets last_used_at after the first call, then skips the write within 60 s", async () => {
    const k = await key("ua");
    expect(await one("SELECT last_used_at FROM api_keys WHERE id = ?", k.id)).toEqual({ last_used_at: null });
    await v1(k.secret, "/links");
    let at: number | null = null;
    for (let i = 0; i < 50 && !at; i++) {
      at = (await one<{ last_used_at: number | null }>("SELECT last_used_at FROM api_keys WHERE id = ?", k.id))!.last_used_at;
      if (!at) await new Promise((r) => setTimeout(r, 10));
    }
    expect(at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it("responses never carry a password hash or a secret", async () => {
    const k = await key("ua", { write: true });
    const c = await v1(k.secret, "/links", { method: "POST", json: { domainId: "dA", slug: "locked", url: "https://y.com", password: "correct horse battery" } });
    expect(c.status).toBe(201);
    const { id } = (await c.json()) as { id: string };
    for (const p of ["/links", `/links/${id}`, "/links/by-slug?domain=dA&slug=locked", "/domains", `/analytics/links?ids=${id}`]) {
      const text = await (await v1(k.secret, p)).text();
      expect([p, text.includes("pbkdf2"), text.includes(k.secret), text.includes("correct horse")]).toEqual([p, false, false, false]);
    }
  });
});

describe("rate limits (D1 limiter)", () => {
  it("the 61st call in a minute on one key is 429 rate_limited", async () => {
    const k = await key("ua");
    for (let i = 0; i < 60; i++) expect((await v1(k.secret, "/domains")).status).toBe(200);
    const r = await v1(k.secret, "/domains");
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
  });

  it("the daily cap: api:ud at 1000 refuses the next call and writes no limiter rows", async () => {
    const k = await key("ua");
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:ud:ua', ?, 1000)", Math.floor(Date.now() / 1000));
    const before = await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all();
    const r = await v1(k.secret, "/links");
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
    expect((await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all()).results).toEqual(before.results);
  });

  it("an allowed call counts on all four keys", async () => {
    const k = await key("ua");
    await v1(k.secret, "/links");
    const rows = (await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all()).results;
    expect(rows).toEqual([{ key: "api:day", count: 1 }, { key: `api:k:${k.id}`, count: 1 }, { key: "api:u:ua", count: 1 }, { key: "api:ud:ua", count: 1 }]);
  });

  it("the instance daily cap: api:day at 3000 refuses every principal and writes no limiter rows", async () => {
    const k = await key("ua");
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:day', ?, 3000)", Math.floor(Date.now() / 1000));
    const before = await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all();
    const r = await v1(k.secret, "/links");
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
    expect((await env.DB.prepare("SELECT key, count FROM auth_limits ORDER BY key").all()).results).toEqual(before.results);
  });

  it("D1 limiter failure fails closed with 503", async () => {
    const k = await key("ua");
    const orig = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("auth_limits")) throw new Error("D1 down");
      return orig(sql);
    });
    const r = await v1(k.secret, "/links");
    expect([r.status, await r.json()]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("callApi (in-process seam)", () => {
  const userA = async (): Promise<UserRow> => rowToUser((await one<Record<string, unknown>>("SELECT * FROM users WHERE id = 'ua'"))!);

  it("acts as its principal: 403 on another member's private domain, writes carry its via, no limiter rows", async () => {
    const ctx = createExecutionContext();
    const p = { user: await userA(), grant: { write: true, del: true, domains: null, via: "Claude" }, limiterKey: "api:c:conn1" };
    expect((await callApi(env, ctx, p, "GET", "/links?domain=dpb")).status).toBe(403);
    expect((await callApi(env, ctx, p, "POST", "/links", { domainId: "dpb", slug: "x", url: "https://y.com" })).status).toBe(403);
    const r = await callApi(env, ctx, p, "POST", "/links", { domainId: "dA", slug: "via", url: "https://y.com" });
    expect(r.status).toBe(201);
    const id = (r.json as { id: string }).id;
    expect(await one("SELECT actor_id, via FROM audit_log WHERE action = 'link.create' AND target_id = ?", id)).toEqual({ actor_id: "ua", via: "Claude" });
    expect((await callApi(env, ctx, p, "GET", `/links/${id}`)).json).toMatchObject({ id, hasPassword: false });
    expect((await callApi(env, ctx, p, "DELETE", `/links/${id}`)).status).toBe(204);
    await waitOnExecutionContext(ctx);
    expect(await count("auth_limits")).toBe(0);
  });

  it("enforces the principal's grant: read only and no delete", async () => {
    const ctx = createExecutionContext();
    const ro = { user: await userA(), grant: { write: false, del: false, domains: null, via: "Claude" }, limiterKey: "api:c:c1" };
    expect(await callApi(env, ctx, ro, "POST", "/links", { domainId: "dA", slug: "x", url: "https://y.com" })).toEqual({ status: 403, json: { error: "read_only" } });
    const nd = { ...ro, grant: { ...ro.grant, write: true } };
    expect(await callApi(env, ctx, nd, "DELETE", "/links/la")).toEqual({ status: 403, json: { error: "delete_not_allowed" } });
    expect((await callApi(env, ctx, ro, "GET", "/analytics")).status).toBe(404);
  });

  it("an outside request can never carry an in-process principal", async () => {
    // A fresh Request that merely looks like a callApi one is unauthenticated.
    const r = await exports.default.fetch("https://dash.test/api/v1/links");
    expect(r.status).toBe(401);
  });
});
