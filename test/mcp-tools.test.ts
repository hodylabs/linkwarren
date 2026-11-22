import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { INSTRUCTIONS } from "../src/mcp/server";
import { VERSION } from "../src/version";
import { setupAccess } from "./helpers/access";
import { connectAgent, mcpCall } from "./helpers/oauth";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const all = async <T>(sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all<T>()).results;
const A = "a@example.com";

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
/** tools/call; returns the result and the raw JSON text the agent saw. */
let made = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<Result & { raw: string }> {
  made++;
  const r = await mcpCall(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  expect(r.body.result, JSON.stringify(r.body)).toBeTruthy();
  return { ...r.body.result, raw: JSON.stringify(r.body) };
}
const errOf = (r: Result) => (r.isError ? (r.structuredContent ?? JSON.parse(r.content[0]!.text)) : null);

type Row = Record<string, unknown>;
/** tool_calls is written with waitUntil: wait until `n` rows exist. */
async function calls(n: number): Promise<Row[]> {
  return vi.waitFor(async () => {
    const r = await all<Row>("SELECT * FROM tool_calls ORDER BY id");
    if (r.length < n) throw new Error(`tool_calls ${r.length} < ${n}`);
    return r;
  }, { timeout: 3000, interval: 20 });
}
const lastCall = async () => (await calls(1)).at(-1)!;

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["tool_calls", "auth_limits", "links", "slug_locks", "audit_log", "agent_connections", "domain_members", "domains", "sessions", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", "owner@example.com", "owner"], ["ua", A, "member"], ["ub", "b@example.com", "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, email, role);
  const dom = (id: string, host: string, type: string, owner: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dgo", "go.test", "main", "uo");
  await dom("da", "a.test", "private", "ua");
  await dom("db", "b.test", "private", "ub");
  const ln = (id: string, d: string, slug: string, by: string) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)",
      id, d, slug, slug.toLowerCase(), by, by);
  await ln("lgo", "dgo", "spring", "ua");
  await ln("la", "da", "apple", "ua");
  await ln("lb", "db", "bee", "ub");
});
// Every tool call wrote exactly one tool_calls row with only the schema columns (never arguments or results).
afterEach(async () => {
  const rows = made ? await calls(made) : await all<Row>("SELECT * FROM tool_calls");
  expect(rows).toHaveLength(made);
  for (const r of rows) expect(Object.keys(r).sort()).toEqual(["at", "conn_id", "id", "status", "tool", "user_id", "via"]);
  made = 0;
  vi.restoreAllMocks();
});

describe("server", () => {
  it("VERSION equals package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("initialize returns the exact instructions and tools/list the nine tools", async () => {
    const t = await connectAgent(A);
    const init = await mcpCall(t.accessToken, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.instructions).toBe(INSTRUCTIONS);
    expect(init.body.result.serverInfo.name).toBe("linkwarren");
    const list = await mcpCall(t.accessToken, "tools/list");
    const tools = list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((x) => x.name).sort()).toEqual(
      ["check_slug", "create_link", "delete_link", "get_link", "link_stats", "list_domains", "search_links", "server_info", "update_link"]);
    const writes = ["create_link", "update_link", "delete_link"];
    for (const x of tools) expect(x.annotations?.readOnlyHint ?? false).toBe(!writes.includes(x.name));
  });

  it("server_info on a read-only connection: access read, no email or name", async () => {
    const t = await connectAgent(A);
    const r = await tool(t.accessToken, "server_info");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      version: VERSION, access: "read", role: "member", mcpUrl: "https://dash.test/mcp",
      limits: { perUserPerMinute: 120, perConnectionPerMinute: 60, perUserPerDay: 1000 },
    });
    expect(r.raw).not.toContain("@");
    const row = await lastCall();
    expect(Object.keys(row).sort()).toEqual(["at", "conn_id", "id", "status", "tool", "user_id", "via"]);
    expect(row).toMatchObject({ tool: "server_info", status: "ok", user_id: "ua", conn_id: t.connId, via: "Claude" });
  });
});

describe("reads as member A", () => {
  it("search_links never returns b.test links and sends query as q", async () => {
    const t = await connectAgent(A);
    const r = await tool(t.accessToken, "search_links");
    expect(r.structuredContent.items.map((l: { id: string }) => l.id).sort()).toEqual(["la", "lgo"]);
    expect(r.raw).not.toContain("b.test");
    const q = await tool(t.accessToken, "search_links", { query: "spring" });
    expect(q.structuredContent.items.map((l: { id: string }) => l.id)).toEqual(["lgo"]);
    const byHost = await tool(t.accessToken, "search_links", { domain: "a.test" });
    expect(byHost.structuredContent.items.map((l: { id: string }) => l.id)).toEqual(["la"]);
    const other = await tool(t.accessToken, "search_links", { domain: "b.test" });
    expect(errOf(other)).toEqual({ error: "unknown_domain", status: 404 });
    const rows = await calls(4);
    expect(rows.map((x) => [x.tool, x.status])).toEqual([["search_links", "ok"], ["search_links", "ok"], ["search_links", "ok"], ["search_links", "error"]]);
    for (const x of rows) expect(JSON.stringify(x)).not.toMatch(/spring|a\.test|b\.test/);
  });

  it("get_link by shortUrl, by id, and refuses both or neither", async () => {
    const t = await connectAgent(A);
    const r = await tool(t.accessToken, "get_link", { shortUrl: "https://go.test/Spring" });
    expect(r.structuredContent).toMatchObject({ id: "lgo", slug: "spring" });
    expect((await tool(t.accessToken, "get_link", { shortUrl: "go.test/spring" })).structuredContent.id).toBe("lgo");
    expect((await tool(t.accessToken, "get_link", { id: "la" })).structuredContent.slug).toBe("apple");
    expect(errOf(await tool(t.accessToken, "get_link", { id: "lb" }))).toEqual({ error: "forbidden", status: 403 });
    expect(errOf(await tool(t.accessToken, "get_link", {}))?.error).toBe("bad_input");
    expect(errOf(await tool(t.accessToken, "get_link", { id: "la", shortUrl: "go.test/spring" }))?.error).toBe("bad_input");
  });

  it("list_domains maps to host, type, status, linkCount; check_slug answers", async () => {
    const t = await connectAgent(A);
    const d = await tool(t.accessToken, "list_domains");
    expect(d.structuredContent.items).toEqual([
      { host: "a.test", type: "private", status: "active", linkCount: 1 },
      { host: "go.test", type: "main", status: "active", linkCount: 1 },
    ]);
    expect((await tool(t.accessToken, "check_slug", { domain: "go.test", slug: "spring" })).structuredContent).toEqual({ status: "taken" });
    expect((await tool(t.accessToken, "check_slug", { domain: "dgo", slug: "fresh" })).structuredContent).toEqual({ status: "available" });
  });

  it("link_stats returns 7-day counts for A's link and refuses b.test", async () => {
    const t = await connectAgent(A);
    const r = await tool(t.accessToken, "link_stats", { id: "la" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.items[0].linkId).toBe("la");
    expect(r.structuredContent.items[0].days).toHaveLength(7);
    expect(errOf(await tool(t.accessToken, "link_stats", { id: "lb" }))).toEqual({ error: "forbidden", status: 403 });
  });
});

describe("writes", () => {
  it("read-only create_link gets read_only and creates nothing", async () => {
    const t = await connectAgent(A);
    const r = await tool(t.accessToken, "create_link", { domain: "go.test", slug: "new", url: "https://y.com" });
    expect(errOf(r)).toEqual({ error: "read_only", status: 403 });
    expect(await one("SELECT 1 FROM links WHERE slug = 'new'")).toBeNull();
    expect(await lastCall()).toMatchObject({ tool: "create_link", status: "error" });
  });

  it("write connection creates as A with via = client name", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "create_link", { domain: "go.test", slug: "new", url: "https://y.com" });
    expect(r.isError).toBeFalsy();
    const link = await one<Row>("SELECT * FROM links WHERE slug = 'new'");
    expect(link).toMatchObject({ domain_id: "dgo", created_by: "ua" });
    expect(await one<Row>("SELECT actor_id, via FROM audit_log WHERE action = 'link.create'")).toEqual({ actor_id: "ua", via: "Claude" });
    const u = await tool(t.accessToken, "update_link", { id: link!.id, url: "https://z.com" });
    expect(u.structuredContent.url).toBe("https://z.com/");
  });

  it("a javascript: destination reaches S1 validation", async () => {
    const t = await connectAgent(A, { write: true });
    expect(errOf(await tool(t.accessToken, "create_link", { domain: "go.test", slug: "js", url: "javascript:alert(1)" }))?.error).toBe("scheme");
  });

  it("a password is write-only: hasPassword true, never pbkdf2 or the password in any output", async () => {
    const t = await connectAgent(A, { write: true });
    const secret = "hunter2-correct-horse";
    const c = await tool(t.accessToken, "create_link", { domain: "go.test", slug: "pw", url: "https://y.com", password: secret });
    expect(c.structuredContent.hasPassword).toBe(true);
    const g = await tool(t.accessToken, "get_link", { id: c.structuredContent.id });
    const s = await tool(t.accessToken, "search_links", { query: "pw" });
    for (const x of [c, g, s]) {
      expect(x.raw).not.toContain("pbkdf2");
      expect(x.raw).not.toContain(secret);
    }
    expect(g.structuredContent.hasPassword).toBe(true);
  });

  it("delete_link: refuses without confirm, delete_not_allowed without delete, deletes and locks with both", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "delete_link", { id: "lgo" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      refused: true, summary: "Deleting go.test/spring sends visitors to the domain's not-found page and locks the slug.",
    });
    expect(await lastCall()).toMatchObject({ tool: "delete_link", status: "refused" });
    expect(await one("SELECT 1 FROM links WHERE id = 'lgo'")).not.toBeNull();
    expect(errOf(await tool(t.accessToken, "delete_link", { id: "lgo", confirm: true }))).toEqual({ error: "delete_not_allowed", status: 403 });

    const d = await connectAgent(A, { write: true, del: true });
    const ok = await tool(d.accessToken, "delete_link", { id: "lgo", confirm: true });
    expect(ok.structuredContent).toEqual({ deleted: true, id: "lgo" });
    expect(await one("SELECT 1 FROM links WHERE id = 'lgo'")).toBeNull();
    expect(await one("SELECT 1 FROM slug_locks WHERE domain_id = 'dgo' AND slug_key = 'spring'")).not.toBeNull();
  });
});

describe("Review Focus 2: live access on every call", () => {
  it("revoked connection: the next call is refused and logged", async () => {
    const t = await connectAgent(A);
    expect((await tool(t.accessToken, "server_info")).isError).toBeFalsy();
    await run("UPDATE agent_connections SET revoked_at = 1 WHERE id = ?", t.connId);
    const r = await tool(t.accessToken, "server_info");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("This connection was disconnected or its person no longer has access.");
    expect((await calls(2))[1]).toMatchObject({ status: "refused", via: "Claude", conn_id: t.connId });
  });

  it("write switched off: the next write gets read_only", async () => {
    const t = await connectAgent(A, { write: true });
    await run("UPDATE agent_connections SET can_write = 0, can_delete = 0 WHERE id = ?", t.connId);
    expect(errOf(await tool(t.accessToken, "create_link", { domain: "go.test", slug: "late", url: "https://y.com" }))).toEqual({ error: "read_only", status: 403 });
  });

  it("disabled person: the next call is refused", async () => {
    const t = await connectAgent(A);
    await run("UPDATE users SET status = 'disabled' WHERE id = 'ua'");
    const r = await tool(t.accessToken, "search_links");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("This connection was disconnected or its person no longer has access.");
  });
});

describe("rate limits", () => {
  it("the 61st call in a minute on one connection is rate limited", async () => {
    const t = await connectAgent(A);
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, 59)", `api:c:${t.connId}`, Math.floor(Date.now() / 1000));
    expect((await tool(t.accessToken, "server_info")).isError).toBeFalsy();
    const r = await tool(t.accessToken, "server_info");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Rate limited, try again in a minute.");
    expect((await calls(2)).map((x) => x.status)).toEqual(["ok", "rate_limited"]);
  });

  it("the daily cap refuses without writing limiter rows", async () => {
    const t = await connectAgent(A);
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('api:ud:ua', ?, 1000)", Math.floor(Date.now() / 1000));
    const before = await all<Row>("SELECT * FROM auth_limits WHERE key LIKE 'api:%' ORDER BY key");
    const r = await tool(t.accessToken, "server_info");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Daily limit reached, try again tomorrow (UTC).");
    expect(await lastCall()).toMatchObject({ status: "rate_limited" });
    expect(await all<Row>("SELECT * FROM auth_limits WHERE key LIKE 'api:%' ORDER BY key")).toEqual(before);
  });
});
