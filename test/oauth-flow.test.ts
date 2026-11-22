import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupAccess } from "./helpers/access";
import { CLAUDE_CB, authorizePath, connectAgent, connectAgentFull, openConsent, pkce, registerClient, signInHeaders, token } from "./helpers/oauth";

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
