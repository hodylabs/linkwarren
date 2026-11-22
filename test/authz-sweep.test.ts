// Task 11 authz sweep: one table of every dashboard /api route (src/app.ts and its sub-routers) and the contracts of the
// machine API, sign-in, account, MCP and OAuth paths. Each row is checked with no session (401), as a member where the
// route is owner only (403), cross-origin unsafe (403 forbidden_origin) and with a text/plain body (415).
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ORIGIN, dash } from "./helpers/access";
import { signedIn, withCookie } from "./helpers/session";

const e = env as unknown as Record<string, string | undefined>;
const prev = { mode: e.AUTH_MODE, mcp: e.MCP_ENABLED };
beforeAll(() => { e.AUTH_MODE = "app"; });
afterAll(() => { e.AUTH_MODE = prev.mode; e.MCP_ENABLED = prev.mcp; });
afterEach(() => { e.AUTH_MODE = "app"; e.MCP_ENABLED = prev.mcp; });

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** [method, path, owner only] */
const ROUTES: [M, string, boolean][] = [
  ["GET", "/api/me", false],
  ["GET", "/api/domains", false], ["POST", "/api/domains", false], ["PATCH", "/api/domains/x", false], ["DELETE", "/api/domains/x", false],
  ["GET", "/api/domains/x/cloudflare", false], ["PATCH", "/api/domains/x/cloudflare", true], ["POST", "/api/domains/x/approve", true],
  ["POST", "/api/domains/x/disable", false], ["PUT", "/api/domains/x/members", false],
  ["GET", "/api/links", false], ["POST", "/api/links", false], ["GET", "/api/links/by-slug", false], ["GET", "/api/links/check", false],
  ["GET", "/api/links/x", false], ["PATCH", "/api/links/x", false], ["DELETE", "/api/links/x", false], ["POST", "/api/links/bulk", false],
  ["DELETE", "/api/locks/x/y", false],
  ["POST", "/api/import", true],
  ["GET", "/api/users", true], ["PATCH", "/api/users/x", true], ["DELETE", "/api/users/x", true], ["DELETE", "/api/users/x/sessions", true],
  ["POST", "/api/users/invite", true], ["POST", "/api/users/x/resend", true], ["DELETE", "/api/users/x/invite", true],
  ["GET", "/api/audit", true],
  ["GET", "/api/analytics", false], ["GET", "/api/analytics/links", false],
  ["GET", "/api/settings", true], ["PATCH", "/api/settings", true], ["PUT", "/api/settings/logo", true], ["DELETE", "/api/settings/logo", true],
  ["GET", "/api/settings/cloudflare", true], ["PATCH", "/api/settings/cloudflare", true], ["POST", "/api/settings/cloudflare/check", true],
  ["POST", "/api/settings/cloudflare/setup", true], ["POST", "/api/settings/cloudflare/resync", true],
  ["GET", "/api/settings/secrets", true], ["PUT", "/api/settings/secrets/resend", true], ["DELETE", "/api/settings/secrets/resend", true],
  ["POST", "/api/settings/email/test", true],
  ["GET", "/api/setup", true], ["POST", "/api/setup/complete", true],
  ["GET", "/api/instance", false], ["GET", "/api/instance/logo", false],
  ["GET", "/api/account", false], ["POST", "/api/account/passkeys/options", false], ["POST", "/api/account/passkeys", false],
  ["PATCH", "/api/account/passkeys/x", false], ["DELETE", "/api/account/passkeys/x", false], ["DELETE", "/api/account/sessions/x", false],
  ["POST", "/api/account/sign-out", false], ["POST", "/api/account/sign-out-everywhere", false],
  ["GET", "/api/keys", false], ["POST", "/api/keys", false], ["DELETE", "/api/keys/x", false],
  ["GET", "/api/agents/connections", false], ["PATCH", "/api/agents/connections/x", false], ["DELETE", "/api/agents/connections/x", false],
  ["GET", "/api/agents/connections/x/calls", false], ["GET", "/api/agents/mcp", false], ["PUT", "/api/agents/mcp", true],
  ["POST", "/api/export/start", true], ["POST", "/api/export/page", true],
];
const unsafe = ROUTES.filter(([m]) => m !== "GET");
const req = (m: M, path: string, h: Record<string, string> = {}, body?: string) =>
  dash(path, { method: m, headers: h, body: m === "GET" ? undefined : body });

let owner: string, member: string;
beforeEach(async () => {
  await env.DB.batch(["sessions", "api_keys", "auth_limits", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  owner = (await signedIn("owner@example.com", { role: "owner" })).cookie;
  member = (await signedIn("m@example.com")).cookie;
});

describe("dashboard /api routes", () => {
  it.each(ROUTES)("%s %s without a session is 401", async (m, path) => {
    const r = await req(m, path, m === "GET" ? {} : { "content-type": "application/json" }, "{}");
    expect(r.status).toBe(401);
  });

  it.each(ROUTES)("%s %s with only a Bearer key (no session) is 401", async (m, path) => {
    const r = await req(m, path, { authorization: `Bearer lw_${"a".repeat(40)}`, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, "{}");
    expect(r.status).toBe(401);
  });

  it.each(ROUTES.filter(([, , o]) => o))("%s %s as a member is 403 forbidden", async (m, path) => {
    const r = await req(m, path, { cookie: member, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, "{}");
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
  });

  it.each(unsafe)("%s %s cross-origin is 403 forbidden_origin", async (m, path) => {
    const r = await req(m, path, { cookie: owner, origin: "https://evil.example", "content-type": "application/json" }, "{}");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/forbidden/);
  });

  it.each(unsafe)("%s %s with a text/plain body is 415", async (m, path) => {
    const r = await req(m, path, { cookie: owner, "content-type": "text/plain" }, "{}");
    expect([r.status, await r.json()]).toEqual([415, { error: "unsupported_media_type" }]);
  });

  it("an unknown /api path is a JSON 404 even when signed in", async () => {
    const r = await req("GET", "/api/nope", { cookie: owner });
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
  });
});

describe("/api/v1 (Bearer keys only)", () => {
  const v1 = (m: M, path: string, h: Record<string, string> = {}, body?: string) =>
    worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method: m, headers: h, body }), env, createExecutionContext());
  const key = async (write: boolean) => {
    const r = await dash("/api/keys", withCookie(member, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "k", write, del: false, domainIds: [], expiresInDays: 90 }) }));
    return ((await r.json()) as { secret: string }).secret;
  };
  const V1: [M, string][] = [["GET", "/links"], ["POST", "/links"], ["GET", "/links/x"], ["PATCH", "/links/x"], ["DELETE", "/links/x"], ["POST", "/links/bulk"], ["GET", "/domains"], ["GET", "/analytics/links"]];
  it.each(V1)("%s /api/v1%s without a key is 401; a session cookie is not a key", async (m, path) => {
    expect((await v1(m, path)).status).toBe(401);
    expect((await v1(m, path, { cookie: member })).status).toBe(401);
  });
  it.each(V1.filter(([m]) => m === "POST" || m === "PATCH"))("%s /api/v1%s with a read key is 403 read_only", async (m, path) => {
    const r = await v1(m, path, { authorization: `Bearer ${await key(false)}`, "content-type": "application/json" }, "{}");
    expect([r.status, await r.json()]).toEqual([403, { error: "read_only" }]);
  });
  it("DELETE with a write key without delete is 403 delete_not_allowed", async () => {
    const r = await v1("DELETE", "/links/x", { authorization: `Bearer ${await key(true)}` });
    expect([r.status, await r.json()]).toEqual([403, { error: "delete_not_allowed" }]);
  });
  it.each([["GET", "/users"], ["GET", "/keys"], ["GET", "/audit"], ["POST", "/import"], ["GET", "/settings"], ["POST", "/export/start"]] as [M, string][])(
    "%s /api/v1%s is not on the machine API (404)", async (m, path) => {
      const r = await v1(m, path, { authorization: `Bearer ${await key(true)}`, "content-type": "application/json" }, m === "GET" ? undefined : "{}");
      expect(r.status).toBe(404);
    });
  it("a text/plain write with a key is 415", async () => {
    const r = await exports.default.fetch(`${ORIGIN}/api/v1/links`, { method: "POST", headers: { authorization: `Bearer ${await key(true)}`, "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  });
});

describe("/auth/* and /api/account/*", () => {
  const AUTH = ["/auth/email", "/auth/email/verify", "/auth/passkey/options", "/auth/passkey/verify"];
  it.each(AUTH)("POST %s: 404 in access mode, Origin required, 415 for text/plain", async (path) => {
    e.AUTH_MODE = "access";
    expect((await dash(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    e.AUTH_MODE = "app";
    const noOrigin = await exports.default.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([noOrigin.status, await noOrigin.json()]).toEqual([403, { error: "forbidden_origin" }]);
    const plain = await dash(path, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    expect((await dash(path, { method: "GET" })).status).toBe(404);
  });
  it("/api/account/* is 404 in access mode, before any auth check", async () => {
    e.AUTH_MODE = "access";
    expect((await dash("/api/account", { headers: { cookie: owner } })).status).toBe(404);
    expect((await dash("/api/account/sign-out", { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
});

describe("/mcp, /authorize, /token, /register", () => {
  const PATHS: [M, string][] = [["POST", "/mcp"], ["GET", "/authorize"], ["POST", "/authorize"], ["POST", "/token"], ["POST", "/register"]];
  it.each(PATHS)("%s %s is 404 when agent connections are off", async (m, path) => {
    e.MCP_ENABLED = "0";
    const r = await exports.default.fetch(`${ORIGIN}${path}`, { method: m, headers: { "content-type": "application/json", origin: ORIGIN }, body: m === "GET" ? undefined : "{}" });
    expect(r.status).toBe(404);
  });
  it("POST /mcp without a token is 401 when agent connections are on", async () => {
    e.MCP_ENABLED = "1";
    const r = await exports.default.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });
});
