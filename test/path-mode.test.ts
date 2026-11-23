import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { handleRedirect } from "../src/redirect";
import { call, pathEnv, seedShort, testCtx } from "./helpers/path";

const hostEnv = (over: Partial<Env> = {}) => ({ ...env, DASHBOARD_HOST: "dash.test", AUTH_MODE: "app", ...over }) as Env;
const now = () => Math.floor(Date.now() / 1000);
const answer = async (r: Response) => [r.status, r.headers.get("location"), r.headers.get("content-type"), await r.text()];
/** What the short-link handler alone answers for `path` on short.test. */
const asShortLink = async (path: string) => answer(await handleRedirect(new Request(`https://short.test${path}`), pathEnv(), now(), testCtx()));
/** What a host-mode dashboard answers for the inner path. */
const asDashboard = async (inner: string) => answer(await call(`https://dash.test${inner}`, undefined, hostEnv()));

beforeAll(async () => {
  await seedShort();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES ('pl2','pd1','dashboardx','dashboardx','https://dest.example.com/dx',302,'pu1','pu1',1,1)",
  ).run();
});

describe("path mode on the main short domain", () => {
  it("short links redirect as today", async () => {
    const r = await call("/hello");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.example.com/hello"]);
  });

  it("/dashboardx is a short link, not the dashboard", async () => {
    const r = await call("/dashboardx");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.example.com/dx"]);
  });

  it("health lives under the base (R16)", async () => {
    const r = await call("/dashboard/healthz");
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
    const s = await call("/healthz");
    expect(s.headers.get("content-type")).not.toContain("json");
    expect(await s.text()).not.toContain('"ok"');
    expect(await answer(await call("/healthz"))).toEqual(await asShortLink("/healthz"));
  });

  // [request path, inner path when it is the dashboard or null for a short link]
  const table: [string, string | null][] = [
    ["/dashboard", "/"], ["/dashboard/", "/"], ["/dashboard/x", "/x"], ["/dashboard/api/me", "/api/me"], ["/dashboard/healthz", "/healthz"],
    ["/x/../dashboard", "/"], ["/x/../dashboard/api/me", "/api/me"], ["/dashboard/%61pi/me", "/%61pi/me"],
    ["/Dashboard", null], ["/Dashboard/api/me", null], ["/DASHBOARD/x", null], ["/%64ashboard", null], ["/%64ashboard/api/me", null],
    ["/dashboard%2fx", null], ["/dashboard%2fapi/me", null], ["//dashboard", null], ["//dashboard/api/me", null],
    ["/dashboard/../x", null], ["/dashboardapi", null], ["/healthz", null],
  ];
  // /api/... at the root is the machine API's space: JSON 404 outside /api/v1, never the dashboard or a short link.
  it.each(["/api/me", "/dashboard/%2e%2e/api/me"])("%s is JSON 404", async (path) => {
    const r = await call(path);
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
  });
  it.each(table)("%s", async (path, inner) => {
    const got = await answer(await call(path));
    const resolved = new URL(`https://short.test${path}`).pathname;
    // The shell differs only by its rooted URLs and base meta (R11); undo those to compare with host mode.
    if (inner !== null && typeof got[3] === "string") got[3] = got[3].replaceAll('"/dashboard', '"');
    expect(got).toEqual(inner === null ? await asShortLink(resolved) : await asDashboard(inner));
    if (inner === null) expect(got[3]).not.toContain('"email"');
  });

  it("the app's own decoded-path guard answers /dashboard/%61pi/me (the API, signed out), never the SPA", async () => {
    const r = await call("/dashboard/%61pi/me");
    expect([r.status, await r.json()]).toEqual([401, { error: "unauthenticated", signIn: "app" }]);
  });

  it.each(["short.test:8443", "SHORT.TEST", "short.test."])("Host %s is the dashboard host", async (host) => {
    const r = await call("/dashboard/healthz", { headers: { host } });
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
  });

  it.each(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/x"])(
    "discovery path %s is JSON 404 with agents off, never a short-link page (agents on: test/path-oauth.test.ts)",
    async (p) => {
      const r = await call(p, {}, pathEnv({ MCP_ENABLED: "0" }));
      expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
    },
  );

  it("other hosts still answer short links", async () => {
    const r = await call("https://other.test/x");
    expect(await answer(r)).toEqual(await answer(await handleRedirect(new Request("https://other.test/x"), pathEnv(), now())));
  });
});

describe("host mode is unchanged", () => {
  const paths = ["/dashboard", "/dashboard/x", "/Dashboard", "/%64ashboard", "/dashboard%2fx", "//dashboard", "/dashboardx", "/healthz", "/api/me", "/%61pi/me"];
  it.each(paths)("%s on dash.test answers as the app does", async (p) => {
    const e = hostEnv();
    expect(await answer(await call(`https://dash.test${p}`, undefined, e))).toEqual(
      await answer(await app.fetch(new Request(`https://dash.test${p}`), e, testCtx())),
    );
  });
});

describe("legacy dashboard host (R10)", () => {
  const legacy = (over: Partial<Env> = {}) => pathEnv({ LEGACY_DASHBOARD_HOST: "old.test", ...over });
  const old = (path: string, init?: RequestInit, e = legacy()) => call(`https://old.test${path}`, init, e);

  it("GET keeps path and query", async () => {
    const r = await old("/links?x=1");
    expect([r.status, r.headers.get("location"), r.headers.get("set-cookie"), await r.text()]).toEqual([301, "https://short.test/dashboard/links?x=1", null, ""]);
  });

  it("HEAD /join and / redirect", async () => {
    expect([(await old("/join", { method: "HEAD" })).status, (await old("/join", { method: "HEAD" })).headers.get("location")]).toEqual([301, "https://short.test/dashboard/join"]);
    expect((await old("/")).headers.get("location")).toBe("https://short.test/dashboard/");
  });

  it.each([
    "//evil.example", "//evil.example/x", "/\\evil.example", "/%2f%2fevil.example", "/@evil.example", "/%40evil.example",
    "/%0d%0aSet-Cookie:%20x=1", "/x?%0d%0aLocation:%20https://evil.example", "/../x", "/%2e%2e/x", "/.%2e/%2e./x", "/" + "a".repeat(6000),
    "/x?next=https://evil.example", "/%5cevil.example",
  ])("%s never leaves short.test/dashboard", async (p) => {
    const r = await old(p);
    expect(r.status).toBe(301);
    const loc = r.headers.get("location")!;
    expect(loc).not.toMatch(/[\r\n]/);
    const u = new URL(loc);
    expect([u.protocol, u.host]).toEqual(["https:", "short.test"]);
    expect(u.pathname.startsWith("/dashboard/")).toBe(true);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("an empty-prefix legacy setup (host mode) keeps the new host", async () => {
    const e = hostEnv({ DASHBOARD_HOST: "new.test", LEGACY_DASHBOARD_HOST: "old.test" });
    for (const p of ["//evil.example/x", "/\\evil.example", "/@evil.example"]) {
      const r = await old(p, undefined, e);
      expect([p, r.status, new URL(r.headers.get("location")!).host]).toEqual([p, 301, "new.test"]);
    }
  });

  it.each([
    ["POST", "/api/links"], ["PUT", "/x"], ["DELETE", "/api/links/1"], ["GET", "/.well-known/oauth-authorization-server"],
    ["HEAD", "/.well-known/oauth-protected-resource"], ["GET", "/.well-known/security.txt"],
  ])("%s %s is 410 moved", async (method, p) => {
    const r = await old(p, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    expect(r.status).toBe(410);
    expect(r.headers.get("location")).toBeNull();
    if (method !== "HEAD") expect(await r.json()).toEqual({ error: "moved", to: "https://short.test/dashboard/" });
  });

  it.each([
    ["POST", "/api/v1/links", "https://short.test/api/v1"], ["GET", "/api/v1/links?q=1", "https://short.test/api/v1"], ["GET", "/api/v1", "https://short.test/api/v1"],
    ["POST", "/mcp", "https://short.test/mcp"], ["GET", "/mcp", "https://short.test/mcp"], ["OPTIONS", "/mcp", "https://short.test/mcp"],
  ])("%s %s on the old host is 410 pointing at the root address %s", async (method, p, to) => {
    const r = await old(p, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    expect(r.status).toBe(410);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.json()).toEqual({ error: "moved", to });
  });

  it("never touches D1", async () => {
    const boom = { prepare() { throw new Error("db touched"); }, batch() { throw new Error("db touched"); } } as unknown as D1Database;
    const e = legacy({ DB: boom });
    expect((await old("/links", undefined, e)).status).toBe(301);
    expect((await old("/api/links", { method: "POST", body: "{}" }, e)).status).toBe(410);
  });
});

describe("dashboard shell in path mode (R11)", () => {
  const SHELL =
    '<!doctype html><html><head><title>lw</title><link rel="icon" href="/dashboard/linkwarren-mark.svg"><script type="module" src="/dashboard/assets/app.js"></script><meta name="lw-base" content="/dashboard"></head><body><a href="https://example.com/x">x</a></body></html>';
  const CSP =
    "default-src 'self'; script-src https://short.test/dashboard/assets/; style-src https://short.test/dashboard/assets/; font-src https://short.test/dashboard/assets/; img-src https://short.test/dashboard/ data:; connect-src https://short.test/dashboard/; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

  it.each(["/dashboard", "/dashboard/", "/dashboard/links/abc", "/dashboard/domains/x?sel=1"])("%s gets the rewritten shell", async (p) => {
    const r = await call(p);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SHELL);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("/dashboard/sign-in gets the shell with no-referrer", async () => {
    const r = await call("/dashboard/sign-in");
    expect([r.status, await r.text(), r.headers.get("referrer-policy"), r.headers.get("content-security-policy")]).toEqual([200, SHELL, "no-referrer", CSP]);
  });

  it("/dashboard/assets/app.js is served unrewritten", async () => {
    const r = await call("/dashboard/assets/app.js");
    expect([r.status, await r.text(), r.headers.get("x-fake-assets")]).toEqual([200, "export {}", "1"]);
  });

  it("a missing asset under the prefix stays 404, not the shell", async () => {
    const r = await call("/dashboard/assets/missing.js");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<title>");
  });

  it("HEAD /dashboard/links is 200 with an empty body and the path CSP", async () => {
    const r = await call("/dashboard/links", { method: "HEAD" });
    expect([r.status, await r.text(), r.headers.get("content-security-policy")]).toEqual([200, "", CSP]);
  });
});

describe("path mode short links when storage fails", () => {
  it("a D1 error on the main domain answers the app's JSON 500, not the platform error page", async () => {
    const broken = { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } } as unknown as D1Database;
    const e = pathEnv({ DB: broken });
    const r = await call("/no-such-slug-xyz", undefined, e);
    expect([r.status, await r.json()]).toEqual([500, { error: "internal" }]);
  });
});
