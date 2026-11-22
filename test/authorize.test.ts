import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanClientName } from "../src/mcp/authorize";
import { setupAccess, tokenFor } from "./helpers/access";
import { CLAUDE_CB, authorizePath, connectAgentFull, openConsent, pkce, postConsent, registerClient, signInHeaders, token } from "./helpers/oauth";

const e = env as { AUTH_MODE?: string };
const orig = e.AUTH_MODE;
beforeAll(setupAccess);
afterEach(() => { e.AUTH_MODE = orig; vi.restoreAllMocks(); });

async function request(o: { redirect?: string; name?: string | null; auth?: string; method?: string | null; challenge?: boolean } = {}) {
  const redirect = o.redirect ?? CLAUDE_CB;
  const { clientId } = await registerClient(redirect, { name: o.name, auth: o.auth });
  const { challenge } = await pkce();
  const q = {
    response_type: "code", client_id: clientId, redirect_uri: redirect, state: "st-1",
    code_challenge: o.challenge === false ? undefined : challenge,
    code_challenge_method: o.method === null ? undefined : (o.method ?? "S256"),
  };
  return { clientId, path: authorizePath(q) };
}

/** A consent page ready to post, as `email`. */
async function ready(email: string, o: Parameters<typeof request>[0] = {}) {
  const { clientId, path } = await request(o);
  const auth = await signInHeaders(email);
  const page = await openConsent(path, auth);
  expect(page.res.status).toBe(200);
  return { clientId, auth, ...page };
}

describe("cleanClientName", () => {
  it("removes control and bidi characters, collapses whitespace, caps at 40 and falls back", () => {
    expect(cleanClientName("<img src=x>Claude‮")).toBe("<img src=x>Claude");
    expect(cleanClientName("  Claude \t\n Code\u0000 ")).toBe("Claude Code");
    expect(cleanClientName("x".repeat(200))).toBe("x".repeat(40));
    expect(cleanClientName("‏⁦ ")).toBe("Unnamed client");
    expect(cleanClientName(undefined)).toBe("Unnamed client");
    expect(cleanClientName(42)).toBe("Unnamed client");
  });
});

describe("GET /authorize, access mode", () => {
  it("answers 401 with the signed-out page without an Access token", async () => {
    const { path } = await request();
    const { res, html } = await openConsent(path, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("You are signed out. Reload the page to sign in.");
  });

  it("answers 403 with the invite copy for an address that is not invited", async () => {
    const { path } = await request();
    const { res, html } = await openConsent(path, { "Cf-Access-Jwt-Assertion": await tokenFor("stranger@example.com") });
    expect(res.status).toBe(403);
    expect(html).toContain("This email is not invited to this linkwarren. Ask the owner to invite you.");
  });

  it("renders the approval page with its headers, escaped name, redirect host and safe defaults", async () => {
    const { res, html } = await ready("acc1@example.com");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-"))).toBe(true);
    expect(html).toContain("Connect Claude");
    expect(html).toContain("Claude wants to use linkwarren as you. It will return to");
    expect(html).toMatch(/<b class="mono">claude\.ai<\/b>/);
    expect(html).toMatch(/<input[^>]*value="read"[^>]*checked/);
    expect(html).not.toMatch(/<input[^>]*name="del"[^>]*checked/);
    expect(html).toContain("Needs read and write. Deleted slugs stay locked.");
    expect(html).toContain("You can change or disconnect this any time in API &amp; agents.");
    expect(html).toMatch(/<button[^>]*autofocus[^>]*>Approve<\/button>/);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("local app");
  });

  it("warns for a loopback redirect", async () => {
    const { html, res } = await ready("acc2@example.com", { redirect: "http://localhost:53682/callback" });
    expect(html).toContain("This returns to an app on your own computer (local app).");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:53682;");
  });

  it("escapes a hostile client name on the page and stores it cleaned as via", async () => {
    const p = await ready("acc3@example.com", { name: "<img src=x>Claude‮" });
    expect(p.html).not.toContain("<img src=x>");
    expect(p.html).toContain("&lt;img src=x&gt;Claude");
    expect(p.html).not.toContain("‮");
    const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(302);
    const row = await env.DB.prepare("SELECT client_name FROM agent_connections WHERE client_id = ?").bind(p.clientId).first<{ client_name: string }>();
    expect(row!.client_name).toBe("<img src=x>Claude");
    const a = await env.DB.prepare("SELECT via FROM audit_log WHERE action = 'agent.connect' ORDER BY id DESC LIMIT 1").first<{ via: string }>();
    expect(a!.via).toBe("<img src=x>Claude");
  });

  it("cuts a 200-char client name to 40", async () => {
    const p = await ready("acc4@example.com", { name: "N".repeat(200) });
    await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    const row = await env.DB.prepare("SELECT client_name FROM agent_connections WHERE client_id = ?").bind(p.clientId).first<{ client_name: string }>();
    expect(row!.client_name).toBe("N".repeat(40));
  });

  it("refuses a confidential client without a code_challenge and the plain method", async () => {
    const auth = await signInHeaders("acc5@example.com");
    const none = await request({ auth: "client_secret_post", challenge: false, method: null });
    const r1 = await openConsent(none.path, auth);
    expect(r1.res.status).toBe(400);
    expect(r1.html).toContain("PKCE required");
    const plain = await request({ method: "plain" });
    expect((await openConsent(plain.path, auth)).res.status).toBe(400);
  });

  it("answers 400 for an unknown client and a malformed request", async () => {
    const auth = await signInHeaders("acc6@example.com");
    const { challenge } = await pkce();
    const r = await openConsent(authorizePath({ response_type: "code", client_id: "nope", redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256" }), auth);
    expect(r.res.status).toBe(400);
    expect((await openConsent("/authorize", auth)).res.status).toBe(400);
  });
});

describe("POST /authorize", () => {
  it("refuses a foreign Origin and a missing Origin with 403", async () => {
    const p = await ready("post1@example.com");
    const form = { handle: p.handle, uid: p.uid, action: "approve", access: "read" };
    expect((await postConsent(p.auth, p.binding, form, "https://evil.test")).status).toBe(403);
    expect((await postConsent(p.auth, p.binding, form, null)).status).toBe(403);
    // Neither refusal spent the handle.
    expect((await postConsent(p.auth, p.binding, form)).status).toBe(302);
  });

  it("refuses a handle without its binding cookie (another browser)", async () => {
    const p = await ready("post2@example.com");
    const r = await postConsent(p.auth, "", { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Approval expired, start again from your agent");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("n")).toBe(0);
  });

  it("refuses the POST without a valid sign-in", async () => {
    const p = await ready("post3@example.com");
    const r = await postConsent({}, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("n")).toBe(0);
  });

  it("is single-use", async () => {
    const p = await ready("post4@example.com");
    const form = { handle: p.handle, uid: p.uid, action: "approve", access: "read" };
    expect((await postConsent(p.auth, p.binding, form)).status).toBe(302);
    expect((await postConsent(p.auth, p.binding, form)).status).toBe(400);
  });

  it("Deny redirects with error=access_denied and stores nothing", async () => {
    const p = await ready("post5@example.com");
    const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "deny" });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(CLAUDE_CB);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("n")).toBe(0);
  });

  it("Approve read-only writes one read-only connection and one agent.connect audit row", async () => {
    const p = await ready("post6@example.com");
    const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.searchParams.get("code")).toBeTruthy();
    expect(to.searchParams.get("state")).toBe("st-1");
    const rows = await env.DB.prepare("SELECT * FROM agent_connections WHERE client_id = ?").bind(p.clientId).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    const c = rows.results[0]!;
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("post6@example.com").first<{ id: string }>();
    expect(c).toMatchObject({ user_id: user!.id, client_name: "Claude", redirect_host: "claude.ai", can_write: 0, can_delete: 0, revoked_at: null });
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'agent.connect' AND target_id = ?").bind(c.id).all<Record<string, unknown>>();
    expect(a.results).toHaveLength(1);
    expect(a.results[0]).toMatchObject({ actor_id: user!.id, via: "Claude" });
    expect(JSON.parse(a.results[0]!.detail as string)).toEqual({ clientId: p.clientId, redirectHost: "claude.ai", write: false, del: false });
  });

  it("del=1 without write stores can_delete = 0; write+del stores both", async () => {
    const p = await ready("post7@example.com");
    await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read", del: "1" });
    expect(await env.DB.prepare("SELECT can_delete FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("can_delete")).toBe(0);
    const q = await ready("post7@example.com");
    await postConsent(q.auth, q.binding, { handle: q.handle, uid: q.uid, action: "approve", access: "write", del: "1" });
    const row = await env.DB.prepare("SELECT can_write, can_delete FROM agent_connections WHERE client_id = ?").bind(q.clientId).first();
    expect(row).toEqual({ can_write: 1, can_delete: 1 });
  });
});

describe("/authorize, app mode", () => {
  it("sends a visitor without a session to sign-in with a safe next that round-trips the request", async () => {
    e.AUTH_MODE = "app";
    const { path } = await request();
    // A realistic Claude request: resource, scope and a long state.
    const full = `${path}&scope=offline_access&resource=${encodeURIComponent("https://dash.test/mcp")}&state2=${"s".repeat(300)}`;
    expect(full.length).toBeLessThan(2048);
    const { res } = await openConsent(full, {});
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, "https://dash.test");
    expect(loc.pathname).toBe("/sign-in");
    expect(loc.searchParams.get("next")).toBe(full);
  });

  it("shows the approval page with a session cookie, and refuses the POST after sign-out", async () => {
    e.AUTH_MODE = "app";
    const p = await ready("app1@example.com");
    expect(p.html).toContain("Connect Claude");
    expect(p.html).toContain("app1@example.com");
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind("app1@example.com").run();
    const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("n")).toBe(0);
  });
});

describe("fix round 1", () => {
  const count = (clientId: string) => env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(clientId).first("n");

  it("re-approving the same client revokes the older connection and its refresh token, not another person's", async () => {
    const first = await connectAgentFull("again@example.com");
    const other = await connectAgentFull("other@example.com", { clientId: first.clientId });
    const second = await connectAgentFull("again@example.com", { clientId: first.clientId });
    const rows = await env.DB.prepare("SELECT id, revoked_at FROM agent_connections WHERE client_id = ?").bind(first.clientId).all<{ id: string; revoked_at: number | null }>();
    const by = new Map(rows.results.map((r) => [r.id, r.revoked_at]));
    expect(by.get(first.connId)).not.toBeNull();
    expect(by.get(second.connId)).toBeNull();
    expect(by.get(other.connId)).toBeNull();
    const old = await token({ grant_type: "refresh_token", refresh_token: first.refreshToken, client_id: first.clientId });
    expect((await old.json<{ error: string }>()).error).toBe("invalid_grant");
    expect((await token({ grant_type: "refresh_token", refresh_token: second.refreshToken, client_id: first.clientId })).status).toBe(200);
  });

  it("refuses a POST whose page was shown to another person, without spending the handle", async () => {
    const p = await ready("uidA@example.com");
    const b = await signInHeaders("uidB@example.com");
    const r = await postConsent(b, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(400);
    expect(await count(p.clientId)).toBe(0);
    expect((await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" })).status).toBe(302);
  });

  it("a failed completeAuthorization leaves the row revoked and no unmarked connect audit", async () => {
    const p = await ready("fail@example.com");
    await env.OAUTH_KV.delete(`client:${p.clientId}`);
    const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).not.toContain("Error");
    const row = await env.DB.prepare("SELECT id, revoked_at FROM agent_connections WHERE client_id = ?").bind(p.clientId).first<{ id: string; revoked_at: number | null }>();
    expect(row!.revoked_at).not.toBeNull();
    const a = await env.DB.prepare("SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id").bind(row!.id).all<{ action: string; detail: string }>();
    expect(a.results.map((x) => x.action)).toEqual(["agent.connect", "agent.disconnect"]);
    expect(JSON.parse(a.results[1]!.detail)).toEqual({ reason: "failed" });
  });

  it("refuses a GET that is not a top-level document (cross-site img or fetch)", async () => {
    const { path } = await request();
    const auth = await signInHeaders("dest@example.com");
    for (const dest of ["image", "iframe", "empty"]) {
      const r = await openConsent(path, { ...auth, "sec-fetch-dest": dest });
      expect(r.res.status).toBe(403);
      expect(r.handle).toBe("");
    }
    expect((await openConsent(path, { ...auth, "sec-fetch-dest": "document" })).res.status).toBe(200);
  });

  it("shows Unnamed client for a client without a name", async () => {
    const p = await ready("noname@example.com", { name: null });
    expect(p.html).toContain("Connect Unnamed client");
    await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
    expect(await env.DB.prepare("SELECT client_name FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("client_name")).toBe("Unnamed client");
  });

  for (const mode of ["access", "app"]) {
    it(`a disabled person cannot approve (${mode} mode)`, async () => {
      e.AUTH_MODE = mode;
      const email = `disabled-${mode}@example.com`;
      const p = await ready(email);
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").bind(email).run();
      const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" });
      expect(r.status).toBe(403);
      expect(await count(p.clientId)).toBe(0);
      const g = await openConsent((await request()).path, p.auth);
      expect(g.res.status).toBe(403);
      expect(g.html).toContain("Your access has been turned off. Ask the owner.");
    });
  }

  it("a concurrent double POST leaves exactly one active connection", async () => {
    const p = await ready("double@example.com");
    const form = { handle: p.handle, uid: p.uid, action: "approve", access: "read" };
    const rs = await Promise.all([postConsent(p.auth, p.binding, form), postConsent(p.auth, p.binding, form)]);
    const codes = rs.map((r) => r.status).sort();
    expect(codes[0]).toBe(302);
    expect([302, 400]).toContain(codes[1]);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ? AND revoked_at IS NULL").bind(p.clientId).first("n")).toBe(1);
  });
});

describe("final fix wave", () => {
  const setMcp = (v: string) => ((env as { MCP_ENABLED?: string }).MCP_ENABLED = v);
  afterEach(() => setMcp("1"));

  it("serves consent only on the canonical /authorize path, and never while MCP is off", async () => {
    const p = await ready("encoded@example.com");
    const { path } = await request();
    const alt = path.replace("/authorize", "/%61uthorize");
    for (const mcp of ["0", "1"]) {
      setMcp(mcp);
      const g = await openConsent(alt, p.auth);
      expect([mcp, "GET", g.res.status, g.handle]).toEqual([mcp, "GET", 404, ""]);
      const r = await postConsent(p.auth, p.binding, { handle: p.handle, uid: p.uid, action: "approve", access: "read" }, undefined, "/%61uthorize");
      expect([mcp, "POST", r.status]).toEqual([mcp, "POST", 404]);
    }
    setMcp("0");
    expect((await openConsent(path, p.auth)).res.status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM agent_connections WHERE client_id = ?").bind(p.clientId).first("n")).toBe(0);
  });
});
