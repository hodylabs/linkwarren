import { env, exports } from "cloudflare:workers";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUD, ISS, other, setupAccess, token, type Opts } from "./helpers/access";

const e = env as { ACCESS_JWKS_JSON?: string; ACCESS_AUD?: string; ACCESS_TEAM_DOMAIN?: string };
const orig = { jwks: e.ACCESS_JWKS_JSON, aud: e.ACCESS_AUD, team: e.ACCESS_TEAM_DOMAIN };
afterAll(() => {
  e.ACCESS_JWKS_JSON = orig.jwks; e.ACCESS_AUD = orig.aud; e.ACCESS_TEAM_DOMAIN = orig.team;
});

beforeAll(setupAccess);

beforeEach(async () => {
  e.ACCESS_AUD = orig.aud; e.ACCESS_TEAM_DOMAIN = orig.team;
  await env.DB.batch([env.DB.prepare("DELETE FROM users"), env.DB.prepare("DELETE FROM audit_log")]);
});

const me = (headers: Record<string, string> = {}) => exports.default.fetch("https://dash.test/api/me", { headers });
const asUser = async (o?: Opts) => me({ "Cf-Access-Jwt-Assertion": await token(o) });
const count = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM users").first<{ n: number }>())!.n;
const seed = (email: string, status: string, role = "member") =>
  env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,0)").bind(crypto.randomUUID(), email, role, status).run();
const audits = async (action: string) =>
  (await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = ?").bind(action).first<{ n: number }>())!.n;

describe("requireUser", () => {
  it("returns email and role for an active user (email matched case-insensitively)", async () => {
    await seed("A@Example.com", "active", "member");
    const res = await asUser({ email: "a@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "A@Example.com", role: "member" });
  });

  it("activates an invited user on first sign-in and audits it", async () => {
    await seed("a@example.com", "invited");
    expect((await asUser()).status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM users").first<{ status: string }>();
    expect(row!.status).toBe("active");
    expect(await audits("user.activate")).toBe(1);
    await asUser();
    expect(await audits("user.activate")).toBe(1);
  });

  it("403 disabled", async () => {
    await seed("a@example.com", "disabled");
    const res = await asUser();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled" });
    expect(await count()).toBe(1);
  });

  const rejected: [string, () => Promise<Response>, number, string][] = [
    ["no token", () => me(), 401, "unauthenticated"],
    ["garbage token", () => me({ "Cf-Access-Jwt-Assertion": "x.y.z" }), 401, "unauthenticated"],
    ["expired token", async () => asUser({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401, "unauthenticated"],
    ["wrong aud", () => asUser({ aud: "nope" }), 401, "unauthenticated"],
    ["wrong issuer", () => asUser({ iss: "https://evil.example.com" }), 401, "unauthenticated"],
    ["foreign signing key", () => asUser({ key: other }), 401, "unauthenticated"],
    ["no email claim", () => asUser({ email: null }), 401, "unauthenticated"],
    ["empty email claim", () => asUser({ email: " " }), 401, "unauthenticated"],
    ["valid token, email not invited", () => asUser({ email: "stranger@example.com" }), 403, "not_invited"],
  ];
  for (const [name, call, status, error] of rejected) {
    it(`${name} -> ${status} and creates no user`, async () => {
      await seed("someone@example.com", "active");
      const res = await call();
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(await count()).toBe(1);
    });
  }

  it("fails closed when ACCESS_AUD is unset", async () => {
    await seed("a@example.com", "active");
    const t = await token({ aud: "other-app" });
    delete e.ACCESS_AUD;
    expect((await me({ "Cf-Access-Jwt-Assertion": t })).status).toBe(401);
    expect(await count()).toBe(1);
  });

  it("fails closed when ACCESS_TEAM_DOMAIN is unset", async () => {
    await seed("a@example.com", "active");
    const t = await token();
    delete e.ACCESS_TEAM_DOMAIN;
    expect((await me({ "Cf-Access-Jwt-Assertion": t })).status).toBe(401);
    expect(await count()).toBe(1);
  });

  it("rejects a signed token without exp", async () => {
    await seed("a@example.com", "active");
    expect((await asUser({ noExp: true })).status).toBe(401);
    expect(await count()).toBe(1);
  });

  it("rejects an HS256 token (wrong alg)", async () => {
    const t = await new SignJWT({ email: "a@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(ISS).setAudience(AUD).setExpirationTime("5m")
      .sign(new TextEncoder().encode("secret-secret-secret-secret-secret"));
    await seed("a@example.com", "active");
    expect((await me({ "Cf-Access-Jwt-Assertion": t })).status).toBe(401);
  });

  it("ignores a token supplied only via cookie or query", async () => {
    await seed("a@example.com", "active");
    const t = await token();
    expect((await me({ Cookie: `CF_Authorization=${t}` })).status).toBe(401);
    const res = await exports.default.fetch(`https://dash.test/api/me?Cf-Access-Jwt-Assertion=${t}`);
    expect(res.status).toBe(401);
  });

  it("bootstraps exactly one owner on first run, then 403s anyone else", async () => {
    const res = await asUser({ email: "Owner@Example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "Owner@Example.com", role: "owner" });
    expect(await count()).toBe(1);
    expect(await audits("user.bootstrap")).toBe(1);
    const second = await asUser({ email: "b@example.com" });
    expect(second.status).toBe(403);
    expect(await count()).toBe(1);
  });

  it("does not bootstrap a non-owner email on an empty table", async () => {
    expect((await asUser({ email: "b@example.com" })).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it("does not bootstrap the owner email once users exist", async () => {
    await seed("x@example.com", "active");
    expect((await asUser({ email: "owner@example.com" })).status).toBe(403);
    expect(await count()).toBe(1);
  });

  it("concurrent first sign-ins yield exactly one owner", async () => {
    const [a, b] = await Promise.all([asUser({ email: "owner@example.com" }), asUser({ email: "owner@example.com" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await count()).toBe(1);
    expect(await audits("user.bootstrap")).toBe(1);
    const [c, d] = await Promise.all([asUser({ email: "owner@example.com" }), asUser({ email: "other@example.com" })]);
    expect([c.status, d.status]).toEqual([200, 403]);
    expect(await count()).toBe(1);
  });
});
