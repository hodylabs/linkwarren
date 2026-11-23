// S8c: in path mode the machine API (/api/v1) and MCP live at the root of the main domain, never under the dashboard prefix;
// `mcp` and `api` are reserved slugs there.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { wrapper } from "../src/index";
import { pathEnv, testCtx } from "./helpers/path";
import { signedIn } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const NOT_FOUND = [404, { error: "not_found" }];
const answer = async (r: Response) => [r.status, await r.json()];

let cookie = "";
const send = (url: string, init: RequestInit = {}, e: Env = pathEnv()) =>
  wrapper(new Request(url.startsWith("https://") ? url : `https://short.test${url}`, { redirect: "manual", ...init }), e, testCtx());
/** The dashboard's own session API, under the prefix. */
const dashApi = (method: string, path: string, body?: unknown) =>
  send(`/dashboard${path}`, {
    method,
    headers: { origin: "https://short.test", cookie: `__Secure-lw_session=${cookie}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "sessions", "auth_limits", "api_keys", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  cookie = (await signedIn("owner@example.com", { id: "o1", role: "owner" })).value;
  await run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES ('ds','short.test','main','active','o1',1,1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('da','other.test','main','active','o1',1)");
});
afterEach(() => vi.restoreAllMocks());

async function newKey(): Promise<string> {
  const r = await dashApi("POST", "/api/keys", { name: "ci", write: true, del: false, domainIds: [], expiresInDays: 90 });
  expect(r.status).toBe(201);
  return (await r.json<{ secret: string }>()).secret;
}

describe("the machine API at the root of the main domain", () => {
  it("/api/v1 on the main domain serves Bearer keys, reads and writes", async () => {
    const k = await newKey();
    const doms = await send("/api/v1/domains", { headers: bearer(k) });
    expect(doms.status).toBe(200);
    const made = await send("/api/v1/links", { method: "POST", headers: { ...bearer(k), "content-type": "application/json" }, body: JSON.stringify({ domainId: "ds", slug: "via-root", url: "https://dest.example.com/r" }) });
    expect(made.status).toBe(201);
    const go = await send("/via-root");
    expect([go.status, go.headers.get("location")]).toEqual([302, "https://dest.example.com/r"]);
  });

  it("keeps its own auth: no key is 401, a session cookie is never accepted", async () => {
    expect(await answer(await send("/api/v1/domains"))).toEqual([401, { error: "unauthenticated" }]);
    expect((await send("/api/v1/domains", { headers: { cookie: `__Secure-lw_session=${cookie}`, origin: "https://short.test" } })).status).toBe(401);
  });

  it("<base>/api/v1 no longer serves v1: JSON 404 with a key, with a cookie, raw or encoded", async () => {
    const k = await newKey();
    for (const p of ["/dashboard/api/v1", "/dashboard/api/v1/domains", "/dashboard/api/%761/domains"])
      for (const headers of [bearer(k), { cookie: `__Secure-lw_session=${cookie}`, origin: "https://short.test" }])
        expect([p, ...(await answer(await send(p, { headers })))]).toEqual([p, ...NOT_FOUND]);
  });

  it("other /api paths at the root of the main domain are JSON 404, never the dashboard app or a short link", async () => {
    for (const p of ["/api", "/api/", "/api/me", "/api/keys", "/api/x/y", "/mcp/x"])
      for (const method of ["GET", "POST"])
        expect([p, method, ...(await answer(await send(p, { method, headers: { cookie: `__Secure-lw_session=${cookie}`, origin: "https://short.test" } })))])
          .toEqual([p, method, ...NOT_FOUND]);
    // The dashboard's session API is still under the prefix.
    expect((await dashApi("GET", "/api/me")).status).toBe(200);
  });

  it("/api/... and /mcp on another domain stay short links", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES ('lo','da','api','api','https://dest.example.com/api',302,'o1','o1',1,1)");
    const r = await send("https://other.test/api");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.example.com/api"]);
    const ref = await send("https://other.test/no-such-slug-xyz");
    const nested = await send("https://other.test/api/v1/domains");
    expect([nested.status, await nested.text()]).toEqual([ref.status, await ref.text()]);
  });

  it("host mode is unchanged: /api/v1 at the root of the dashboard host", async () => {
    const e = { ...env, DASHBOARD_HOST: "dash.test", AUTH_MODE: "app" } as Env;
    expect(await answer(await send("https://dash.test/api/v1/domains", {}, e))).toEqual([401, { error: "unauthenticated" }]);
  });
});

describe("mcp and api are reserved slugs on the main domain in path mode", () => {
  const check = async (dom: string, slug: string) => (await (await dashApi("GET", `/api/links/check?domain=${dom}&slug=${slug}`)).json<{ status: string }>()).status;

  it("check and create refuse every case on short.test", async () => {
    for (const s of ["mcp", "MCP", "Mcp", "api", "API"]) {
      expect([s, await check("ds", s)]).toEqual([s, "reserved"]);
      expect([s, ...(await answer(await dashApi("POST", "/api/links", { domainId: "ds", slug: s, url: "https://dest.example.com/" })))]).toEqual([s, 400, { error: "reserved" }]);
    }
  });

  it("bulk move and copy onto short.test refuse them", async () => {
    for (const [id, slug] of [["l1", "mcp"], ["l2", "API"]])
      await run("INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES (?,'da',?,?,'https://dest.example.com/x',302,'o1','o1',1,1)", id, slug, slug.toLowerCase());
    for (const oldAddress of ["forward", "copy"]) {
      const r = await dashApi("POST", "/api/links/bulk", { action: "move", ids: ["l1", "l2"], domainId: "ds", oldAddress });
      expect((await r.json<{ results: unknown[] }>()).results).toEqual([{ id: "l1", ok: false, error: "reserved" }, { id: "l2", ok: false, error: "reserved" }]);
    }
    expect(await one("SELECT COUNT(*) n FROM links WHERE domain_id = 'ds'")).toEqual({ n: 0 });
  });

  it("import reports reserved_path on short.test only (live and locked rows); other domains still allow them", async () => {
    const row = (host: string, slug: string, enabled = true) => ({ host, slug, destination: "https://dest.example.com/a", enabled });
    const r = await dashApi("POST", "/api/import", {
      mainHost: "short.test", domains: [], confirmNoPasswords: true,
      links: [row("short.test", "mcp"), row("short.test", "Api"), row("short.test", "MCP", false), row("other.test", "mcp"), row("other.test", "api")],
    });
    const j = await r.json<{ created: number; conflicts: unknown[] }>();
    expect(j.conflicts).toEqual([
      { host: "short.test", slug: "mcp", reason: "reserved_path" },
      { host: "short.test", slug: "Api", reason: "reserved_path" },
      { host: "short.test", slug: "MCP", reason: "reserved_path" },
    ]);
    expect(j.created).toBe(2);
    expect(await one("SELECT COUNT(*) n FROM slug_locks WHERE domain_id = 'ds'")).toEqual({ n: 0 });
  });
});
