// S8c Task 4: OAuth and MCP under the dashboard path (R4, R5, R13), the wire contract the live checks use.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { LIMITS } from "../src/limits";
import { resetMcpCache } from "../src/mcp/switch";
import { handleRedirect } from "../src/redirect";
import { setupAccess } from "./helpers/access";
import {
  authorizePath, CLAUDE_CB, connectAgent, connectAgentFull, mcpCall, openConsent, pkce, postConsent, registerClient, signInHeaders, token,
} from "./helpers/oauth";
import { call, pathEnv, seedShort, testCtx } from "./helpers/path";

const O = "https://short.test";
const PR = "/.well-known/oauth-protected-resource/dashboard/mcp";
const on = (over: Partial<Env> = {}) => pathEnv({ MCP_ENABLED: "1", ...over });
const off = () => pathEnv({ MCP_ENABLED: "0" });
const json = async (r: Response) => [r.status, r.headers.get("content-type")?.split(";")[0], await r.json()];
const NOT_FOUND = [404, "application/json", { error: "not_found" }];

beforeAll(setupAccess); // the host-mode half of the R13 test signs in through Access
beforeEach(async () => {
  await env.DB.batch(["auth_limits", "sessions", "login_tokens"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM settings WHERE key = 'mcp.enabled'").run();
  resetMcpCache();
  await seedShort();
});
afterEach(() => {
  resetMcpCache();
  vi.restoreAllMocks();
});

describe("path mode wire contract (agents on)", () => {
  it("POST /dashboard/mcp without a token is 401 pointing at the path-inserted metadata", async () => {
    const r = await call("/dashboard/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, on());
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${O}${PR}"`);
  });

  it.each([PR, "/.well-known/oauth-protected-resource"])("GET %s is the protected resource metadata", async (p) => {
    const r = await call(p, {}, on());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ resource: `${O}/dashboard/mcp`, authorization_servers: [O] });
  });

  it("GET /.well-known/oauth-authorization-server has the origin issuer and prefixed endpoints", async () => {
    const r = await call("/.well-known/oauth-authorization-server", {}, on());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      issuer: O,
      authorization_endpoint: `${O}/dashboard/authorize`,
      token_endpoint: `${O}/dashboard/token`,
      registration_endpoint: `${O}/dashboard/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it.each([
    "/.well-known/oauth-authorization-server/dashboard", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/x",
    "/.well-known/openid-configuration", "/.well-known/openid-configuration/dashboard", "/.well-known/oauth-authorization-serverx",
    // Under the prefix a discovery document is never the dashboard HTML.
    "/dashboard/.well-known/oauth-authorization-server", "/dashboard/.well-known/oauth-protected-resource", `/dashboard${PR}`,
    "/dashboard/.well-known/oauth-protected-resource/mcp", "/dashboard/.well-known/openid-configuration",
  ])("GET %s is JSON 404", async (p) => {
    expect(await json(await call(p, {}, on()))).toEqual(NOT_FOUND);
  });

  it("the root /mcp, /authorize, /token and /register are short-link answers, never the provider", async () => {
    const answer = async (r: Response) => [r.status, r.headers.get("location"), r.headers.get("www-authenticate"), await r.text()];
    for (const p of ["/mcp", "/authorize", "/token", "/register", "/mcp/x"])
      for (const method of ["GET", "POST"]) {
        const ref = await handleRedirect(new Request(`${O}/no-such-slug-xyz`, { method }), on(), Math.floor(Date.now() / 1000), testCtx());
        expect([p, method, ...(await answer(await call(p, { method }, on())))]).toEqual([p, method, ...(await answer(ref))]);
      }
  });

  it("/dashboard/authorize signed out still sends to the prefixed sign-in (the default handler strips the prefix)", async () => {
    const r = await call("/dashboard/authorize?response_type=code&client_id=x", { headers: { "sec-fetch-dest": "document" } }, on());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")!.startsWith("/dashboard/sign-in?next=%2Fauthorize%3F")).toBe(true);
  });
});

describe("path mode with agents off", () => {
  it("every discovery path and /dashboard/{mcp,authorize,token,register}, raw and encoded, is JSON 404; short links still work", async () => {
    const paths = [
      PR, "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration",
      "/dashboard/mcp", "/dashboard/mcp/x", "/dashboard/authorize", "/dashboard/token", "/dashboard/register",
      "/dashboard/%6dcp", "/dashboard/%61uthorize", "/dashboard/%74oken", "/dashboard/%72egister", "/dashboard/.well-known/oauth-authorization-server",
    ];
    for (const p of paths)
      for (const method of ["GET", "POST", "OPTIONS"])
        expect([p, method, ...(await json(await call(p, { method }, off())))]).toEqual([p, method, ...NOT_FOUND]);
    const hello = await call("/hello", {}, off());
    expect([hello.status, hello.headers.get("location")]).toEqual([302, "https://dest.example.com/hello"]);
  });

  it("a served discovery path answers 503 unavailable when the switch cannot be read", async () => {
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("D1 down"); });
    for (const p of [PR, "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"])
      expect([p, ...(await json(await call(p, {}, on())))]).toEqual([p, 503, "application/json", { error: "unavailable" }]);
  });
});

describe("path mode full flow", () => {
  it("register, consent with the path cookie, approve from the origin, token, tools/list, server_info and refresh", async () => {
    const e = on();
    const { clientId } = await registerClient(CLAUDE_CB, {}, e);
    const { verifier, challenge } = await pkce();
    const auth = await signInHeaders(`po-${crypto.randomUUID()}@example.com`, undefined, e);
    expect(auth.cookie).toMatch(/^__Secure-lw_session=/);
    const state = crypto.randomUUID();
    const page = await openConsent(authorizePath({
      response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, state, code_challenge: challenge, code_challenge_method: "S256",
    }), { ...auth, "sec-fetch-dest": "document" }, e);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain('action="/dashboard/authorize"');
    const form = { handle: page.handle, uid: page.uid, action: "approve", access: "read" };

    // The consent POST is refused from any other origin (the dashboard origin has no path).
    expect((await postConsent(auth, page.binding, form, "https://other.test", "/authorize", e)).status).toBe(403);
    const done = await postConsent(auth, page.binding, form, O, "/authorize", e);
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location")!);
    expect([back.origin + back.pathname, back.searchParams.get("state"), back.searchParams.get("iss")]).toEqual([CLAUDE_CB, state, O]);

    const t = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier }, e);
    expect(t.status).toBe(200);
    const tok = await t.json<{ access_token: string; refresh_token: string }>();

    const list = await mcpCall(tok.access_token, "tools/list", undefined, undefined, e);
    expect(list.status).toBe(200);
    expect((list.body.result.tools as { name: string }[]).map((x) => x.name)).toContain("server_info");
    const who = await mcpCall(tok.access_token, "tools/call", { name: "server_info", arguments: {} }, testCtx(), e); // ctx and env: still path mode
    expect(JSON.parse(who.body.result.content[0].text).mcpUrl).toBe(`${O}/dashboard/mcp`);

    const r = await token({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }, e);
    expect(r.status).toBe(200);
    const fresh = await r.json<{ access_token: string }>();
    expect((await mcpCall(fresh.access_token, "tools/list", undefined, undefined, e)).status).toBe(200);
  });

  it("POST /dashboard/register keeps the registration limiter per /24 block", async () => {
    const reg = (ip: string) =>
      call("/dashboard/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ redirect_uris: [CLAUDE_CB], client_name: "T", grant_types: ["authorization_code"], token_endpoint_auth_method: "none" }),
      }, on());
    for (let i = 1; i <= LIMITS.reg.n; i++) expect((await reg(`203.0.113.${i}`)).status).toBe(201);
    const r = await reg("203.0.113.99");
    expect([r.status, await r.json()]).toEqual([429, { error: "rate_limited" }]);
  });
});

describe("switching an instance to path mode (R13)", () => {
  it("a token and refresh token from the host-mode provider are refused under the prefix on the same host", async () => {
    // Host mode on dash.test (the default test env), then the same host in path mode.
    const old = await connectAgentFull(`sw-${crypto.randomUUID()}@example.com`);
    expect((await mcpCall(old.accessToken, "tools/list")).status).toBe(200);
    const e = on({ DASHBOARD_HOST: "dash.test" });
    const r = await mcpCall(old.accessToken, "tools/list", undefined, undefined, e);
    expect(r.status).toBe(401);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: old.refreshToken, client_id: old.clientId }, e);
    expect([refreshed.status, await refreshed.json()]).toMatchObject([400, { error: "invalid_grant" }]);
    // And the other way round: a path-mode token is refused once the instance is back in host mode.
    const fresh = await connectAgent(`sw2-${crypto.randomUUID()}@example.com`, { env: e });
    expect((await mcpCall(fresh.accessToken, "tools/list", undefined, undefined, e)).status).toBe(200);
    expect((await mcpCall(fresh.accessToken, "tools/list")).status).toBe(401);
  });
});
