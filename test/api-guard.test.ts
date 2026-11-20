import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { dash, ORIGIN, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
const e = env as unknown as { DASHBOARD_HOST: string; DB: unknown };

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)");
});

const authed = async () => ({ "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") });
const post = async (headers: Record<string, string>, body: string) =>
  dash("/api/domains", { method: "POST", headers: { ...(await authed()), ...headers }, body });
const good = JSON.stringify({ host: "new.example.com", type: "main" });

describe("csrf and json-only bodies", () => {
  it("text/plain POST with a foreign Origin is 403 and writes nothing", async () => {
    const r = await post({ origin: "https://evil.example", "content-type": "text/plain" }, good);
    expect(r.status).toBe(403);
    expect(await count("domains")).toBe(0);
  });
  it("JSON POST with a foreign Origin is 403", async () => {
    const r = await post({ origin: "https://evil.example", "content-type": "application/json" }, good);
    expect(r.status).toBe(403);
    expect(await count("domains")).toBe(0);
  });
  it("same-origin JSON POST works, also with a charset parameter", async () => {
    expect((await post({ "content-type": "application/json; charset=utf-8" }, good)).status).toBe(201);
  });
  it("a non-browser client without Origin may send JSON", async () => {
    const r = await exports.default.fetch(`${ORIGIN}/api/domains`, {
      method: "POST", headers: { ...(await authed()), "content-type": "application/json" }, body: good,
    });
    expect(r.status).toBe(201);
  });
  it("same-origin text/plain body is 415", async () => {
    const r = await post({ "content-type": "text/plain" }, good);
    expect([r.status, await r.json()]).toEqual([415, { error: "unsupported_media_type" }]);
    expect(await count("domains")).toBe(0);
  });
  it("same-origin body with no content type is 415", async () => {
    const r = await post({}, good);
    expect(r.status).toBe(415);
  });
  it("a foreign Origin on a bodyless unsafe request is 403", async () => {
    const r = await dash("/api/domains/x/approve", { method: "POST", headers: { ...(await authed()), origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  describe("empty bodies (browsers send content-length: 0 on bodyless DELETE/POST)", () => {
    const seed = async () => {
      await run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES ('dp','p.example.com','main','pending','uo',0,1)");
      await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l1','dp','p','p','https://x.com/','uo','uo',1,1)");
    };
    it("bodyless DELETE with content-length 0 passes the guard", async () => {
      await seed();
      const r = await dash("/api/links/l1", { method: "DELETE", headers: { ...(await authed()), "content-length": "0" } });
      expect(r.status).toBe(204);
    });
    it("bodyless POST approve with content-length 0 passes the guard", async () => {
      await seed();
      const r = await dash("/api/domains/dp/approve", { method: "POST", headers: { ...(await authed()), "content-length": "0" } });
      expect(r.status).toBe(200);
    });
    it("a foreign Origin bodyless DELETE is still 403", async () => {
      await seed();
      const r = await dash("/api/links/l1", { method: "DELETE", headers: { ...(await authed()), "content-length": "0", origin: "https://evil.example" } });
      expect(r.status).toBe(403);
    });
    it("a text/plain body with bytes is still 415", async () => {
      expect((await post({ "content-type": "text/plain", "content-length": String(good.length) }, good)).status).toBe(415);
    });
  });
});

describe("every /api route requires a token", () => {
  const routes = app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/"));
  it("finds the routes", () => expect(routes.length).toBeGreaterThanOrEqual(14));
  for (const { method, path } of routes)
    it(`${method} ${path} -> 401`, async () => {
      const r = await dash(path.replace(/:\w+/g, "x"), { method });
      expect(r.status).toBe(401);
    });
});

describe("failure modes", () => {
  it.each(["", "   "])("blank DASHBOARD_HOST %j answers 500 misconfigured on every host", async (v) => {
    const orig = e.DASHBOARD_HOST;
    e.DASHBOARD_HOST = v;
    try {
      for (const url of [`${ORIGIN}/healthz`, "https://short.test/x"]) {
        const r = await exports.default.fetch(url);
        expect([r.status, await r.json()]).toEqual([500, { error: "misconfigured" }]);
      }
    } finally { e.DASHBOARD_HOST = orig; }
  });
  it("unhandled errors are a bare JSON 500", async () => {
    const orig = e.DB;
    e.DB = { prepare() { throw new Error("boom-secret-detail"); } };
    try {
      const r = await dash("/api/me", { headers: await authed() });
      const text = await r.text();
      expect([r.status, JSON.parse(text)]).toEqual([500, { error: "internal" }]);
      expect(text).not.toContain("boom");
    } finally { e.DB = orig; }
  });
  it("unknown dashboard paths are JSON 404, short hosts keep their page", async () => {
    const r = await dash("/nope");
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
    const s = await exports.default.fetch("https://short.test/nope");
    expect(s.status).toBe(404);
    expect(s.headers.get("content-type")).toMatch(/html/);
  });
});
