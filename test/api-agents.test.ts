import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { MEMBER_DEFAULT } from "../src/roles";
import { connectAgent, mcpCall, token } from "./helpers/oauth";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const as = async (email: string, path: string, init: RequestInit = {}) =>
  dash(path, { ...init, headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), ...(init.body ? { "content-type": "application/json" } : {}) } });
const patch = (email: string, id: string, body: unknown) => as(email, `/api/agents/connections/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const del = (email: string, id: string) => as(email, `/api/agents/connections/${id}`, { method: "DELETE" });
const list = async (email: string, q = "") => (await (await as(email, `/api/agents/connections${q}`)).json<{ items: Item[] }>()).items;
type Item = { id: string; userId: string; userEmail: string | null; clientName: string; redirectHost: string; write: boolean; del: boolean; createdAt: number; lastUsedAt: number | null; calls7d: number };

const A = "a@example.com", B = "b@example.com", O = "owner@example.com";
const now = () => Math.floor(Date.now() / 1000);
const audits = (action: string) => env.DB.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").bind(action).all<Record<string, unknown>>().then((r) => r.results);
const grantsOf = async (userId: string) => (await env.OAUTH_PROVIDER!.listUserGrants(userId)).items.map((g) => (g.metadata as { connId: string }).connId);

beforeAll(setupAccess);
beforeEach(async () => {
  // Grants from earlier tests would still be listed for the same user ids.
  for (const k of (await env.OAUTH_KV.list()).keys) await env.OAUTH_KV.delete(k.name);
  await env.DB.batch(["tool_calls", "auth_limits", "audit_log", "agent_connections", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", O, "owner"], ["ua", A, "member"], ["ub", B, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, email, role);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/agents/connections", () => {
  it("members see only their own (?all=1 too); the owner with ?all=1 sees everyone's with userEmail; no secrets", async () => {
    const a = await connectAgent(A);
    const b = await connectAgent(B, { write: true });
    const mine = await list(A);
    expect(mine.map((i) => i.id)).toEqual([a.connId]);
    expect(mine[0]).toMatchObject({ userId: "ua", userEmail: null, clientName: "Claude", redirectHost: "claude.ai", write: false, del: false, lastUsedAt: null, calls7d: 0 });
    expect((await list(A, "?all=1")).map((i) => i.id)).toEqual([a.connId]);
    expect(await list(O)).toEqual([]);
    const all = await list(O, "?all=1");
    expect(all.map((i) => [i.id, i.userEmail, i.write]).sort()).toEqual([[a.connId, A, false], [b.connId, B, true]].sort());
    const raw = JSON.stringify(all);
    for (const s of [a.accessToken, a.refreshToken, b.accessToken, a.clientId]) expect(raw).not.toContain(s);
  });

  it("calls7d counts only the last 7 days; lastUsedAt is the newest call; revoked connections are not listed", async () => {
    const a = await connectAgent(A);
    const t = now();
    for (const at of [t - 100, t - 200, t - 8 * 86400])
      await run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (?,'ua','Claude',?,'server_info','ok')", at, a.connId);
    expect((await list(A))[0]).toMatchObject({ calls7d: 2, lastUsedAt: t - 100 });
    await run("UPDATE agent_connections SET revoked_at = 1 WHERE id = ?", a.connId);
    expect(await list(A)).toEqual([]);
  });
});

describe("GET /api/agents/connections/:id/calls", () => {
  it("newest 20 only, no other columns; own or owner, otherwise the same 404 as an unknown id", async () => {
    const a = await connectAgent(A);
    const t = now();
    for (let i = 0; i < 25; i++)
      await run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (?,'ua','Claude',?,?,'ok')", t - i, a.connId, `t${i}`);
    const r = await (await as(A, `/api/agents/connections/${a.connId}/calls`)).json<{ items: Record<string, unknown>[] }>();
    expect(r.items).toHaveLength(20);
    expect(r.items[0]).toEqual({ at: t, tool: "t0", status: "ok" });
    expect(r.items.at(-1)).toEqual({ at: t - 19, tool: "t19", status: "ok" });
    expect((await as(O, `/api/agents/connections/${a.connId}/calls`)).status).toBe(200);
    for (const path of [`/api/agents/connections/${a.connId}/calls`, "/api/agents/connections/nope/calls"]) {
      const x = await as(B, path);
      expect([x.status, await x.json()]).toEqual([404, { error: "not_found" }]);
    }
  });
});

describe("PATCH /api/agents/connections/:id", () => {
  it("a member raises their own read to write: 200, audit agent.access; the same again writes no audit", async () => {
    const a = await connectAgent(A);
    const r = await patch(A, a.connId, { write: true, del: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: a.connId, write: true, del: false, calls7d: 0 });
    expect(await one("SELECT can_write, can_delete FROM agent_connections WHERE id = ?", a.connId)).toEqual({ can_write: 1, can_delete: 0 });
    const rows = await audits("agent.access");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "ua", via: null, target_type: "agent_connection", target_id: a.connId });
    expect(JSON.parse(rows[0]!.detail as string)).toEqual({ write: true, del: false, before: { write: false, del: false } });
    expect((await patch(A, a.connId, { write: true, del: false })).status).toBe(200);
    expect(await audits("agent.access")).toHaveLength(1);
  });

  it("validates the body: del needs write, strict shape", async () => {
    const a = await connectAgent(A);
    const r = await patch(A, a.connId, { write: false, del: true });
    expect([r.status, await r.json()]).toEqual([400, { error: "del_needs_write" }]);
    for (const bad of [{ write: true }, { write: "yes", del: false }, { write: true, del: false, extra: 1 }, null]) {
      const x = await patch(A, a.connId, bad);
      expect([bad, x.status]).toEqual([bad, 400]);
    }
  });

  it("the owner may lower someone else's connection but never raise it", async () => {
    const r = await connectAgent(A);
    const w = await connectAgent(B, { write: true, del: true });
    const up = await patch(O, r.connId, { write: true, del: false });
    expect([up.status, await up.json()]).toEqual([403, { error: "owner_cannot_raise" }]);
    const up2 = await patch(O, w.connId, { write: true, del: false });
    expect(up2.status).toBe(200); // lowering delete only
    const down = await patch(O, w.connId, { write: false, del: false });
    expect(down.status).toBe(200);
    expect(await down.json()).toMatchObject({ write: false, del: false, userEmail: B });
    expect(await one("SELECT can_write, can_delete FROM agent_connections WHERE id = ?", w.connId)).toEqual({ can_write: 0, can_delete: 0 });
    expect(await audits("agent.access")).toHaveLength(2);
    expect(await audits("agent.access").then((x) => x.map((a) => a.actor_id))).toEqual(["uo", "uo"]);
  });

  it("another member's, a revoked and an unknown connection all answer the same 404", async () => {
    const a = await connectAgent(A);
    const gone = await connectAgent(A, { write: true });
    await run("UPDATE agent_connections SET revoked_at = 1 WHERE id = ?", gone.connId);
    for (const [who, id] of [[B, a.connId], [A, gone.connId], [A, "nope"]] as const) {
      const x = await patch(who, id, { write: true, del: false });
      expect([x.status, await x.json()]).toEqual([404, { error: "not_found" }]);
    }
    expect(await one("SELECT can_write FROM agent_connections WHERE id = ?", a.connId)).toEqual({ can_write: 0 });
  });
});

describe("DELETE /api/agents/connections/:id", () => {
  it("revokes the D1 row and the library grant: the token is refused, audit agent.disconnect, then 404", async () => {
    const a = await connectAgent(A);
    expect((await mcpCall(a.accessToken, "tools/call", { name: "server_info", arguments: {} })).status).toBe(200);
    expect(await grantsOf("ua")).toEqual([a.connId]);
    expect((await del(A, a.connId)).status).toBe(204);
    expect((await mcpCall(a.accessToken, "tools/call", { name: "server_info", arguments: {} })).status).toBe(401);
    expect(await grantsOf("ua")).toEqual([]);
    expect((await one<{ revoked_at: number | null }>("SELECT revoked_at FROM agent_connections WHERE id = ?", a.connId))!.revoked_at).not.toBeNull();
    const rows = await audits("agent.disconnect");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "ua", via: null, target_type: "agent_connection", target_id: a.connId });
    expect(await list(A)).toEqual([]);
    expect((await del(A, a.connId)).status).toBe(404);
    expect(await audits("agent.disconnect")).toHaveLength(1);
  });

  it("only the matching grant goes; the owner may disconnect anyone's", async () => {
    const a1 = await connectAgent(A);
    const a2 = await connectAgent(A);
    expect((await del(O, a1.connId)).status).toBe(204);
    expect(await grantsOf("ua")).toEqual([a2.connId]);
    expect((await mcpCall(a2.accessToken, "tools/call", { name: "server_info", arguments: {} })).status).toBe(200);
  });

  it("another member's connection answers 404 and stays connected", async () => {
    const a = await connectAgent(A);
    const x = await del(B, a.connId);
    expect([x.status, await x.json()]).toEqual([404, { error: "not_found" }]);
    expect(await grantsOf("ua")).toEqual([a.connId]);
    expect((await one<{ revoked_at: number | null }>("SELECT revoked_at FROM agent_connections WHERE id = ?", a.connId))!.revoked_at).toBeNull();
  });

  it("a KV failure still answers 204 and the D1 check refuses the token (fails closed)", async () => {
    const a = await connectAgent(A);
    vi.spyOn(env.OAUTH_KV, "list").mockRejectedValue(new Error("KV list limit"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await del(A, a.connId)).status).toBe(204);
    expect(err).toHaveBeenCalled();
    for (const call of err.mock.calls) expect(JSON.stringify(call)).not.toContain(a.accessToken);
    vi.restoreAllMocks();
    const r = await mcpCall(a.accessToken, "tools/call", { name: "server_info", arguments: {} });
    expect(r.body.result.isError).toBe(true);
  });
});

describe("/api/users agentCount", () => {
  it("counts unrevoked connections: 1, then 0 after disconnect", async () => {
    const a = await connectAgent(A);
    const count = async () => (await (await as(O, "/api/users")).json<{ items: { id: string; agentCount: number }[] }>()).items.find((u) => u.id === "ua")!.agentCount;
    expect(await count()).toBe(1);
    expect((await del(A, a.connId)).status).toBe(204);
    expect(await count()).toBe(0);
  });
});

describe("final fix wave", () => {
  const refresh = (t: { clientId: string; refreshToken: string }) => token({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: t.clientId });

  it("the owner's lowering cannot raise what the person lowered in between (409, nothing written)", async () => {
    const w = await connectAgent(B, { write: true, del: true });
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
      await run("UPDATE agent_connections SET can_write = 0, can_delete = 0 WHERE id = ?", w.connId); // the person, concurrently
      return batch(stmts);
    });
    const r = await patch(O, w.connId, { write: true, del: false });
    expect([r.status, await r.json()]).toEqual([409, { error: "changed" }]);
    expect(await one("SELECT can_write, can_delete FROM agent_connections WHERE id = ?", w.connId)).toEqual({ can_write: 0, can_delete: 0 });
    expect(await audits("agent.access")).toHaveLength(0);
  });

  it("any change between the read and the write answers 409, even one the lowering would still allow (no stale before)", async () => {
    const w = await connectAgent(B, { write: true, del: true });
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
      await run("UPDATE agent_connections SET can_write = 1, can_delete = 0 WHERE id = ?", w.connId); // the person, concurrently
      return batch(stmts);
    });
    const r = await patch(O, w.connId, { write: false, del: false });
    expect([r.status, await r.json()]).toEqual([409, { error: "changed" }]);
    expect(await one("SELECT can_write, can_delete FROM agent_connections WHERE id = ?", w.connId)).toEqual({ can_write: 1, can_delete: 0 });
    expect(await audits("agent.access")).toHaveLength(0);
  });

  it("the owner cannot raise delete alone; the audit records before and after", async () => {
    const w = await connectAgent(B, { write: true });
    const r = await patch(O, w.connId, { write: true, del: true });
    expect([r.status, await r.json()]).toEqual([403, { error: "owner_cannot_raise" }]);
    expect((await patch(O, w.connId, { write: false, del: false })).status).toBe(200);
    const [a] = await audits("agent.access");
    expect(JSON.parse(a!.detail as string)).toEqual({ write: false, del: false, before: { write: true, del: false } });
  });

  it("a Bearer token or key never reaches /api/agents", async () => {
    const a = await connectAgent(A);
    for (const [m, p] of [["GET", "/api/agents/connections"], ["DELETE", `/api/agents/connections/${a.connId}`]]) {
      const r = await dash(p!, { method: m, headers: { authorization: `Bearer ${a.accessToken}` } });
      expect([m, r.status]).toEqual([m, 401]);
    }
    expect(await one("SELECT revoked_at FROM agent_connections WHERE id = ?", a.connId)).toEqual({ revoked_at: null });
  });

  it("a foreign Origin is refused on PATCH and DELETE and changes nothing", async () => {
    const a = await connectAgent(A);
    const h = { "Cf-Access-Jwt-Assertion": await tokenFor(A), "content-type": "application/json", origin: "https://evil.test" };
    const p = await dash(`/api/agents/connections/${a.connId}`, { method: "PATCH", headers: h, body: JSON.stringify({ write: true, del: false }) });
    const d = await dash(`/api/agents/connections/${a.connId}`, { method: "DELETE", headers: h });
    expect([p.status, d.status]).toEqual([403, 403]);
    expect(await one("SELECT can_write, revoked_at FROM agent_connections WHERE id = ?", a.connId)).toEqual({ can_write: 0, revoked_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('agent.access','agent.disconnect')").first("n")).toBe(0);
  });

  it("after a KV-failed disconnect: revoked_at and the audit land, and the refresh token is refused (grant then revoked)", async () => {
    const a = await connectAgent(A);
    const list = vi.spyOn(env.OAUTH_KV, "list").mockRejectedValue(new Error("KV list limit"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await del(A, a.connId)).status).toBe(204);
    list.mockRestore();
    expect((await one<{ revoked_at: number | null }>("SELECT revoked_at FROM agent_connections WHERE id = ?", a.connId))!.revoked_at).not.toBeNull();
    expect(await audits("agent.disconnect")).toHaveLength(1);
    expect(await grantsOf("ua")).toEqual([a.connId]); // the grant survived the KV failure
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await refresh(a);
    expect([r.status, (await r.json<{ error: string }>()).error]).toEqual([400, "invalid_grant"]);
    expect(await grantsOf("ua")).toEqual([]);
  });

  it("a disabled person's refresh is refused; a D1 failure refuses it as temporarily unavailable", async () => {
    const a = await connectAgent(A);
    const prep = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM agent_connections")) throw new Error("D1 down");
      return prep(sql);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = await refresh(a);
    expect([down.status, (await down.json<{ error: string }>()).error]).toEqual([503, "temporarily_unavailable"]);
    spy.mockRestore();
    expect(await grantsOf("ua")).toEqual([a.connId]); // a transient failure does not revoke
    await run("UPDATE users SET status = 'disabled' WHERE id = 'ua'");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await (await refresh(a)).json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("an active connection still refreshes", async () => {
    const a = await connectAgent(A);
    expect((await refresh(a)).status).toBe(200);
  });

  it("an owner demoted between the read and the write changes nothing: lowering, disconnect and the MCP switch answer 403", async () => {
    const w = await connectAgent(B, { write: true });
    const demoteFirstBatch = () => {
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, "batch").mockImplementationOnce(async (stmts) => {
        await run("UPDATE users SET role = 'member' WHERE id = 'uo'"); // another owner, concurrently
        return batch(stmts);
      });
    };
    const reset = () => run("UPDATE users SET role = 'owner' WHERE id = 'uo'");
    demoteFirstBatch();
    expect((await patch(O, w.connId, { write: false, del: false })).status).toBe(403);
    expect(await one("SELECT can_write FROM agent_connections WHERE id = ?", w.connId)).toEqual({ can_write: 1 });
    await reset();
    demoteFirstBatch();
    expect((await del(O, w.connId)).status).toBe(403);
    expect(await one("SELECT revoked_at FROM agent_connections WHERE id = ?", w.connId)).toEqual({ revoked_at: null });
    await reset();
    const before = await one("SELECT value FROM settings WHERE key = 'mcp.enabled'");
    const { on } = await (await as(O, "/api/agents/mcp")).json<{ on: boolean }>();
    demoteFirstBatch();
    expect((await as(O, "/api/agents/mcp", { method: "PUT", body: JSON.stringify({ on: !on }) })).status).toBe(403);
    expect(await one("SELECT value FROM settings WHERE key = 'mcp.enabled'")).toEqual(before);
    expect([...(await audits("agent.access")), ...(await audits("agent.disconnect")), ...(await audits("settings.update"))]).toHaveLength(0);
  });
});

describe("a people manager and other people's connections (S8 R4)", () => {
  const M = "manager@example.com";
  const open = async () => (await env.DB.prepare("SELECT id FROM agent_connections WHERE revoked_at IS NULL ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);
  beforeEach(async () => {
    await run("DELETE FROM roles WHERE builtin = 0");
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('mg','Manager',?,0,1,1), ('st','Settings','[\"settings\"]',0,1,1)", JSON.stringify([...MEMBER_DEFAULT, "people.manage"]));
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('um',?,'member','mg','active',1)", M);
  });

  it("?all=1 lists within; lower and disconnect within; raise refused; an owner's is 403 role_above_you", async () => {
    const a = await connectAgent(A, { write: true });
    const o = await connectAgent(O);
    expect((await list(M, "?all=1")).map((i) => [i.id, i.userEmail])).toEqual([[a.connId, A]]);
    for (const r of [await patch(M, o.connId, { write: false, del: false }), await del(M, o.connId)]) expect([r.status, await r.json()]).toEqual([403, { error: "role_above_you" }]);
    const up = await patch(M, a.connId, { write: true, del: true });
    expect([up.status, await up.json()]).toEqual([403, { error: "owner_cannot_raise" }]);
    expect((await patch(M, a.connId, { write: false, del: false })).status).toBe(200);
    expect((await del(M, a.connId)).status).toBe(204);
    expect(await open()).toEqual([o.connId]);
  });

  it("the person moves to a stronger role between read and batch: 403 and still connected", async () => {
    const a = await connectAgent(A);
    const restore = beforeBatch(1, () => run("UPDATE users SET role_id = 'st' WHERE id = 'ua'"));
    let r: Response;
    try { r = await del(M, a.connId); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "role_above_you" }]);
    expect(await open()).toEqual([a.connId]);
  });
});

// S8 R7: raising your own connection needs `agents`; lowering and disconnecting stay open (R3).
describe("raising a connection needs agents", () => {
  const role = (id: string, perms: readonly string[]) =>
    run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1) ON CONFLICT(id) DO UPDATE SET perms = excluded.perms", id, `Role ${id}`, JSON.stringify(perms));

  it("without agents: raise is 403 forbidden and writes nothing; lowering and disconnecting work", async () => {
    await role("rz", ["agents"]);
    await run("UPDATE users SET role_id = 'rz' WHERE id = 'ua'");
    const a = await connectAgent(A, { write: true });
    await role("rz", []);
    const r = await patch(A, a.connId, { write: true, del: true });
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await one("SELECT can_write, can_delete FROM agent_connections WHERE id = ?", a.connId)).toEqual({ can_write: 1, can_delete: 0 });
    expect((await patch(A, a.connId, { write: false, del: false })).status).toBe(200);
    expect((await del(A, a.connId)).status).toBe(204);
  });

  it("race: agents removed between the read and the raise writes nothing and answers 403", async () => {
    await role("ry", ["agents"]);
    await run("UPDATE users SET role_id = 'ry' WHERE id = 'ua'");
    const a = await connectAgent(A);
    const restore = beforeBatch(1, () => role("ry", []));
    let r: Response;
    try { r = await patch(A, a.connId, { write: true, del: false }); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await one("SELECT can_write FROM agent_connections WHERE id = ?", a.connId)).toEqual({ can_write: 0 });
    expect(await audits("agent.access")).toEqual([]);
  });
});
