import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { SECURITY_HEADERS } from "../src/assets";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const HTML = "<!doctype html><title>lw</title>";
const get = (host: string, path: string, init?: RequestInit) => exports.default.fetch(`https://${host}${path}`, init);

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)").run();
});

function expectHeaders(r: Response) {
  expect(r.headers.get("content-security-policy")).toBe(CSP);
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}

describe("dashboard host", () => {
  it("serves the app shell with security headers", async () => {
    const r = await get("dash.test", "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toBe(HTML);
    expectHeaders(r);
  });
  it.each(["/links", "/domains/abc", "/people?sel=u1"])("falls back to the shell for %s", async (p) => {
    const r = await get("dash.test", p);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(HTML);
    expectHeaders(r);
  });
  it("serves /sign-in with Referrer-Policy no-referrer and the rest of the headers", async () => {
    const r = await get("dash.test", "/sign-in");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(HTML);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it.each(["/sign-in/", "/sign-in//", "//sign-in", "/sign%2Din", "/sign-in?x=1"])("serves %s with Referrer-Policy no-referrer too", async (p) => {
    const r = await get("dash.test", p);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each(["/sign-in/x", "/sign-inx"])("keeps the default Referrer-Policy on %s", async (p) => {
    expect((await get("dash.test", p)).headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
  it("serves a real asset with the headers", async () => {
    const r = await get("dash.test", "/assets/app.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expectHeaders(r);
  });
  it("a missing asset stays 404 and is not HTML", async () => {
    const r = await get("dash.test", "/assets/missing.js");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<title>");
  });
  it("HEAD / is 200 with an empty body", async () => {
    const r = await get("dash.test", "/", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
  it("POST / is the JSON 404", async () => {
    const r = await get("dash.test", "/", { method: "POST" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
  it("unknown /api paths are JSON 404, never HTML", async () => {
    const r = await dash("/api/nope", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
  it.each(["/%61pi/x", "/%61pi"])("percent-encoded %s is the JSON 404, never HTML", async (p) => {
    const r = await dash(p, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") } });
    expect(r.status).toBe(404);
    expect(r.headers.get("x-fake-assets")).toBeNull();
    expect(await r.json()).toEqual({ error: "not_found" });
  });
  it("/healthz is unchanged", async () => {
    expect(await (await get("dash.test", "/healthz")).json()).toEqual({ ok: true });
  });
  it("answers 503 no_assets when the binding is missing", async () => {
    const e = env as unknown as { ASSETS?: unknown };
    const saved = e.ASSETS;
    delete e.ASSETS;
    try {
      const r = await get("dash.test", "/");
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "no_assets" });
      expect(r.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    } finally {
      e.ASSETS = saved;
    }
  });
});

describe("short hosts never serve dashboard files", () => {
  it.each(["/", "/index.html", "/assets/app.js"])("%s", async (p) => {
    const r = await get("short.test", p);
    expect(r.status).toBe(404);
    expect(r.headers.get("x-fake-assets")).toBeNull();
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(await r.text()).not.toContain("<title>lw</title>");
  });
});
