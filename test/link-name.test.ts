import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { getLink } from "../src/cache";
import { checkLinkName } from "../src/validate";
import { TOOLS } from "../src/mcp/tools";

// S12: the optional link name: validation at the API boundary, PATCH semantics, search, and kept out of the redirect's KV entry.
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
async function call(method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor("a@example.com"), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const post = (body: Record<string, unknown>) => call("POST", "/api/links", { domainId: "dm", url: "https://x.com/a", ...body });

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ua','a@example.com','member','active',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES ('dm','go.test','main','active','ua',0,1)");
});

describe("checkLinkName", () => {
  it("trims, stores null for empty, caps at 100 characters, refuses control characters", () => {
    expect(checkLinkName("  Spring  ")).toEqual({ ok: true, name: "Spring" });
    expect(checkLinkName("   ")).toEqual({ ok: true, name: null });
    expect(checkLinkName(null)).toEqual({ ok: true, name: null });
    expect(checkLinkName("é".repeat(100))).toEqual({ ok: true, name: "é".repeat(100) });
    for (const bad of ["x".repeat(101), "a\nb", "tab\there", `a${String.fromCharCode(0x2028)}b`, `a${String.fromCharCode(0x85)}b`]) expect(checkLinkName(bad)).toEqual({ ok: false });
  });
});

describe("link name API", () => {
  it("is optional on create, trimmed, and an empty one stores null", async () => {
    const a = (await (await post({ slug: "n1", name: "  Spring poster  " })).json()) as { id: string; name: string | null };
    expect(a.name).toBe("Spring poster");
    expect((await one<{ name: string }>("SELECT name FROM links WHERE id = ?", a.id))!.name).toBe("Spring poster");
    expect(((await (await post({ slug: "n2", name: "   " })).json()) as { name: string | null }).name).toBeNull();
    expect(((await (await post({ slug: "n3" })).json()) as { name: string | null }).name).toBeNull();
  });

  it("refuses a bad name with bad_link_name on create and PATCH", async () => {
    const r = await post({ slug: "bad", name: "x".repeat(101) });
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_link_name" }]);
    const { id } = (await (await post({ slug: "p" })).json()) as { id: string };
    const p = await call("PATCH", `/api/links/${id}`, { name: "a\nb" });
    expect([p.status, await p.json()]).toEqual([400, { error: "bad_link_name" }]);
  });

  it("PATCH sets it, keeps it when absent, and clears it with null or empty", async () => {
    const { id } = (await (await post({ slug: "p" })).json()) as { id: string };
    const patch = async (b: Record<string, unknown>) => ((await (await call("PATCH", `/api/links/${id}`, b)).json()) as { name: string | null }).name;
    expect(await patch({ name: "Menu" })).toBe("Menu");
    expect(await patch({ url: "https://x.com/b" })).toBe("Menu");
    expect(await patch({ name: "" })).toBeNull();
    await patch({ name: "Again" });
    expect(await patch({ name: null })).toBeNull();
  });

  it("the list search (dashboard and /api/v1 share it) matches the name as well as slug and destination", async () => {
    await post({ slug: "s1", name: "Spring poster" });
    await post({ slug: "s2" });
    const r = (await (await call("GET", "/api/links?q=poster")).json()) as { items: { slug: string; name: string | null }[] };
    expect(r.items.map((l) => [l.slug, l.name])).toEqual([["s1", "Spring poster"]]);
  });

  it("stays out of the KV entry the redirect reads", async () => {
    await post({ slug: "kv", name: "Secret campaign label" });
    expect((await getLink(env, "dm", "kv"))!.url).toBe("https://x.com/a"); // the redirect path's read fills KV
    const cached = await env.CACHE.get("l2:dm:kv");
    expect(cached).not.toBeNull();
    expect(cached).not.toContain("Secret campaign label");
    expect(cached).not.toContain('"name"');
    expect((await getLink(env, "dm", "kv"))!.url).toBe("https://x.com/a");
  });
});

describe("MCP inputs", () => {
  it("create_link and update_link take an optional name; search_links says it matches names", () => {
    expect(TOOLS.create_link!.input.safeParse({ domain: "go.test", slug: "a", url: "https://example.com/", name: "Spring poster" }).success).toBe(true);
    expect(TOOLS.update_link!.input.safeParse({ id: "l1", name: null }).success).toBe(true);
    expect(TOOLS.create_link!.input.safeParse({ domain: "go.test", slug: "a", url: "https://example.com/", name: "x".repeat(101) }).success).toBe(false);
    expect(TOOLS.search_links!.description).toContain("name");
  });
});
