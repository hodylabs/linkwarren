import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { OAUTH_PATHS } from "../src/oauth";

const DASH = "https://dash.test";
const SHORT = "https://short.test";
const PR_SUFFIX = "/.well-known/oauth-protected-resource/mcp";
const PR_BARE = "/.well-known/oauth-protected-resource";
const fetchW = (url: string, init?: RequestInit) => exports.default.fetch(url, init);
const register = (ip: string) =>
  fetchW(`${DASH}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Test client",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
const setMcp = (v: string | undefined) => ((env as { MCP_ENABLED?: string }).MCP_ENABLED = v);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM auth_limits").run();
});
afterEach(() => {
  setMcp("1");
  vi.restoreAllMocks();
});

describe("oauth front door on the dashboard host", () => {
  it("answers unauthenticated /mcp with 401 and the protected-resource pointer", async () => {
    const res = await fetchW(`${DASH}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const h = res.headers.get("www-authenticate") ?? "";
    expect(h.startsWith("Bearer ")).toBe(true);
    expect(h).toContain(`resource_metadata="${DASH}${PR_SUFFIX}"`);
  });

  it("serves protected-resource metadata at the /mcp suffix form", async () => {
    const res = await fetchW(`${DASH}${PR_SUFFIX}`);
    expect(res.status).toBe(200);
    const m = await res.json<{ resource: string; authorization_servers: string[] }>();
    expect(m.resource).toBe(`${DASH}/mcp`);
    expect(m.authorization_servers[0]).toBe(DASH);
  });

  it("answers the bare protected-resource path with JSON, never the dashboard HTML", async () => {
    const res = await fetchW(`${DASH}${PR_BARE}`);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-fake-assets")).toBeNull();
    const body = await res.json<{ resource?: string; error?: string }>();
    if (res.status === 200) expect(body.resource).toBe(`${DASH}/mcp`);
    else expect([res.status, body.error]).toEqual([404, "not_found"]);
  });

  it("serves authorization-server metadata with S256 only, the register endpoint and offline_access", async () => {
    const res = await fetchW(`${DASH}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const m = await res.json<{ code_challenge_methods_supported: string[]; registration_endpoint: string; scopes_supported: string[] }>();
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.registration_endpoint).toBe(`${DASH}/register`);
    expect(m.scopes_supported).toContain("offline_access");
  });

  it("registers a client by DCR", async () => {
    const res = await register("198.51.100.7");
    expect(res.status).toBe(201);
    expect((await res.json<{ client_id: string }>()).client_id).toBeTruthy();
  });

  it("limits registration to 5 per hour per IP range", async () => {
    for (let i = 1; i <= 5; i++) expect((await register(`203.0.113.${i}`)).status).toBe(201);
    const res = await register("203.0.113.99");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("limits registration to 50 per UTC day per instance", async () => {
    await env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('reg:day', ?, 50)").bind(Math.floor(Date.now() / 1000)).run();
    expect((await register("192.0.2.10")).status).toBe(429);
  });

  it("starts a fresh daily count at 00:00 UTC", async () => {
    const now = Math.floor(Date.now() / 1000);
    const yesterday = now - (now % 86400) - 60; // one minute before today's 00:00 UTC
    await env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('reg:day', ?, 50)").bind(yesterday).run();
    expect((await register("192.0.2.20")).status).toBe(201);
  });

  it("answers every OAuth path with JSON 404 while MCP_ENABLED is not 1", async () => {
    expect(OAUTH_PATHS).toEqual(expect.arrayContaining([PR_BARE, PR_SUFFIX, "/mcp", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server"]));
    setMcp("0");
    for (const p of OAUTH_PATHS)
      for (const method of ["GET", "POST"]) {
        const res = await fetchW(`${DASH}${p}`, { method });
        expect([p, method, res.status]).toEqual([p, method, 404]);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
  });

  it("never lets a short-link host reach the OAuth provider (Review Focus 3)", async () => {
    const unknown = await fetchW(`${SHORT}/no-such-slug-xyz`);
    for (const p of OAUTH_PATHS)
      for (const method of ["GET", "POST"]) {
        const res = await fetchW(`${SHORT}${p}`, { method });
        const ref = method === "GET" ? unknown : await fetchW(`${SHORT}/no-such-slug-xyz`, { method });
        expect([p, method, res.status]).toEqual([p, method, ref.status]);
        expect(res.headers.get("www-authenticate")).toBeNull();
        expect(res.headers.get("content-type") ?? "").not.toMatch(/json/);
      }
  });

  it("keeps /healthz and the dashboard page as before", async () => {
    const h = await fetchW(`${DASH}/healthz`);
    expect([h.status, await h.json()]).toEqual([200, { ok: true }]);
    const page = await fetchW(`${DASH}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-fake-assets")).toBe("1");
  });

  it("keeps the scheduled handler: the hourly prune still runs and spares today's daily counters", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(typeof worker.scheduled).toBe("function");
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('ip:old', ?, 1)").bind(now - 7200),
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('reg:day', ?, 3)").bind(now - 7200),
    ]);
    await worker.scheduled!({ cron: "15 * * * *", scheduledTime: now * 1000, noRetry() {} } as ScheduledController, env, {} as ExecutionContext);
    const keys = (await env.DB.prepare("SELECT key FROM auth_limits").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual(["reg:day"]);
  });
});
