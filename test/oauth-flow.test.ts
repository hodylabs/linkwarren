import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupAccess } from "./helpers/access";
import { ROLE_REFUSED } from "../src/mcp/run";
import { CLAUDE_CB, authorizePath, connectAgent, connectAgentFull, mcpCall, openConsent, pkce, postConsent, registerClient, signInHeaders, token } from "./helpers/oauth";

beforeAll(setupAccess);
afterEach(() => vi.restoreAllMocks());

const refresh = (clientId: string, refresh_token: string) => token({ grant_type: "refresh_token", refresh_token, client_id: clientId });

describe("full OAuth flow", () => {
  for (const redirect of [CLAUDE_CB, "http://localhost:53682/callback", "http://127.0.0.1:41000/callback", "http://127.0.0.1:1455/callback/AbC123_-xyz0", "http://localhost:7777/oauth/callback", "https://vertexaisearch.cloud.google.com/oauth-redirect"]) {
    it(`connects with redirect ${redirect}`, async () => {
      const t = await connectAgent("flow@example.com", { redirect });
      expect(t.accessToken).toBeTruthy();
      expect(t.refreshToken).toBeTruthy();
      expect(t.connId).toMatch(/^[0-9a-f-]{36}$/);
    });
  }

  it("issues a 24 h access token", async () => {
    expect((await connectAgentFull("ttl@example.com")).expiresIn).toBe(86400);
  });

  it("refuses a redirect the client did not register", async () => {
    const { clientId } = await registerClient(CLAUDE_CB);
    const { challenge } = await pkce();
    const auth = await signInHeaders("redir@example.com");
    const r = await openConsent(authorizePath({
      response_type: "code", client_id: clientId, redirect_uri: "http://localhost:9999/callback", state: "s", code_challenge: challenge, code_challenge_method: "S256",
    }), auth);
    expect(r.res.status).toBe(400);
    expect(r.res.headers.get("location")).toBeNull();
  });

  it("fails the second exchange of one code", async () => {
    const t = await connectAgentFull("code2@example.com");
    const again = await token(t.exchange);
    expect(again.status).toBe(400);
    expect((await again.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("rotates refresh tokens; an old token replayed after the new one is used is refused without revoking the grant", async () => {
    const t = await connectAgentFull("refresh@example.com");
    const r1 = await refresh(t.clientId, t.refreshToken);
    expect(r1.status).toBe(200);
    const n1 = await r1.json<{ refresh_token: string; access_token: string }>();
    expect(n1.refresh_token).toBeTruthy();
    expect(n1.refresh_token).not.toBe(t.refreshToken);
    const r2 = await refresh(t.clientId, n1.refresh_token);
    expect(r2.status).toBe(200);
    const n2 = await r2.json<{ refresh_token: string }>();
    const replay = await refresh(t.clientId, t.refreshToken);
    expect(replay.status).toBe(400);
    expect((await replay.json<{ error: string }>()).error).toBe("invalid_grant");
    // B5: the library does not revoke the family on replay; the current token still works.
    expect((await refresh(t.clientId, n2.refresh_token)).status).toBe(200);
  });

  it("does not accept a JSON body at /token; the form body works", async () => {
    const t = await connectAgentFull("json@example.com");
    const r = await exports.default.fetch("https://dash.test/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: t.clientId }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await refresh(t.clientId, t.refreshToken)).status).toBe(200);
  });
});

// S8 R7 (controller ruling): /token has no role gate. Without `agents` tokens keep refreshing, but every tool call is refused
// in resolve (no tool_calls row) and the grant is kept; turning it back on restores the connection.
describe("agents follow the role: /token is not gated, tool calls are", () => {
  const role = (id: string, perms: readonly string[]) =>
    env.DB.prepare("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1) ON CONFLICT(id) DO UPDATE SET perms = excluded.perms")
      .bind(id, `Role ${id}`, JSON.stringify(perms)).run();
  const grants = async (email: string) => {
    const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    return (await env.OAUTH_PROVIDER!.listUserGrants(u!.id)).items.length;
  };
  const callsOf = async (connId: string) => (await env.DB.prepare("SELECT COUNT(*) n FROM tool_calls WHERE conn_id = ?").bind(connId).first<{ n: number }>())!.n;
  const refusedCall = async (accessToken: string, connId: string) => {
    const ctx = createExecutionContext();
    const r = await mcpCall(accessToken, "tools/call", { name: "server_info", arguments: {} }, ctx);
    expect([r.status, r.body.result.isError, r.body.result.content[0].text]).toEqual([200, true, ROLE_REFUSED]);
    await waitOnExecutionContext(ctx); // a tool_calls row would be written with waitUntil
    expect(await callsOf(connId)).toBe(0);
  };

  it("refresh with agents off: 200, the new token's tool call is refused, the grant kept; on again it works", async () => {
    const email = "role-refresh@example.com";
    await role("rf", ["agents"]);
    const t = await connectAgentFull(email, { roleId: "rf" });
    expect(await env.DB.prepare("SELECT role_id FROM users WHERE email = ?").bind(email).first()).toEqual({ role_id: "rf" });
    await role("rf", []);
    const r = await refresh(t.clientId, t.refreshToken);
    expect(r.status).toBe(200);
    const n = await r.json<{ access_token: string }>();
    await refusedCall(n.access_token, t.connId);
    expect(await grants(email)).toBe(1);
    await role("rf", ["agents"]);
    const ctx = createExecutionContext();
    const ok = await mcpCall(n.access_token, "tools/call", { name: "server_info", arguments: {} }, ctx);
    expect(ok.body.result.isError).toBeFalsy();
    await waitOnExecutionContext(ctx);
    expect(await callsOf(t.connId)).toBe(1); // the same wait does see a waitUntil row, so refusedCall's 0 is real
  });

  it("code exchange with agents removed after approval: 200, and the token's tool call is refused", async () => {
    const email = "role-code@example.com";
    await role("rc", ["agents"]);
    const { clientId } = await registerClient(CLAUDE_CB);
    const { verifier, challenge } = await pkce();
    const auth = await signInHeaders(email, "rc");
    const page = await openConsent(authorizePath({
      response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, state: "s", code_challenge: challenge, code_challenge_method: "S256",
    }), auth);
    const done = await postConsent(auth, page.binding, { handle: page.handle, uid: page.uid, action: "approve", access: "read" });
    expect(done.status).toBe(302);
    const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
    await role("rc", []);
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CB, client_id: clientId, code_verifier: verifier });
    expect(r.status).toBe(200);
    const conn = await env.DB.prepare("SELECT id FROM agent_connections WHERE client_id = ?").bind(clientId).first<{ id: string }>();
    await refusedCall((await r.json<{ access_token: string }>()).access_token, conn!.id);
    expect(await grants(email)).toBe(1);
  });

  it("initialize and tools/list with agents off answer and write nothing", async () => {
    const email = "role-list@example.com";
    await role("rl", ["agents"]);
    const t = await connectAgentFull(email, { roleId: "rl" });
    await role("rl", []);
    const before = await env.DB.prepare("SELECT COUNT(*) n FROM auth_limits").first("n");
    const ctx = createExecutionContext();
    const init = await mcpCall(t.accessToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, ctx);
    expect(init.body.result.serverInfo.name).toBe("linkwarren");
    expect((await mcpCall(t.accessToken, "tools/list", undefined, ctx)).body.result.tools.length).toBeGreaterThan(0);
    await waitOnExecutionContext(ctx);
    expect(await callsOf(t.connId)).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM auth_limits").first("n")).toBe(before);
  });

  it("a revoked connection is still invalid_grant (and its grant revoked)", async () => {
    const email = "role-revoked@example.com";
    const t = await connectAgentFull(email);
    await env.DB.prepare("UPDATE agent_connections SET revoked_at = 1 WHERE id = ?").bind(t.connId).run();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await refresh(t.clientId, t.refreshToken);
    expect([r.status, (await r.json<{ error: string }>()).error]).toEqual([400, "invalid_grant"]);
    expect(await grants(email)).toBe(0);
  });
});
