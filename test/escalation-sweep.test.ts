// Escalation sweep (S8 R4): a people manager whose role holds every key except `audit` cannot assign, invite as, or act on
// a role holding `audit`, nor any owner, on any people, key or agent route; each refusal is 403 role_above_you and writes
// nothing. The same actor reaching a Member works, so the refusals are not a blanket 403.
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMS } from "../src/roles";
import { dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signedIn } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = (sql: string) => env.DB.prepare(sql).all().then((r) => r.results);
type M = "GET" | "POST" | "PATCH" | "DELETE";

const e = env as unknown as Record<string, string | undefined>;
const prevMode = e.AUTH_MODE;
beforeAll(() => { e.AUTH_MODE = "app"; });
afterAll(() => { e.AUTH_MODE = prevMode; });

let cookie: string;
beforeEach(async () => {
  await env.DB.batch(["sessions", "login_tokens", "api_keys", "tool_calls", "agent_connections", "auth_limits", "audit_log", "domain_members", "links", "domains", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('esc','Almost',?,0,1,1), ('aud','Auditor','[\"audit\"]',0,1,1), ('weak','Keys','[\"keys\"]',0,1,1)",
    JSON.stringify(PERMS.filter((p) => p !== "audit")));
  cookie = (await signedIn("act@example.com", { roleId: "esc" })).cookie;
  for (const [id, role, roleId, status] of [["own", "owner", null, "active"], ["ta", "member", "aud", "active"], ["tm", "member", null, "active"],
    ["oi", "owner", null, "invited"], ["ti", "member", "aud", "invited"], ["mi", "member", null, "invited"]])
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,?,1)", id, `${id}@example.com`, role, roleId, status);
  for (const u of ["own", "ta", "tm"]) {
    await run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES (?,?,?,'email',1,1,4102444800)", `s_${u}`, `sh_${u}`, u);
    await run("INSERT INTO api_keys (id,user_id,name,prefix,hash,can_write,can_delete,domain_ids,expires_at,created_at) VALUES (?,?,'k','lw_x',?,1,1,'[]',4102444800,1)", `k_${u}`, u, `h_${u}`);
    await run("INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,can_write,can_delete,created_at) VALUES (?,?,'cl','Agent','agent.example',1,0,1)", `c_${u}`, u);
  }
});
afterEach(() => vi.restoreAllMocks());

const call = (m: M, path: string, body?: unknown) =>
  dash(path, { method: m, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const state = async () => ({
  users: await all("SELECT id, role, role_id, status FROM users ORDER BY id"),
  sessions: await all("SELECT id, user_id FROM sessions ORDER BY id"),
  keys: await all("SELECT id, revoked_at FROM api_keys ORDER BY id"),
  conns: await all("SELECT id, can_write, can_delete, revoked_at FROM agent_connections ORDER BY id"),
  audit: await all("SELECT action FROM audit_log WHERE action != 'auth.sign_in'"),
});

/** Every people, key and agent route aimed at someone above the actor (an owner, or a role holding audit). */
const ABOVE: [M, string, unknown?][] = [
  ...["own", "ta"].flatMap((t): [M, string, unknown?][] => [
    ["PATCH", `/api/users/${t}`, { status: "disabled" }], ["PATCH", `/api/users/${t}`, { roleId: "weak" }],
    ["DELETE", `/api/users/${t}`], ["DELETE", `/api/users/${t}/sessions`],
    ["DELETE", `/api/keys/k_${t}`],
    ["PATCH", `/api/agents/connections/c_${t}`, { write: false, del: false }], ["DELETE", `/api/agents/connections/c_${t}`],
    ["GET", `/api/agents/connections/c_${t}/calls`],
  ]),
  ...["oi", "ti"].flatMap((t): [M, string, unknown?][] => [
    ["POST", `/api/users/${t}/resend`, {}], ["DELETE", `/api/users/${t}/invite`], ["PATCH", `/api/users/${t}`, { roleId: "member" }],
  ]),
  // Assigning or inviting as a role above: Owner, or one holding audit.
  ["PATCH", "/api/users/tm", { roleId: "aud" }], ["PATCH", "/api/users/tm", { roleId: "owner" }], ["PATCH", "/api/users/mi", { roleId: "aud" }],
  ["POST", "/api/users/invite", { email: "new1@example.com", roleId: "aud" }], ["POST", "/api/users/invite", { email: "new2@example.com", roleId: "owner" }],
];

describe("escalation sweep: every key except audit, plus people.manage", () => {
  it("is refused role_above_you on every route aimed above it, and nothing is written", async () => {
    fakeResend();
    const before = await state();
    const bad: string[] = [];
    for (const [m, path, body] of ABOVE) {
      const r = await call(m, path, body);
      const b = await r.json().catch(() => null);
      if (r.status !== 403 || (b as { error?: string } | null)?.error !== "role_above_you") bad.push(`${m} ${path} ${JSON.stringify(body)}: ${r.status} ${JSON.stringify(b)}`);
    }
    expect(bad).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it("?all=1 key and connection lists leave out the owner's and the auditor's", async () => {
    const keys = (await (await call("GET", "/api/keys?all=1")).json()) as { items: { id: string }[] };
    expect(keys.items.map((k) => k.id)).toEqual(["k_tm"]);
    const conns = (await (await call("GET", "/api/agents/connections?all=1")).json()) as { items: { id: string }[] };
    expect(conns.items.map((c) => c.id)).toEqual(["c_tm"]);
  });

  it("control: the same actor reaches a Member on the same routes", async () => {
    fakeResend();
    for (const [m, path, body, want] of [
      ["PATCH", "/api/agents/connections/c_tm", { write: false, del: false }, 200], ["DELETE", "/api/agents/connections/c_tm", undefined, 204],
      ["DELETE", "/api/keys/k_tm", undefined, 204], ["DELETE", "/api/users/tm/sessions", undefined, 204],
      ["PATCH", "/api/users/tm", { roleId: "weak" }, 200], ["DELETE", "/api/users/mi/invite", undefined, 200],
      ["POST", "/api/users/invite", { email: "new3@example.com", roleId: "weak" }, 201],
    ] as [M, string, unknown, number][]) expect([m, path, (await call(m, path, body)).status]).toEqual([m, path, want]);
  });
});
