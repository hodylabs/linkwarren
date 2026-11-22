import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authMode } from "../src/auth";
import type { Env } from "../src/env";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const e = env as { AUTH_MODE?: string; ACCESS_JWKS_JSON?: string };
const orig = { mode: e.AUTH_MODE, jwks: e.ACCESS_JWKS_JSON };
afterAll(() => { e.ACCESS_JWKS_JSON = orig.jwks; });
beforeAll(setupAccess);
afterEach(() => { e.AUTH_MODE = orig.mode; });
beforeEach(async () => {
  await env.DB.batch(["links", "domains", "sessions", "users", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const count = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM users").first<{ n: number }>())!.n;
const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("authMode", () => {
  it.each([
    [undefined, "app"], ["", "app"], [" app ", "app"], ["access", "access"], ["Access", null], ["bogus", null], [1, null], [true, null],
  ] as const)("%j -> %j", (v, want) => {
    expect(authMode({ AUTH_MODE: v } as unknown as Env)).toBe(want);
  });
});

describe("app mode", () => {
  beforeEach(() => { e.AUTH_MODE = "app"; });

  it("ignores a valid owner Access JWT: 401 signIn app and no user is created", async () => {
    const res = await dash("/api/me", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") } });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"unauthenticated","signIn":"app"}');
    expect(await count()).toBe(0);
  });

  it("serves /healthz publicly", async () => {
    expect((await dash("/healthz")).status).toBe(200);
  });
});

describe("access mode", () => {
  beforeEach(() => { e.AUTH_MODE = "access"; });

  it("answers 404 not_found on /auth/* and /api/account/*", async () => {
    const r1 = await dash("/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"a@example.com"}' });
    expect(r1.status).toBe(404);
    expect(await r1.json()).toEqual({ error: "not_found" });
    const r2 = await dash("/api/account");
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ error: "not_found" });
    expect((await dash("/api/account/sessions")).status).toBe(404);
  });

  it("ignores a valid session cookie without a JWT", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,0)").bind(id, "owner@example.com", "owner", "active").run();
    const secret = "A".repeat(43);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), await sha256Hex(secret), id, "email", now, now, now + 3600).run();
    const res = await dash("/api/me", { headers: { cookie: `__Host-lw_session=${secret}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("still serves /healthz", async () => {
    expect((await dash("/healthz")).status).toBe(200);
  });
});

describe("non-string mode", () => {
  it.each([1, true])("%j answers 500 misconfigured, not internal", async (v) => {
    (e as { AUTH_MODE?: unknown }).AUTH_MODE = v;
    const me = await dash("/api/me");
    expect(me.status).toBe(500);
    expect(await me.json()).toEqual({ error: "misconfigured" });
    const a = await dash("/auth/email", { method: "POST" });
    expect(await a.json()).toEqual({ error: "misconfigured" });
  });
});

describe("unknown mode", () => {
  beforeEach(() => { e.AUTH_MODE = "bogus"; });

  it("fails closed on dashboard API and /auth paths while short links still redirect", async () => {
    const me = await dash("/api/me", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") } });
    expect(me.status).toBe(500);
    expect(await me.json()).toEqual({ error: "misconfigured" });
    expect((await dash("/auth/email", { method: "POST" })).status).toBe(500);
    expect(await count()).toBe(0);

    await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES ('mu1','o@example.com','owner','active',1)").run();
    await env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('md1','short.test','main','active','mu1',1)").run();
    await env.DB.prepare(
      "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES ('ml1','md1','go','go','https://example.com/x',302,'mu1','mu1',1,1)",
    ).run();
    const r = await exports.default.fetch("https://short.test/go", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/x");
  });

  it("still serves /healthz", async () => {
    expect((await dash("/healthz")).status).toBe(200);
  });
});

describe("non-string mode", () => {
  it.each([1, true])("%j answers 500 misconfigured, not internal", async (v) => {
    (e as { AUTH_MODE?: unknown }).AUTH_MODE = v;
    const me = await dash("/api/me");
    expect(me.status).toBe(500);
    expect(await me.json()).toEqual({ error: "misconfigured" });
    const a = await dash("/auth/email", { method: "POST" });
    expect(await a.json()).toEqual({ error: "misconfigured" });
  });
});
