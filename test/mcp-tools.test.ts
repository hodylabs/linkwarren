import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { INSTRUCTIONS } from "../src/mcp/server";
import { apiAs, TOOLS } from "../src/mcp/tools";
import { ApiError } from "../src/mcp/run";
import { rowToUser } from "../src/types";
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
/** Calls that must write no tool_calls row (refused principal, a read-only limit refusal). */
const unlogged = (n = 1) => { made -= n; };
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

const seed = (key: string, count: number) =>
  run("INSERT INTO auth_limits (key, window_start, count) VALUES (?, ?, ?)", key, Math.floor(Date.now() / 1000), count);
const countOf = async (key: string) => (await one<{ count: number }>("SELECT count FROM auth_limits WHERE key = ?", key))?.count;

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
  await new Promise((r) => setTimeout(r, 150)); // let waitUntil writes land, so a row that should not exist is seen
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

  it("initialize returns the exact instructions and tools/list the ten tools", async () => {
    const t = await connectAgent(A);
    const init = await mcpCall(t.accessToken, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.instructions).toBe(INSTRUCTIONS);
    expect(init.body.result.serverInfo.name).toBe("linkwarren");
    const list = await mcpCall(t.accessToken, "tools/list");
    const tools = list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }[];
    expect(tools.map((x) => x.name).sort()).toEqual(
      ["bulk_links", "check_slug", "create_link", "delete_link", "get_link", "link_stats", "list_domains", "search_links", "server_info", "update_link"]);
    const writes = ["create_link", "update_link", "delete_link", "bulk_links"];
    for (const x of tools) expect(x.annotations?.readOnlyHint ?? false).toBe(!writes.includes(x.name));
    const hint = (n: string) => tools.find((x) => x.name === n)!.annotations!;
    expect([hint("create_link").destructiveHint, hint("update_link").destructiveHint, hint("delete_link").destructiveHint, hint("bulk_links").destructiveHint])
      .toEqual([false, true, true, true]);
    for (const x of tools) expect(x.annotations?.openWorldHint).toBe(false);
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

  it("list_domains maps to host, type, status (no link counts per tool call); check_slug answers", async () => {
    const t = await connectAgent(A);
    const d = await tool(t.accessToken, "list_domains");
    expect(d.structuredContent.items).toEqual([
      { host: "a.test", type: "private", status: "active" },
      { host: "go.test", type: "main", status: "active" },
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
      refused: true, summary: "Deleting go.test/spring sends visitors to the domain's not-found page and locks the slug; old addresses that forward to it are deleted and locked too.",
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

describe("bulk_links", () => {
  const ids = (r: Result) => r.structuredContent.results.map((x: { id: string; ok: boolean; error?: string }) => [x.id, x.ok ? "ok" : x.error]);

  it("INSTRUCTIONS carry the bulk sentence before the locked-slugs one", () => {
    expect(INSTRUCTIONS).toContain("bulk_links changes up to 50 links in one call with the same rules as one at a time; it refuses without confirm: true to delete, move, take links offline (endNow, a past expiry or a future start) or remove a password. A move needs oldAddress: forward (the old address keeps working and forwards to the new one) or copy (an independent copy on the new domain, the original stays); ask the person which, never choose for them. It sets a password on one link per call, returning the rest as pending to send again. Deleted slugs stay locked;");
  });

  it("read-only connection gets read_only and changes nothing", async () => {
    const t = await connectAgent(A);
    expect(errOf(await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo"], endNow: true }))).toEqual({ error: "read_only", status: 403 });
    expect(await one<Row>("SELECT expires_at FROM links WHERE id = 'lgo'")).toEqual({ expires_at: null });
  });

  it("schedule endNow on 2 links: both ok, slim link output, audit via = client name, N units on the daily caps", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo", "la"], endNow: true, confirm: true });
    expect(r.isError).toBeFalsy();
    expect(ids(r)).toEqual([["lgo", "ok"], ["la", "ok"]]);
    expect(r.structuredContent.pending).toEqual([]);
    expect(r.structuredContent.results[0].link).toEqual({ id: "lgo", shortUrl: "https://go.test/spring", url: "https://x.com/", hasPassword: false, forwardTo: null });
    const audit = await all<Row>("SELECT target_id, via FROM audit_log WHERE action = 'link.update' ORDER BY target_id");
    expect(audit).toEqual([{ target_id: "la", via: "Claude" }, { target_id: "lgo", via: "Claude" }]);
    // runTool charges one unit, the route the other: a bulk of N costs N in total.
    expect(await countOf("api:ud:ua")).toBe(2);
    expect(await countOf("api:day")).toBe(2);
    expect(await lastCall()).toMatchObject({ tool: "bulk_links", status: "ok" });
  });

  it("delete: refuses without confirm (links stay), delete_not_allowed without delete, deletes with both", async () => {
    const t = await connectAgent(A, { write: true, del: true });
    const r = await tool(t.accessToken, "bulk_links", { action: "delete", ids: ["lgo", "la", "lgo"] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      refused: true, summary: "Deleting 2 links sends their visitors to each domain's not-found page and locks the slugs; old addresses that forward to them are deleted and locked too.",
    });
    expect(await lastCall()).toMatchObject({ tool: "bulk_links", status: "refused" });
    expect((await all("SELECT id FROM links WHERE id IN ('lgo','la')")).length).toBe(2);
    const w = await connectAgent(A, { write: true });
    expect(errOf(await tool(w.accessToken, "bulk_links", { action: "delete", ids: ["lgo"], confirm: true }))).toEqual({ error: "delete_not_allowed", status: 403 });
    const ok = await tool(t.accessToken, "bulk_links", { action: "delete", ids: ["lgo", "la"], confirm: true });
    expect(ids(ok)).toEqual([["lgo", "ok"], ["la", "ok"]]);
    expect(await one("SELECT 1 FROM links WHERE id IN ('lgo','la')")).toBeNull();
  });

  it("move without oldAddress refuses naming both choices; without confirm refuses; nothing moves", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "a.test", confirm: true });
    expect(r.structuredContent).toEqual({
      refused: true,
      summary: "Moving 1 link to a.test: ask the person whether each old address should forward to the new one (oldAddress: forward) or stay as an independent link with a copy on a.test (oldAddress: copy).",
    });
    const f = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "forward" });
    expect(f.structuredContent).toEqual({ refused: true, summary: "Moving 1 link to a.test; each old address will forward to the new one." });
    const c = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "copy" });
    expect(c.structuredContent).toEqual({ refused: true, summary: "Copying 1 link to a.test; the originals stay as they are." });
    expect((await calls(3)).map((x) => x.status)).toEqual(["refused", "refused", "refused"]);
    expect(await one<Row>("SELECT domain_id FROM links WHERE id = 'lgo'")).toEqual({ domain_id: "dgo" });
    expect((await all("SELECT id FROM links")).length).toBe(3);
  });

  it("move forward with confirm: the link moves and a forwarder keeps the old address", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "forward", confirm: true });
    expect(ids(r)).toEqual([["lgo", "ok"]]);
    expect(r.structuredContent.results[0].link).toMatchObject({ id: "lgo", shortUrl: "https://a.test/spring", forwardTo: null });
    expect(await one<Row>("SELECT domain_id FROM links WHERE id = 'lgo'")).toEqual({ domain_id: "da" });
    expect(await one<Row>("SELECT url, forward_to FROM links WHERE domain_id = 'dgo' AND slug_key = 'spring'"))
      .toEqual({ url: "https://a.test/spring", forward_to: "lgo" });
  });

  it("move copy with confirm: a copy on a.test, the original unchanged", async () => {
    const t = await connectAgent(A, { write: true });
    const before = await one<Row>("SELECT * FROM links WHERE id = 'lgo'");
    const r = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "dgo", oldAddress: "copy", confirm: true });
    expect(ids(r)).toEqual([["lgo", "same_domain"]]);
    const ok = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "copy", confirm: true });
    expect(ids(ok)).toEqual([["lgo", "ok"]]);
    expect(await one<Row>("SELECT * FROM links WHERE id = 'lgo'")).toEqual(before);
    const copy = await one<Row>("SELECT id, url, forward_to FROM links WHERE domain_id = 'da' AND slug_key = 'spring'");
    expect(copy).toMatchObject({ url: "https://x.com/", forward_to: null });
    expect(copy!.id).not.toBe("lgo");
    expect(ok.structuredContent.results[0].link.shortUrl).toBe("https://a.test/spring");
  });

  it("password on 3 links: 1 ok, 2 pending, never pbkdf2 or the password", async () => {
    const t = await connectAgent(A, { write: true });
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l3','da','cherry','cherry','https://x.com/','ua','ua',1,1)");
    const secret = "hunter2-correct-horse";
    const r = await tool(t.accessToken, "bulk_links", { action: "password", ids: ["lgo", "la", "l3"], password: secret });
    expect(ids(r)).toEqual([["lgo", "ok"]]);
    expect(r.structuredContent.pending).toEqual(["la", "l3"]);
    expect(r.structuredContent.results[0].link.hasPassword).toBe(true);
    expect(r.raw).not.toContain("pbkdf2");
    expect(r.raw).not.toContain(secret);
  });

  it("the daily cap counts per link: the route's 429 comes back as is and only runTool's unit stays", async () => {
    const t = await connectAgent(A, { write: true });
    await seed("api:ud:ua", 996);
    const r = await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo", "la", "x1", "x2", "x3"], endNow: true, confirm: true });
    expect(errOf(r)).toEqual({ error: "rate_limited", status: 429 });
    expect(r.raw).not.toContain("Daily limit");
    expect(await lastCall()).toMatchObject({ tool: "bulk_links", status: "error" });
    expect(await countOf("api:ud:ua")).toBe(997);
    expect(await one<Row>("SELECT expires_at FROM links WHERE id = 'lgo'")).toEqual({ expires_at: null });
  });

  it("bounded input: over 50 ids, a bad id, a bad oldAddress or an oversize password never runs", async () => {
    const t = await connectAgent(A, { write: true, del: true });
    for (const args of [
      { action: "schedule", ids: Array.from({ length: 51 }, (_, i) => `l${i}`), endNow: true },
      { action: "schedule", ids: [], endNow: true },
      { action: "delete", ids: ["../keys"], confirm: true },
      { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "lock", confirm: true },
      { action: "password", ids: ["lgo"], password: "p".repeat(1025) },
      { action: "schedule", ids: ["lgo"], endNow: false, startsAt: 1 },
      { action: "rename", ids: ["lgo"] },
      { action: "delete", ids: ["lgo"], confirm: "true" },
      { action: "delete", ids: ["lgo"], confirm: 1 },
      { action: "move", ids: ["lgo"], domain: "a.test", oldAddress: "forward", confirm: "yes" },
      { action: "move", ids: ["lgo"], domainId: "da", oldAddress: "forward", confirm: true },
      { action: "schedule", ids: ["lgo"], endNow: true, confirm: true, force: true },
    ]) {
      const r = await mcpCall(t.accessToken, "tools/call", { name: "bulk_links", arguments: args });
      expect(r.body.error ?? r.body.result?.isError, JSON.stringify(r.body)).toBeTruthy();
    }
    expect(await all("SELECT * FROM auth_limits WHERE key LIKE 'api:%'")).toEqual([]);
    expect(await one("SELECT 1 FROM links WHERE id = 'lgo'")).not.toBeNull();
  });

  it("the links changed even when the domain lookup for short URLs fails: results and pending come back, shortUrl null", async () => {
    const link = { id: "lgo", domainId: "dgo", slug: "spring", url: "https://x.com/", hasPassword: false, forwardTo: null };
    const api = async (method: string, path: string) => {
      if (method === "POST" && path === "/links/bulk") return { results: [{ id: "lgo", ok: true, link }, { id: "la", ok: false, error: "conflict" }], pending: ["l3"] };
      throw new ApiError("unavailable", 503);
    };
    const p = { grant: { write: true, del: false } } as Parameters<NonNullable<typeof TOOLS.bulk_links>["run"]>[2];
    const out = await TOOLS.bulk_links!.run(api as never, { action: "redirect", ids: ["lgo", "la", "l3"], passQuery: false }, p, env);
    expect(out).toEqual({
      results: [{ id: "lgo", ok: true, link: { id: "lgo", shortUrl: null, url: "https://x.com/", hasPassword: false, forwardTo: null } }, { id: "la", ok: false, error: "conflict" }],
      pending: ["l3"],
    });
  });

  it("domain on a non-move action, or a move without one, is bad_input", async () => {
    const t = await connectAgent(A, { write: true });
    expect(errOf(await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo"], domain: "a.test", startsAt: 1 }))).toEqual({ error: "bad_input", status: 400 });
    expect(errOf(await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo"], oldAddress: "copy", confirm: true }))).toEqual({ error: "bad_input", status: 400 });
  });

  // Gate by effect: every way of taking a live link offline, and removing protection, needs confirm: true.
  const later = () => Math.floor(Date.now() / 1000) + 86400;
  const past = () => Math.floor(Date.now() / 1000) - 60;
  const OFF = (n: string) => `This schedule takes ${n} offline now; visitors stop reaching the destination.`;
  for (const [label, args, summary] of [
    ["endNow", { endNow: true }, OFF("2 links")],
    ["a past expiry", { expiresAt: past() }, OFF("2 links")],
    ["a future start", { startsAt: later() }, OFF("2 links")],
  ] as const) {
    it(`schedule with ${label}: refused without confirm (no route call, no write), applied with it`, async () => {
      const t = await connectAgent(A, { write: true });
      const r = await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo", "la"], ...args });
      expect(r.structuredContent).toEqual({ refused: true, summary });
      expect(await lastCall()).toMatchObject({ status: "refused" });
      expect(await countOf("api:ud:ua")).toBe(1); // runTool's unit only: the route never ran
      expect(await all<Row>("SELECT starts_at, expires_at FROM links WHERE id IN ('lgo','la')")).toEqual([
        { starts_at: null, expires_at: null }, { starts_at: null, expires_at: null }]);
      const ok = await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo", "la"], ...args, confirm: true });
      expect(ids(ok)).toEqual([["lgo", "ok"], ["la", "ok"]]);
    });
  }

  it("a schedule that keeps links live needs no confirm", async () => {
    const t = await connectAgent(A, { write: true });
    const r = await tool(t.accessToken, "bulk_links", { action: "schedule", ids: ["lgo"], expiresAt: later() });
    expect(ids(r)).toEqual([["lgo", "ok"]]);
  });

  it("removing a password: refused without confirm (hash kept), removed with it; 1 link wording", async () => {
    const t = await connectAgent(A, { write: true });
    await run("UPDATE links SET password_hash = 'pbkdf2$x' WHERE id = 'lgo'");
    const r = await tool(t.accessToken, "bulk_links", { action: "password", ids: ["lgo"], password: null });
    expect(r.structuredContent).toEqual({
      refused: true, summary: "Removing the password from 1 link lets anyone with the address reach the destination.",
    });
    expect(await countOf("api:ud:ua")).toBe(1);
    expect(await one<Row>("SELECT password_hash FROM links WHERE id = 'lgo'")).toEqual({ password_hash: "pbkdf2$x" });
    const ok = await tool(t.accessToken, "bulk_links", { action: "password", ids: ["lgo"], password: null, confirm: true });
    expect(ids(ok)).toEqual([["lgo", "ok"]]);
    expect(ok.structuredContent.results[0].link.hasPassword).toBe(false);
    expect(await one<Row>("SELECT password_hash FROM links WHERE id = 'lgo'")).toEqual({ password_hash: null });
  });

  it("delete and move refusals reach no route (only runTool's unit)", async () => {
    const t = await connectAgent(A, { write: true, del: true });
    await tool(t.accessToken, "bulk_links", { action: "delete", ids: ["lgo", "la"] });
    const m = await tool(t.accessToken, "bulk_links", { action: "move", ids: ["lgo", "la"], domain: "go.test", oldAddress: "copy" });
    expect(m.structuredContent.summary).toBe("Copying 2 links to go.test; the originals stay as they are.");
    expect(await countOf("api:ud:ua")).toBe(2);
    expect((await all("SELECT id FROM links")).length).toBe(3);
  });
});

describe("Review Focus 2: live access on every call", () => {
  it("revoked connection: every later call is refused, writes nothing, and a write does not run", async () => {
    const t = await connectAgent(A, { write: true });
    expect((await tool(t.accessToken, "server_info")).isError).toBeFalsy();
    await run("UPDATE agent_connections SET revoked_at = 1 WHERE id = ?", t.connId);
    const limits = await all<Row>("SELECT * FROM auth_limits ORDER BY key");
    for (let i = 0; i < 5; i++) {
      const r = await tool(t.accessToken, "server_info");
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe("This connection was disconnected or its person no longer has access.");
      unlogged();
    }
    const w = await tool(t.accessToken, "create_link", { domain: "go.test", slug: "late", url: "https://y.com" });
    unlogged();
    expect(w.isError).toBe(true);
    expect(await one("SELECT 1 FROM links WHERE slug = 'late'")).toBeNull();
    expect(await all<Row>("SELECT * FROM auth_limits ORDER BY key")).toEqual(limits);
  });

  it("write switched off: the next write gets read_only", async () => {
    const t = await connectAgent(A, { write: true });
    await run("UPDATE agent_connections SET can_write = 0, can_delete = 0 WHERE id = ?", t.connId);
    expect(errOf(await tool(t.accessToken, "create_link", { domain: "go.test", slug: "late", url: "https://y.com" }))).toEqual({ error: "read_only", status: 403 });
  });

  it("disabled person: the next call is refused and writes nothing", async () => {
    const t = await connectAgent(A);
    await run("UPDATE users SET status = 'disabled' WHERE id = 'ua'");
    const r = await tool(t.accessToken, "search_links");
    unlogged();
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("This connection was disconnected or its person no longer has access.");
  });
});

describe("rate limits", () => {
  it("the 61st call on one connection is rate limited; retries after it write nothing (one rate_limited row)", async () => {
    const t = await connectAgent(A);
    await seed(`api:c:${t.connId}`, 59);
    expect((await tool(t.accessToken, "server_info")).isError).toBeFalsy();
    const r = await tool(t.accessToken, "server_info");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Rate limited, try again in a minute.");
    const limits = await all<Row>("SELECT * FROM auth_limits ORDER BY key");
    for (let i = 0; i < 5; i++) {
      expect((await tool(t.accessToken, "server_info")).content[0]!.text).toBe("Rate limited, try again in a minute.");
      unlogged();
    }
    expect((await calls(2)).map((x) => x.status)).toEqual(["ok", "rate_limited"]);
    expect(await all<Row>("SELECT * FROM auth_limits ORDER BY key")).toEqual(limits);
    expect(await countOf(`api:c:${t.connId}`)).toBe(61);
  });

  it("api:u counts across two connections of one person", async () => {
    const t1 = await connectAgent(A);
    const t2 = await connectAgent(A);
    await seed("api:u:ua", 119);
    expect((await tool(t1.accessToken, "server_info")).isError).toBeFalsy();
    expect((await tool(t2.accessToken, "server_info")).content[0]!.text).toBe("Rate limited, try again in a minute.");
  });

  it("the daily cap: past it a call writes nothing; the first refusal at the cap is logged once", async () => {
    const t = await connectAgent(A);
    await seed("api:ud:ua", 1001);
    const before = await all<Row>("SELECT * FROM auth_limits ORDER BY key");
    const r = await tool(t.accessToken, "server_info");
    unlogged();
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Daily limit reached, try again tomorrow (UTC).");
    expect(await all<Row>("SELECT * FROM auth_limits ORDER BY key")).toEqual(before);
    await run("UPDATE auth_limits SET count = 1000 WHERE key = 'api:ud:ua'");
    expect((await tool(t.accessToken, "server_info")).content[0]!.text).toBe("Daily limit reached, try again tomorrow (UTC).");
    expect(await lastCall()).toMatchObject({ status: "rate_limited" });
  });

  it("the instance daily cap applies to every person", async () => {
    const t = await connectAgent(A);
    await seed("api:day", 3001);
    const r = await tool(t.accessToken, "list_domains");
    unlogged();
    expect(r.content[0]!.text).toBe("Daily limit reached, try again tomorrow (UTC).");
  });

  it("an allowed call counts on all four keys", async () => {
    const t = await connectAgent(A);
    await tool(t.accessToken, "server_info");
    expect((await all<Row>("SELECT key, count FROM auth_limits WHERE key LIKE 'api:%' ORDER BY key")).map((x) => [x.key, x.count]))
      .toEqual([["api:c:" + t.connId, 1], ["api:day", 1], ["api:u:ua", 1], ["api:ud:ua", 1]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it("a limiter failure fails closed: unavailable, the tool does not run, no tool_calls row", async () => {
    const t = await connectAgent(A, { write: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run("ALTER TABLE auth_limits RENAME TO auth_limits_off");
    try {
      for (let i = 0; i < 3; i++) {
        const r = await tool(t.accessToken, "create_link", { domain: "go.test", slug: "nolimit", url: "https://y.com" });
        unlogged(); // a retry loop against a broken limiter must not write a row per call
        expect(errOf(r)).toEqual({ error: "unavailable", status: 503 });
      }
    } finally {
      await run("ALTER TABLE auth_limits_off RENAME TO auth_limits");
    }
    expect(await one("SELECT 1 FROM links WHERE slug = 'nolimit'")).toBeNull();
  });

  it("concurrent calls at the threshold log one rate_limited row between them", async () => {
    const t = await connectAgent(A);
    await seed(`api:c:${t.connId}`, 60);
    const rs = await Promise.all(Array.from({ length: 6 }, () => tool(t.accessToken, "server_info")));
    unlogged(5);
    for (const r of rs) expect(r.content[0]!.text).toBe("Rate limited, try again in a minute.");
    expect((await calls(1)).map((x) => x.status)).toEqual(["rate_limited"]);
  });
});

describe("bounded inputs", () => {
  it("route devices: create_link and update_link accept every device value and refuse unknown ones", () => {
    const all9 = ["mobile", "tablet", "desktop", "ios", "android", "windows", "macos", "linux", "chromeos"];
    for (const name of ["create_link", "update_link"] as const) {
      const base = name === "create_link" ? { domain: "go.test", slug: "ok", url: "https://y.com" } : { id: "abc" };
      expect(TOOLS[name]!.input.safeParse({ ...base, routes: [{ devices: all9, url: "https://y.com" }] }).success).toBe(true);
      expect(TOOLS[name]!.input.safeParse({ ...base, routes: [{ devices: ["tv"], url: "https://y.com" }] }).success).toBe(false);
      expect(TOOLS[name]!.description).toMatch(/\bios\b.*chromeos.*iPad in desktop mode/);
    }
  });
  it("oversize or malformed input is refused before any limiter write or tool_calls row", async () => {
    const t = await connectAgent(A, { write: true });
    for (const [name, args] of [
      ["create_link", { domain: "go.test", slug: "s".repeat(65), url: "https://y.com" }],
      ["create_link", { domain: "go.test", slug: "ok", url: "https://y.com/" + "a".repeat(2048) }],
      ["create_link", { domain: "go.test", slug: "ok", url: "https://y.com", password: "p".repeat(1025) }],
      ["create_link", { domain: "go.test", slug: "ok", url: "https://y.com", routes: [{ countries: ["USA"], url: "https://y.com" }] }],
      ["create_link", { domain: "d".repeat(254), slug: "ok", url: "https://y.com" }],
      ["get_link", { id: "." }],
      ["get_link", { id: ".." }],
      ["delete_link", { id: "../keys", confirm: true }],
    ] as const) {
      const r = await mcpCall(t.accessToken, "tools/call", { name, arguments: args });
      expect(r.body.error ?? r.body.result?.isError, JSON.stringify(r.body)).toBeTruthy();
    }
    expect(await all("SELECT * FROM auth_limits WHERE key LIKE 'api:%'")).toEqual([]);
    expect(await one("SELECT 1 FROM links WHERE slug = 'ok'")).toBeNull();
  });

  it("apiAs refuses a path outside /api/v1 with a plain error, not an API answer", async () => {
    const user = rowToUser((await one<Row>("SELECT * FROM users WHERE id = 'ua'"))!);
    const api = apiAs(env, createExecutionContext(), { user, grant: { write: false, del: false, domains: null, via: "t" }, limiterKey: "api:c:x" });
    const e = await api("GET", "/../keys").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ApiError);
  });
});
