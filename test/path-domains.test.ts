// S8c Task 5: the main short domain shares its host with the dashboard (R4 reserved slug, R8 page headers, R15 attach).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { wrapper } from "../src/index";
import { hashPassword } from "../src/password";
import { INTERSTITIAL_HEADERS } from "../src/unlock";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";
import { pathEnv, testCtx } from "./helpers/path";
import { signedIn } from "./helpers/session";

const R8_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const hostEnv = (over: Partial<Env> = {}) => ({ ...env, DASHBOARD_HOST: "dash.test", AUTH_MODE: "app", ...over }) as Env;

let cookie = "";
/** A dashboard API call as the signed-in owner: path mode under short.test/dashboard, host mode on dash.test. */
function api(method: string, path: string, body?: unknown, e: Env = pathEnv()): Promise<Response> {
  const origin = e.DASHBOARD_PATH ? "https://short.test" : "https://dash.test";
  const name = e.DASHBOARD_PATH ? "__Secure-lw_session" : "__Host-lw_session";
  const url = `${origin}${e.DASHBOARD_PATH ?? ""}${path}`;
  return wrapper(new Request(url, {
    method, redirect: "manual",
    headers: { origin, cookie: `${name}=${cookie}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), e, testCtx());
}
const domain = (id: string, host: string, cs = 0) =>
  run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES (?,?,'main','active','o1',?,1)", id, host, cs);
const link = (id: string, domainId: string, slug: string, extra: Record<string, unknown> = {}) =>
  run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,password_hash,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,302,?,'o1','o1',1,1)",
    id, domainId, slug, slug.toLowerCase(), "https://dest.example.com/x", extra.password_hash ?? null,
  );

beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domain_cf", "domains", "sessions", "auth_limits", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  cookie = (await signedIn("owner@example.com", { id: "o1", role: "owner" })).value;
});
afterEach(() => vi.restoreAllMocks());

describe("the dashboard host as a main domain", () => {
  it("path mode: a fresh instance adds its main domain (no dashboard_host refusal)", async () => {
    const r = await api("POST", "/api/domains", { host: "short.test", type: "main" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ host: "short.test", status: "active" });
  });
  it("host mode: the dashboard host is still refused", async () => {
    const r = await api("POST", "/api/domains", { host: "dash.test", type: "main" }, hostEnv());
    expect([r.status, await r.json()]).toEqual([400, { error: "dashboard_host" }]);
  });
  it("path mode: the dashboard host is main only, so a member cannot claim it before the owner", async () => {
    const owner = cookie;
    cookie = (await signedIn("member@example.com", { id: "m1", role: "member" })).value;
    const m = await api("POST", "/api/domains", { host: "short.test", type: "private" });
    expect([m.status, await m.json()]).toEqual([400, { error: "dashboard_main_only" }]);
    expect((await api("POST", "/api/domains", { host: "short.test", type: "shared" })).status).toBe(403);
    cookie = owner;
    for (const type of ["private", "shared"]) {
      const r = await api("POST", "/api/domains", { host: "Short.Test", type });
      expect([type, r.status, await r.json()]).toEqual([type, 400, { error: "dashboard_main_only" }]);
    }
    expect(await one("SELECT COUNT(*) n FROM domains")).toEqual({ n: 0 });
    expect((await api("POST", "/api/domains", { host: "short.test", type: "main" })).status).toBe(201);
  });
});

describe("the prefix segment is reserved on the dashboard host (R4)", () => {
  beforeEach(async () => {
    await domain("ds", "short.test", 1); // case-sensitive: the reserved check still ignores case
    await domain("da", "other.test");
  });
  const check = async (dom: string, slug: string, e?: Env) => (await (await api("GET", `/api/links/check?domain=${dom}&slug=${slug}`, undefined, e)).json<{ status: string }>()).status;

  it("links/check answers reserved for every case of the prefix on short.test", async () => {
    for (const s of ["dashboard", "Dashboard", "DASHBOARD"]) expect(await check("ds", s)).toBe("reserved");
  });
  it("with prefix /go the slug go is reserved on short.test only; create refuses it", async () => {
    const e = pathEnv({ DASHBOARD_PATH: "/go" });
    expect(await check("ds", "go", e)).toBe("reserved");
    expect(await check("ds", "GO", e)).toBe("reserved");
    expect(await check("da", "go", e)).toBe("available");
    const r = await api("POST", "/api/links", { domainId: "ds", slug: "Go", url: "https://dest.example.com/" }, e);
    expect([r.status, await r.json()]).toEqual([400, { error: "reserved" }]);
    expect((await api("POST", "/api/links", { domainId: "da", slug: "go", url: "https://dest.example.com/" }, e)).status).toBe(201);
  });
  it("host mode: no prefix slug beyond the defaults", async () => {
    await domain("dd", "dash.test");
    expect(await check("dd", "go", hostEnv())).toBe("available");
  });
  it("bulk move and copy onto short.test refuse that link only", async () => {
    const e = pathEnv({ DASHBOARD_PATH: "/go" });
    await link("l1", "da", "go");
    await link("l2", "da", "fine");
    for (const oldAddress of ["forward", "copy"] as const) {
      const r = await api("POST", "/api/links/bulk", { action: "move", ids: ["l1"], domainId: "ds", oldAddress }, e);
      expect(r.status).toBe(200);
      expect((await r.json<{ results: { id: string; ok: boolean; error?: string }[] }>()).results).toEqual([{ id: "l1", ok: false, error: "reserved" }]);
    }
    const ok = await api("POST", "/api/links/bulk", { action: "move", ids: ["l2"], domainId: "ds", oldAddress: "forward" }, e);
    expect((await ok.json<{ results: { ok: boolean }[] }>()).results[0]!.ok).toBe(true);
    expect(await one("SELECT domain_id FROM links WHERE id = 'l1'")).toEqual({ domain_id: "da" });
  });
  it("import reports reserved_path for short.test/dashboard and writes nothing for it", async () => {
    const body = {
      mainHost: "short.test", domains: [], confirmNoPasswords: true,
      links: [
        { host: "short.test", slug: "Dashboard", destination: "https://dest.example.com/a", enabled: true },
        { host: "short.test", slug: "dashboard", destination: "https://dest.example.com/a", enabled: false },
        { host: "other.test", slug: "dashboard", destination: "https://dest.example.com/b", enabled: true },
      ],
    };
    const r = await api("POST", "/api/import", body);
    expect(r.status).toBe(200);
    const j = await r.json<{ created: number; conflicts: unknown[] }>();
    expect(j.conflicts).toEqual([
      { host: "short.test", slug: "Dashboard", reason: "reserved_path" },
      { host: "short.test", slug: "dashboard", reason: "reserved_path" },
    ]);
    expect(j.created).toBe(1); // DEFAULT_RESERVED words are still allowed by import on other domains
    expect(await one("SELECT COUNT(*) n FROM links WHERE domain_id = 'ds'")).toEqual({ n: 0 });
    expect(await one("SELECT COUNT(*) n FROM slug_locks WHERE domain_id = 'ds'")).toEqual({ n: 0 });
  });
  const oneLink = (mainHost: string) => ({ mainHost, domains: [], confirmNoPasswords: true, links: [{ host: null, slug: "a", destination: "https://dest.example.com/a", enabled: true }] });
  it("path mode import never creates the dashboard host (main only) nor uses a non-main row of it", async () => {
    await run("DELETE FROM domains WHERE id = 'ds'");
    const refused = { created: 0, conflicts: [{ host: "short.test", slug: "a", reason: "dashboard_main_only" }], domainsCreated: [] };
    expect(await (await api("POST", "/api/import", oneLink("short.test"))).json()).toMatchObject(refused);
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dq','short.test','private','active','o1',1)");
    expect(await (await api("POST", "/api/import", oneLink("short.test"))).json()).toMatchObject(refused);
    expect(await one("SELECT COUNT(*) n FROM links")).toEqual({ n: 0 });
  });
  it("host mode import still refuses the dashboard host", async () => {
    const r = await api("POST", "/api/import", oneLink("dash.test"), hostEnv());
    expect(await r.json()).toMatchObject({ created: 0, conflicts: [{ host: "dash.test", slug: "a", reason: "dashboard_host" }] });
  });
  it("host mode import naming an existing dashboard-host row reports dashboard_host, dry run too, and writes nothing", async () => {
    await domain("dd", "dash.test"); // for example left over from path mode
    for (const q of ["?dryRun=1", ""]) {
      const r = await api("POST", `/api/import${q}`, oneLink("dash.test"), hostEnv());
      expect([q, await r.json()]).toMatchObject([q, { created: 0, conflicts: [{ host: "dash.test", slug: "a", reason: "dashboard_host" }] }]);
    }
    expect(await one("SELECT COUNT(*) n FROM links")).toEqual({ n: 0 });
  });
});

describe("short-link HTML pages (R8)", () => {
  const page = (host: string, path: string, e: Env, init: RequestInit = {}) =>
    wrapper(new Request(`https://${host}${path}`, { redirect: "manual", ...init }), e, testCtx());
  const noScript = async (r: Response) => expect(await r.clone().text()).not.toMatch(/<script|\son[a-z]+=|javascript:/i);

  for (const [mode, e, host] of [["path", pathEnv(), "short.test"], ["host", hostEnv(), "short.test"]] as const) {
    it(`${mode} mode: not-found and pending pages carry the exact R8 CSP and nosniff`, async () => {
      await domain("ds", "short.test");
      await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dp','pend.test','private','pending','o1',1)");
      for (const r of [await page(host, "/nope", e), await page("pend.test", "/x", e), await page("unknown.test", "/x", e)]) {
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(r.headers.get("content-security-policy")).toBe(R8_CSP);
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        await noScript(r);
      }
    });
    it(`${mode} mode: password ask and wrong-password pages run no script and carry nosniff`, async () => {
      await domain("ds", "short.test");
      await link("lp", "ds", "secret", { password_hash: await hashPassword("right-pw-1", 1000) });
      const ask = await page(host, "/secret", e);
      const wrong = await page(host, "/secret", e, {
        method: "POST", body: "password=wrong",
        headers: { origin: `https://${host}`, "content-type": "application/x-www-form-urlencoded", "content-length": "14", "cf-connecting-ip": "203.0.113.50" },
      });
      for (const [r, status] of [[ask, 200], [wrong, 401]] as const) {
        expect(r.status).toBe(status);
        expect(r.headers.get("content-security-policy")).toBe(INTERSTITIAL_HEADERS["content-security-policy"]);
        expect(r.headers.get("content-security-policy")).toMatch(/^default-src 'none'; /);
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        await noScript(r);
      }
    });
  }

  it("path mode: a password unlock POST on short.test/<slug> still works", async () => {
    await domain("ds", "short.test");
    await link("lp", "ds", "secret", { password_hash: await hashPassword("right-pw-1", 1000) });
    const r = await page("short.test", "/secret", pathEnv(), {
      method: "POST", body: "password=right-pw-1",
      headers: { origin: "https://short.test", "content-type": "application/x-www-form-urlencoded", "content-length": "19", "cf-connecting-ip": "203.0.113.51" },
    });
    expect([r.status, r.headers.get("location")]).toEqual([303, "https://dest.example.com/x"]);
  });
});

describe("attaching the dashboard host as the main domain (R15)", () => {
  const CF = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw" };
  const ev = env as unknown as Record<string, string | undefined>;
  beforeEach(() => { for (const [k, v] of Object.entries(CF)) ev[k] = v; });
  afterEach(() => { for (const k of Object.keys(CF)) ev[k] = undefined; assertNoUnexpectedCloudflareCalls(); });
  const managed = { id: "wc1", zoneId: "zs", type: "AAAA", name: "short.test", content: "100::", proxied: true, comment: null };

  it("a Worker custom domain record needs the takeover confirm; then active, the record kept and not stored, a route created", async () => {
    const fake = installFakeCloudflare({ zones: [{ id: "zs", name: "short.test" }] });
    fake.state.dns.push({ ...managed });
    const r = await api("POST", "/api/domains", { host: "short.test", type: "main" });
    expect([r.status, await r.json()]).toEqual([409, { error: "dns_record_exists", records: [{ type: "AAAA", name: "short.test", content: "100::" }] }]);
    const ok = await api("POST", "/api/domains", { host: "short.test", type: "main", confirmTakeover: true });
    expect(ok.status).toBe(201);
    const j = await ok.json<Record<string, any>>();
    expect(j).toMatchObject({ status: "active" });
    expect(j.cloudflare).toMatchObject({ dns: "found", ownership: "verified", lastError: null });
    expect(await one("SELECT dns_record_id FROM domain_cf WHERE domain_id = ?", j.id)).toEqual({ dns_record_id: null });
    expect(fake.state.dns.map((d) => d.id)).toEqual(["wc1"]);
    expect(fake.state.routes.map((x) => [x.zoneId, x.pattern, x.script])).toEqual([["zs", "short.test/*", "lw"]]);
  });
  it("a refused route still gives 201 active with lastError", async () => {
    const fake = installFakeCloudflare({ zones: [{ id: "zs", name: "short.test" }] });
    fake.state.dns.push({ ...managed });
    // Only the route create is refused (a custom domain may already hold the hostname); the pre-insert route list still answers.
    vi.mocked(fetch).mockImplementation(async (i, init) => {
      const req = new Request(i as RequestInfo, init);
      return req.method === "POST" && req.url.endsWith("/workers/routes")
        ? Response.json({ success: false, errors: [{ code: 10020, message: "route already exists" }] }, { status: 409 })
        : fake.handle(req);
    });
    const r = await api("POST", "/api/domains", { host: "short.test", type: "main", confirmTakeover: true });
    expect(r.status).toBe(201);
    const j = await r.json<Record<string, any>>();
    expect(j.status).toBe("active");
    expect(j.cloudflare.lastError).not.toBeNull();
    expect(fake.state.dns.map((d) => d.id)).toEqual(["wc1"]);
  });
});
