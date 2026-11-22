import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_KEY, MCP_TTL_MS, mcpState, resetMcpCache } from "../src/mcp/switch";
import { OAUTH_PATHS } from "../src/oauth";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { connectAgent, mcpCall } from "./helpers/oauth";
// @ts-expect-error Vite raw import, no type declaration in this project
import exampleConfig from "../wrangler.instance.example.jsonc?raw";

const DASH = "https://dash.test";
const SHORT = "https://short.test";
const O = "owner@example.com", A = "a@example.com";
const fetchW = (url: string, init?: RequestInit) => exports.default.fetch(url, init);
const setVar = (v: string | undefined) => ((env as { MCP_ENABLED?: string }).MCP_ENABLED = v);
const setRow = (v: string | null) =>
  v === null
    ? env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(MCP_KEY).run()
    : env.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,1,'uo') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(MCP_KEY, v).run();
const as = async (email: string, path: string, init: RequestInit = {}) =>
  dash(path, { ...init, headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), ...(init.body ? { "content-type": "application/json" } : {}) } });
const put = (email: string, body: unknown) => as(email, "/api/agents/mcp", { method: "PUT", body: JSON.stringify(body) });
const audits = () => env.DB.prepare("SELECT * FROM audit_log WHERE action = 'settings.update' ORDER BY id").all<Record<string, unknown>>().then((r) => r.results);

// Every OAuth path, the subpaths and the encoded forms the wrapper and router must close.
const CLOSED = [...OAUTH_PATHS, "/mcp/x", "/%6dcp", "/%61uthorize"];
async function expectClosed() {
  for (const p of CLOSED)
    for (const method of ["GET", "POST"]) {
      const res = await fetchW(`${DASH}${p}`, { method });
      expect([p, method, res.status, await res.json().catch(() => "not json")]).toEqual([p, method, 404, { error: "not_found" }]);
    }
  const pre = await fetchW(`${DASH}/mcp`, { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "POST" } });
  expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([404, null]);
}
async function expectOpen() {
  const res = await fetchW(`${DASH}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(401);
  expect((await fetchW(`${DASH}/.well-known/oauth-authorization-server`)).status).toBe(200);
}

beforeAll(setupAccess);
beforeEach(async () => {
  for (const k of (await env.OAUTH_KV.list()).keys) await env.OAUTH_KV.delete(k.name);
  await env.DB.batch(["settings", "tool_calls", "auth_limits", "audit_log", "agent_connections", "api_keys", "links", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", O, "owner"], ["ua", A, "member"]])
    await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)").bind(id, email, role).run();
  resetMcpCache();
  setVar("1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVar("1");
  resetMcpCache();
});

describe("mcpState (R10)", () => {
  it("no row: off with the var unset, on with \"1\"", async () => {
    setVar(undefined);
    expect(await mcpState(env)).toEqual({ on: false, locked: false });
    setVar("1");
    expect(await mcpState(env)).toEqual({ on: true, locked: false });
  });

  it("the row decides when the var is \"1\" or unset", async () => {
    await setRow("0");
    expect(await mcpState(env)).toEqual({ on: false, locked: false });
    await setRow("1");
    resetMcpCache();
    setVar(undefined);
    expect(await mcpState(env)).toEqual({ on: true, locked: false });
  });

  it("\"0\" locks off whatever the row, without a read", async () => {
    await setRow("1");
    setVar("0");
    const spy = vi.spyOn(env.DB, "prepare");
    expect(await mcpState(env)).toEqual({ on: false, locked: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a D1 error throws (callers fail closed)", async () => {
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("D1 down"); });
    await expect(mcpState(env)).rejects.toThrow();
  });
});

describe("the switch closes and reopens every OAuth path", () => {
  it("owner PUT off closes everything at once in the same isolate; PUT on reopens", async () => {
    await expectOpen();
    const off = await put(O, { on: false });
    expect([off.status, await off.json()]).toEqual([200, { on: false, locked: false }]);
    await expectClosed();
    const on = await put(O, { on: true });
    expect([on.status, await on.json()]).toEqual([200, { on: true, locked: false }]);
    await expectOpen();
  });

  it("a stale cache from another isolate flips within the TTL and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
    expect((await mcpState(env)).on).toBe(true); // seeds the cache with "no row"
    await setRow("0"); // another isolate saved "off"
    vi.setSystemTime(Date.now() + MCP_TTL_MS - 1);
    expect((await mcpState(env)).on).toBe(true);
    vi.setSystemTime(Date.now() + 2);
    expect((await mcpState(env)).on).toBe(false);
  });

  it("off revokes nothing: connections and grants stay, the same token works again after turning on", async () => {
    const a = await connectAgent(A);
    expect((await mcpCall(a.accessToken, "tools/list")).status).toBe(200);
    const kv = (await env.OAUTH_KV.list()).keys.length;
    expect((await put(O, { on: false })).status).toBe(200);
    expect((await mcpCall(a.accessToken, "tools/list")).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE revoked_at IS NULL").first("n")).toBe(1);
    expect((await env.OAUTH_KV.list()).keys.length).toBe(kv);
    expect((await put(O, { on: true })).status).toBe(200);
    expect((await mcpCall(a.accessToken, "tools/list")).status).toBe(200);
  });

  it("fails closed with 503 on /mcp and /authorize when the D1 read fails", async () => {
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("D1 down"); });
    for (const p of ["/mcp", "/authorize", "/%61uthorize"]) {
      const res = await fetchW(`${DASH}${p}`, { method: "POST" });
      expect([p, res.status, await res.json()]).toEqual([p, 503, { error: "unavailable" }]);
    }
  });

  it("short hosts never reach the gate or the provider, switch on or off (Review Focus 3)", async () => {
    for (const state of [true, false]) {
      expect((await put(O, { on: state })).status).toBe(200);
      const spy = vi.spyOn(env.DB, "prepare");
      for (const p of OAUTH_PATHS) {
        const ref = await fetchW(`${SHORT}/no-such-slug-xyz`);
        const res = await fetchW(`${SHORT}${p}`);
        expect([state, p, res.status]).toEqual([state, p, ref.status]);
        expect(res.headers.get("www-authenticate")).toBeNull();
        expect(res.headers.get("content-type") ?? "").not.toMatch(/json/);
      }
      expect(spy.mock.calls.some(([sql]) => String(sql).includes("settings"))).toBe(false);
      spy.mockRestore();
    }
  });

  it("API keys on /api/v1 keep working while MCP is off", async () => {
    expect((await put(O, { on: false })).status).toBe(200);
    const k = await as(A, "/api/keys", { method: "POST", body: JSON.stringify({ name: "ci", write: false, del: false, domainIds: [], expiresInDays: 90 }) });
    expect(k.status).toBe(201);
    const { secret } = await k.json<{ secret: string }>();
    const r = await fetchW(`${DASH}/api/v1/links`, { headers: { authorization: `Bearer ${secret}` } });
    expect(r.status).toBe(200);
  });
});

describe("GET/PUT /api/agents/mcp", () => {
  it("every signed-in person reads the state; a member cannot change it", async () => {
    const g = await as(A, "/api/agents/mcp");
    expect([g.status, await g.json()]).toEqual([200, { on: true, locked: false }]);
    const p = await put(A, { on: false });
    expect([p.status, await p.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM settings").first("n")).toBe(0);
  });

  it("locked: GET says so, PUT answers 409 mcp_locked and writes nothing", async () => {
    setVar("0");
    expect(await (await as(O, "/api/agents/mcp")).json()).toEqual({ on: false, locked: true });
    const p = await put(O, { on: true });
    expect([p.status, await p.json()]).toEqual([409, { error: "mcp_locked" }]);
    expect(await audits()).toEqual([]);
  });

  it("rejects a body that is not exactly { on: boolean }", async () => {
    for (const b of [{}, { on: "1" }, { on: true, x: 1 }]) expect((await put(O, b)).status).toBe(400);
  });

  it("writes the row and one settings.update audit row; the same value again writes nothing", async () => {
    expect((await put(O, { on: false })).status).toBe(200);
    expect(await env.DB.prepare("SELECT value, updated_by FROM settings WHERE key = ?").bind(MCP_KEY).first()).toEqual({ value: "0", updated_by: "uo" });
    let rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "uo", via: null, target_type: "settings", target_id: MCP_KEY });
    expect(JSON.parse(String(rows[0]!.detail))).toEqual({ key: MCP_KEY, value: "0" });
    expect((await put(O, { on: false })).status).toBe(200);
    expect(await audits()).toHaveLength(1);
    expect((await put(O, { on: true })).status).toBe(200);
    rows = await audits();
    expect(JSON.parse(String(rows[1]!.detail))).toEqual({ key: MCP_KEY, value: "1" });
  });

  it("needs the dashboard origin for a change (CSRF)", async () => {
    const r = await dash("/api/agents/mcp", {
      method: "PUT",
      headers: { "Cf-Access-Jwt-Assertion": await tokenFor(O), "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ on: false }),
    });
    expect(r.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM settings").first("n")).toBe(0);
  });

  it("is not reachable with an API key under /api/v1", async () => {
    const k = await as(O, "/api/keys", { method: "POST", body: JSON.stringify({ name: "ci", write: true, del: true, domainIds: [], expiresInDays: 90 }) });
    const { secret } = await k.json<{ secret: string }>();
    for (const p of ["/api/v1/agents/mcp", "/api/agents/mcp"]) {
      const r = await fetchW(`${DASH}${p}`, { method: "PUT", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
      expect([p, r.status]).not.toEqual([p, 200]);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM settings").first("n")).toBe(0);
  });
});

describe("example config (D6)", () => {
  it("ships no MCP_ENABLED value of \"0\"", () => {
    const text = exampleConfig as string;
    expect(text).toContain("DASHBOARD_HOST");
    expect(text).not.toMatch(/^\s*"MCP_ENABLED"\s*:\s*"0"/m);
  });
});
