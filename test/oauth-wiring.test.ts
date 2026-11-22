import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { OAUTH_PATHS } from "../src/oauth";

const DASH = "https://dash.test";
const SHORT = "https://short.test";
const PR_SUFFIX = "/.well-known/oauth-protected-resource/mcp";
const PR_BARE = "/.well-known/oauth-protected-resource";
const fetchW = (url: string, init?: RequestInit) => exports.default.fetch(url, init);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const register = (ip: string, redirect_uris: unknown = [CLAUDE_CB]) =>
  fetchW(`${DASH}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      redirect_uris,
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

  it("advertises RFC 9207 with the dashboard origin as issuer", async () => {
    const m = await (await fetchW(`${DASH}/.well-known/oauth-authorization-server`)).json<Record<string, unknown>>();
    expect(m.issuer).toBe(DASH);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
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
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:ud:u1', ?, 3)").bind(now - 7200),
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:u:u1', ?, 3)").bind(now - 7200),
      env.DB.prepare("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:day', ?, 3)").bind(now - 7200),
    ]);
    await worker.scheduled!({ cron: "15 * * * *", scheduledTime: now * 1000, noRetry() {} } as ScheduledController, env, {} as ExecutionContext);
    const keys = (await env.DB.prepare("SELECT key FROM auth_limits").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys.sort()).toEqual(["api:day", "api:ud:u1", "reg:day"]);
  });

  it("accepts only the Claude and ChatGPT callbacks and loopback /callback redirect URIs at registration", async () => {
    let n = 0;
    const ip = () => `10.${++n}.0.1`; // a fresh IP range each, so the per-range limit never interferes
    for (const ok of [[CLAUDE_CB], ["https://claude.com/api/mcp/auth_callback"], ["https://chatgpt.com/connector_platform_oauth_redirect"], ["http://localhost:33418/callback"], ["http://localhost:1455/callback/AbC123_-xyz0"], ["http://127.0.0.1:1455/callback/AbC123_-xyz0"], [`http://127.0.0.1:2/callback/${"a".repeat(64)}`], ["http://127.0.0.1:1/callback", "http://localhost:65535/callback"]])
      expect([ok, (await register(ip(), ok)).status]).toEqual([ok, 201]);
    const kvBefore = (await env.OAUTH_KV.list()).keys.length;
    for (const bad of [
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude-ai.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/api/mcp/auth_callback#f",
      "https://claude.com/api/mcp/auth_callback/",
      "https://www.claude.com/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect/",
      "https://chatgpt.com/connector/oauth/abc123",
      "https://chat.openai.com/connector_platform_oauth_redirect",
      "http://chatgpt.com/connector_platform_oauth_redirect",
      "https://user@claude.ai/api/mcp/auth_callback",
      "https://claude.ai:443/api/mcp/auth_callback",
      "http://claude.ai/api/mcp/auth_callback",
      "http://localhost/callback",
      "http://localhost:0/callback",
      "http://localhost:65536/callback",
      "http://localhost:8080/callback/",
      "http://localhost:8080/callback?x=1",
      "http://localhost:8080/other",
      "http://localhost:8080/callback/a/b",
      "http://localhost:8080/callback/..",
      "http://localhost:8080/callback/.",
      "http://localhost:8080/callback/%2F",
      "http://127.0.0.1:8080/callback/a%2Fb",
      `http://localhost:8080/callback/${"a".repeat(65)}`,
      "http://localhost:8080/callback/abc?x=1",
      "http://localhost:8080/callbackx",
      "http://localhost.evil.example:8080/callback",
      "http://user@localhost:8080/callback",
      "https://localhost:8080/callback",
      "http://[::1]:8080/callback",
      "http://127.0.0.2:8080/callback",
    ]) {
      const res = await register(ip(), [CLAUDE_CB, bad]);
      expect([bad, res.status]).toEqual([bad, 400]);
      // The library refuses a fragment, userinfo or an out-of-range port itself, before the callback, with its own RFC 7591 code.
      const code = /#|@|:65536\//.test(bad) ? "invalid_client_metadata" : "invalid_redirect_uri";
      expect([bad, (await res.json<{ error: string }>()).error]).toEqual([bad, code]);
    }
    for (const bad of ["x", [], [42], null]) expect((await register(ip(), bad)).status).toBe(400);
    expect((await env.OAUTH_KV.list()).keys.length).toBe(kvBefore); // refused registrations write nothing
  });

  it("refuses an authorization request whose redirect_uri the client did not register", async () => {
    const { client_id } = await (await register("10.200.0.1", ["http://localhost:4000/callback"])).json<{ client_id: string }>();
    const helpers = env.OAUTH_PROVIDER!; // injected on env by the provider on the requests above
    const auth = (redirect: string) => {
      const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" });
      return helpers.parseAuthRequest(new Request(`${DASH}/authorize?${q}`));
    };
    await expect(auth("http://localhost:4000/callback")).resolves.toMatchObject({ clientId: client_id });
    await expect(auth("http://localhost:5000/callback")).resolves.toMatchObject({ clientId: client_id }); // loopback: any port (RFC 8252)
    await expect(auth(CLAUDE_CB)).rejects.toThrow();
    await expect(auth("http://localhost:4000/other")).rejects.toThrow();
  });

  it("answers JSON 503 when the provider throws (for example the KV daily write cap)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.OAUTH_KV, "put").mockRejectedValue(new Error("KV put() limit exceeded for the day."));
    const res = await register("10.201.0.1");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("fails closed with 503 when the D1 limiter is unavailable on /register", async () => {
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("D1 down"); });
    const res = await register("10.202.0.1");
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("keeps subpaths and preflights behind MCP_ENABLED", async () => {
    setMcp("0");
    for (const p of ["/mcp/x", "/mcp/", "/.well-known/oauth-protected-resource/x"])
      expect([p, (await fetchW(`${DASH}${p}`)).status]).toEqual([p, 404]);
    for (const p of OAUTH_PATHS) {
      const res = await fetchW(`${DASH}${p}`, { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "POST" } });
      expect([p, res.status, res.headers.get("access-control-allow-origin")]).toEqual([p, 404, null]);
    }
  });

  it("never reaches the provider with a blank DASHBOARD_HOST", async () => {
    const e = env as { DASHBOARD_HOST: string };
    const saved = e.DASHBOARD_HOST;
    e.DASHBOARD_HOST = " ";
    try {
      for (const p of ["/register", "/.well-known/oauth-authorization-server", "/mcp"]) {
        const res = await fetchW(`${DASH}${p}`, { method: p === "/register" ? "POST" : "GET" });
        expect([p, res.status, await res.json()]).toEqual([p, 500, { error: "misconfigured" }]);
      }
    } finally {
      e.DASHBOARD_HOST = saved;
    }
  });

  it("treats the dashboard host case-insensitively, with a port or a trailing dot", async () => {
    for (const host of ["DASH.TEST", "dash.test:8443", "dash.test."]) {
      const res = await fetchW(`${DASH}/mcp`, { method: "POST", headers: { host, "content-type": "application/json" }, body: "{}" });
      expect([host, res.status]).toEqual([host, 401]);
    }
  });
});
