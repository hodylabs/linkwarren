// Authz sweep: one table of every dashboard /api route (src/app.ts and its sub-routers) with the permission it needs (S8),
// and the contracts of the machine API, sign-in, account, MCP and OAuth paths. Each row is checked with no session (401),
// cross-origin unsafe (403 forbidden_origin), with a text/plain body (415), and against every role: a route answers
// 403 forbidden exactly when the role holds none of the keys it needs.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { MEMBER_DEFAULT, PERMS, type Perm } from "../src/roles";
import { createSession, SESSION_COOKIE } from "../src/session";
import type { UserRow } from "../src/types";
import { ORIGIN, dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signedIn, withCookie } from "./helpers/session";
import { b64uText, softAuthenticator } from "./helpers/webauthn";

const e = env as unknown as Record<string, string | undefined>;
const prev = { mode: e.AUTH_MODE, mcp: e.MCP_ENABLED };
beforeAll(() => { e.AUTH_MODE = "app"; });
afterAll(() => { e.AUTH_MODE = prev.mode; e.MCP_ENABLED = prev.mcp; });
afterEach(() => { e.AUTH_MODE = "app"; e.MCP_ENABLED = prev.mcp; vi.restoreAllMocks(); });

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** null = baseline (R3); a list = any one of these keys suffices; "owner" = owners only, whatever the role holds. */
type Need = readonly Perm[] | "owner" | null;
/** A real shared domain owned by the owner, for the routes that look the domain up before the permission check (canManageDomain). */
const D = "sweep-d";
/** A main domain everyone can use, for the lock release row (an unusable or unknown domain answers forbidden on purpose). */
const MD = "sweep-m";
/** [method, path, need, body (default "{}")] */
const ROUTES: [M, string, Need, string?][] = [
  ["GET", "/api/me", null],
  ["GET", "/api/domains", null], ["POST", "/api/domains", ["domains.own", "domains.manage"]],
  ["PATCH", `/api/domains/${D}`, ["domains.manage"], JSON.stringify({ bareRedirect: null })], ["DELETE", "/api/domains/x", ["domains.manage"]],
  ["GET", `/api/domains/${D}/cloudflare`, ["domains.manage"]], ["PATCH", "/api/domains/x/cloudflare", ["domains.manage"]],
  ["POST", "/api/domains/x/approve", ["domains.manage"]], ["POST", "/api/domains/x/disable", ["domains.manage"]],
  ["PUT", "/api/domains/x/members", ["domains.manage"]],
  ["GET", "/api/links", null], ["POST", "/api/links", ["links.create"]], ["GET", "/api/links/by-slug", null], ["GET", "/api/links/check", null],
  ["GET", "/api/links/x", null], ["PATCH", "/api/links/x", null], ["DELETE", "/api/links/x", null], ["POST", "/api/links/bulk", ["links.bulk"]],
  ["DELETE", `/api/locks/${MD}/y`, ["links.editAny"]],
  ["POST", "/api/import", ["data"]],
  ["GET", "/api/users", ["people.manage", "domains.manage"]], ["PATCH", "/api/users/x", ["people.manage"]], ["DELETE", "/api/users/x", ["people.manage"]],
  ["DELETE", "/api/users/x/sessions", ["people.manage"]], ["POST", "/api/users/invite", ["people.manage"]],
  ["POST", "/api/users/x/resend", ["people.manage"]], ["DELETE", "/api/users/x/invite", ["people.manage"]],
  ["GET", "/api/roles", ["people.manage"]], ["POST", "/api/roles", "owner"], ["PATCH", "/api/roles/x", "owner"], ["DELETE", "/api/roles/x", "owner"],
  ["GET", "/api/audit", ["audit"]],
  ["GET", "/api/analytics", null], ["GET", "/api/analytics/links", null],
  ["GET", "/api/settings", ["settings"]], ["PATCH", "/api/settings", ["settings"]], ["PUT", "/api/settings/logo", ["settings"]], ["DELETE", "/api/settings/logo", ["settings"]],
  ["GET", "/api/settings/cloudflare", ["settings", "domains.manage"]], ["PATCH", "/api/settings/cloudflare", ["settings"]], ["POST", "/api/settings/cloudflare/check", "owner"],
  ["POST", "/api/settings/cloudflare/setup", ["settings"]], ["POST", "/api/settings/cloudflare/resync", ["settings"]],
  ["GET", "/api/settings/secrets", ["settings"]], ["PUT", "/api/settings/secrets/resend", "owner"], ["DELETE", "/api/settings/secrets/resend", "owner"],
  ["POST", "/api/settings/email/test", ["settings"]],
  ["GET", "/api/setup", "owner"], ["POST", "/api/setup/complete", "owner"],
  ["GET", "/api/instance", null], ["GET", "/api/instance/logo", null],
  ["GET", "/api/account", null], ["POST", "/api/account/passkeys/options", null], ["POST", "/api/account/passkeys", null],
  ["PATCH", "/api/account/passkeys/x", null], ["DELETE", "/api/account/passkeys/x", null], ["DELETE", "/api/account/sessions/x", null],
  ["POST", "/api/account/sign-out", null], ["POST", "/api/account/sign-out-everywhere", null],
  ["GET", "/api/keys", null], ["POST", "/api/keys", ["keys"]], ["DELETE", "/api/keys/x", null],
  ["GET", "/api/agents/connections", null], ["PATCH", "/api/agents/connections/x", null], ["DELETE", "/api/agents/connections/x", null],
  ["GET", "/api/agents/connections/x/calls", null], ["GET", "/api/agents/mcp", null], ["PUT", "/api/agents/mcp", ["settings"]],
  ["POST", "/api/export/start", ["data"]], ["POST", "/api/export/page", ["data"]],
];
/** Ruled rows the code does not match yet; each has its own it.fails below, so the suite turns red once the fix lands. */
const PENDING = new Set<string>(); // rows whose ruled behaviour is not built yet (none)
/** The rows that were owner only before roles (the pre-S8 sweep's ownerOnly column): Member must still be refused on each. */
const OLD_OWNER_ONLY = [
  "PATCH /api/domains/x/cloudflare", "POST /api/domains/x/approve", "POST /api/import", "GET /api/users", "PATCH /api/users/x", "DELETE /api/users/x",
  "DELETE /api/users/x/sessions", "POST /api/users/invite", "POST /api/users/x/resend", "DELETE /api/users/x/invite", "GET /api/audit",
  "GET /api/settings", "PATCH /api/settings", "PUT /api/settings/logo", "DELETE /api/settings/logo", "GET /api/settings/cloudflare",
  "PATCH /api/settings/cloudflare", "POST /api/settings/cloudflare/check", "POST /api/settings/cloudflare/setup", "POST /api/settings/cloudflare/resync",
  "GET /api/settings/secrets", "PUT /api/settings/secrets/resend", "DELETE /api/settings/secrets/resend", "POST /api/settings/email/test",
  "GET /api/setup", "POST /api/setup/complete", "PUT /api/agents/mcp", "POST /api/export/start", "POST /api/export/page",
];
/** The any-of lists: a sweep role lacking `p` also lacks the other members of every list holding `p`, or `p` would be covered. */
const ANY_OF = ROUTES.map(([, , n]) => n).filter((n): n is readonly Perm[] => Array.isArray(n) && n.length > 1);
const without = (p: Perm): Perm[] => {
  const gone = new Set<Perm>([p, ...ANY_OF.filter((l) => l.includes(p)).flat()]);
  return PERMS.filter((k) => !gone.has(k));
};
const refused = (need: Need, perms: readonly Perm[]) => need === "owner" || (need !== null && !need.some((k) => perms.includes(k)));

const unsafe = ROUTES.filter(([m]) => m !== "GET");
const req = (m: M, path: string, h: Record<string, string> = {}, body?: string) =>
  dash(path, { method: m, headers: h, body: m === "GET" ? undefined : body });
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();

let owner: string, member: string, memberUser: UserRow;
beforeEach(async () => {
  await env.DB.batch(["passkeys", "auth_challenges", "sessions", "login_tokens", "api_keys", "agent_connections", "auth_limits", "audit_log", "domain_members", "links", "domains", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  const o = await signedIn("owner@example.com", { role: "owner" });
  owner = o.cookie;
  const m = await signedIn("m@example.com");
  member = m.cookie; memberUser = m.user;
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,'sweep.test','shared','active',?,1), (?,'main.test','main','active',?,1)", D, o.user.id, MD, o.user.id);
});

/** A session cookie header for an existing person, minted directly (one batch, no sign-in flow). */
const sessionFor = async (user: UserRow) => {
  const { setCookie, stmts } = await createSession(env, new Request(`${ORIGIN}/auth/email/verify`), user, "email");
  await env.DB.batch(stmts);
  return `${SESSION_COOKIE}=${/^[^=]+=([^;]*)/.exec(setCookie)![1]!}`;
};
let n = 0;
/** A person on a new custom role holding `perms`. */
const onRole = async (perms: readonly Perm[]) => {
  const id = `sw${++n}`;
  await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, `Sweep ${id}`, JSON.stringify(perms));
  return (await signedIn(`${id}@example.com`, { roleId: id })).user;
};

/**
 * Every row (except PENDING) for one session source: 403 forbidden exactly when `refused`, never 401. Sign-out rows end
 * the session, so the rows after each get a fresh one from `login`.
 */
async function sweep(perms: readonly Perm[], login: () => Promise<string>) {
  fakeResend(); // the test email row must never reach the network
  const bad: string[] = [];
  let cookie = await login();
  for (const [m, path, need, body] of ROUTES) {
    if (PENDING.has(`${m} ${path}`)) continue;
    const r = await req(m, path, { cookie, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, body ?? "{}");
    if (path.includes("sign-out")) cookie = await login();
    const b = (await r.json().catch(() => null)) as { error?: string } | null;
    const no = r.status === 403 && b?.error === "forbidden", want = refused(need, perms);
    if (r.status === 401 || no !== want) bad.push(`${m} ${path}: ${r.status} ${JSON.stringify(b)} (want ${want ? "" : "not "}403 forbidden)`);
  }
  expect(bad).toEqual([]);
}

describe("permissions by role (S8)", () => {
  it.each(PERMS.map((p) => [p, without(p)] as const))("a role without %s is refused exactly the routes needing it", async (_p, perms) => {
    const u = await onRole(perms);
    await sweep(perms, () => sessionFor(u));
  });

  it("a role with all twelve keys is refused only the owner-only routes", async () => {
    const u = await onRole(PERMS);
    await sweep(PERMS, () => sessionFor(u));
  });

  it("built-in Member is refused exactly where its default keys fall short, which covers every route owner only before roles", async () => {
    const refusedRows = ROUTES.filter(([, , need]) => refused(need, MEMBER_DEFAULT)).map(([m, p]) => `${m} ${p}`);
    expect(refusedRows).toEqual(expect.arrayContaining(OLD_OWNER_ONLY));
    await sweep(MEMBER_DEFAULT, () => sessionFor(memberUser));
  });

  it("an owner is refused nothing", async () => {
    // The owner sweep runs as a "role" with every key and no owner-only refusal.
    const bad: string[] = [];
    fakeResend();
    for (const [m, path, , body] of ROUTES) {
      if (path.includes("sign-out")) continue; // would end the shared owner session; covered by the 401/415 rows
      const r = await req(m, path, { cookie: owner, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, body ?? "{}");
      const b = (await r.json().catch(() => null)) as { error?: string } | null;
      if (r.status === 401 || (r.status === 403 && b?.error === "forbidden")) bad.push(`${m} ${path}: ${r.status} ${JSON.stringify(b)}`);
    }
    expect(bad).toEqual([]);
  });

  it("passkey sign-in: a custom role's passkey session gets exactly that role's rights", async () => {
    const perms = without("settings");
    const u = await onRole(perms);
    const post = (path: string, body: unknown, c?: string) => dash(path, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9", ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body),
    });
    const dev = softAuthenticator();
    const setup = await sessionFor(u);
    const reg = await post("/api/account/passkeys/options", {}, setup);
    expect((await post("/api/account/passkeys", { response: await dev.register(await reg.json()) }, setup)).status).toBe(201);
    const login = async () => {
      const opts = await (await post("/auth/passkey/options", {})).json();
      const r = await post("/auth/passkey/verify", { response: await dev.authenticate(opts as never, { userHandle: b64uText(u.id) }) });
      expect(r.status).toBe(200);
      return /^([^;]*)/.exec(r.headers.get("set-cookie") ?? "")![1]!;
    };
    expect(await (await dash("/api/me", withCookie(await login()))).json()).toMatchObject({ roleId: u.roleId, perms });
    await sweep(perms, login);
  });

  it("PUT /api/agents/mcp: a non-owner role with settings is not refused", async () => {
    const u = await onRole(["settings"]);
    const r = await req("PUT", "/api/agents/mcp", { cookie: await sessionFor(u), "content-type": "application/json" }, JSON.stringify({ on: true }));
    expect(r.status).not.toBe(403);
  });
  it("PUT /api/agents/mcp: a role without settings is refused", async () => {
    const u = await onRole(without("settings"));
    const r = await req("PUT", "/api/agents/mcp", { cookie: await sessionFor(u), "content-type": "application/json" }, JSON.stringify({ on: true }));
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
  });

  it("bulk copy needs links.create as well as links.bulk", async () => {
    const copy = JSON.stringify({ action: "move", ids: ["x"], domainId: MD, oldAddress: "copy" });
    for (const perms of [without("links.create"), without("links.bulk")]) {
      const u = await onRole(perms);
      const r = await req("POST", "/api/links/bulk", { cookie: await sessionFor(u), "content-type": "application/json" }, copy);
      expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    }
    const u = await onRole(PERMS);
    const r = await req("POST", "/api/links/bulk", { cookie: await sessionFor(u), "content-type": "application/json" }, copy);
    expect(r.status).not.toBe(403);
  });
});

describe("dashboard /api routes", () => {
  it.each(ROUTES)("%s %s without a session is 401", async (m, path) => {
    const r = await req(m, path, m === "GET" ? {} : { "content-type": "application/json" }, "{}");
    expect(r.status).toBe(401);
  });

  it.each(ROUTES)("%s %s with only a valid owner Bearer key (no session) is 401", async (m, path) => {
    // A real, working key with every right: the dashboard must refuse it because it is a key, not because it is unknown.
    const k = await dash("/api/keys", withCookie(owner, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "k", write: true, del: true, domainIds: [], expiresInDays: 90 }) }));
    const secret = ((await k.json()) as { secret: string }).secret;
    expect((await worker.fetch(new Request(`${ORIGIN}/api/v1/domains`, { headers: { authorization: `Bearer ${secret}` } }), env, createExecutionContext())).status).toBe(200);
    const r = await req(m, path, { authorization: `Bearer ${secret}`, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, "{}");
    expect(r.status).toBe(401);
  });

  it.each(unsafe)("%s %s cross-origin is 403 forbidden_origin", async (m, path) => {
    const r = await req(m, path, { cookie: owner, origin: "https://evil.example", "content-type": "application/json" }, "{}");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/forbidden/);
  });

  it.each(unsafe)("%s %s with a text/plain body is 415", async (m, path) => {
    const r = await req(m, path, { cookie: owner, "content-type": "text/plain" }, "{}");
    expect([r.status, await r.json()]).toEqual([415, { error: "unsupported_media_type" }]);
  });

  it("an unknown /api path is a JSON 404 even when signed in", async () => {
    const r = await req("GET", "/api/nope", { cookie: owner });
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
  });
});

describe("/api/v1 (Bearer keys only)", () => {
  const v1 = (m: M, path: string, h: Record<string, string> = {}, body?: string) =>
    worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method: m, headers: h, body }), env, createExecutionContext());
  const key = async (write: boolean) => {
    const r = await dash("/api/keys", withCookie(member, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "k", write, del: false, domainIds: [], expiresInDays: 90 }) }));
    return ((await r.json()) as { secret: string }).secret;
  };
  /** [method, path, need on top of `keys`] */
  const V1: [M, string, Need][] = [["GET", "/links", null], ["POST", "/links", ["links.create"]], ["GET", "/links/x", null], ["PATCH", "/links/x", null],
    ["DELETE", "/links/x", null], ["POST", "/links/bulk", ["links.bulk"]], ["GET", "/domains", null], ["GET", "/analytics/links", null]];
  // S8 R7: a key follows its person's current role. Made while the role has every key, then the role loses one.
  it.each(PERMS)("a key whose person's role lost %s: keys_not_allowed everywhere for keys, else forbidden exactly where needed", async (p) => {
    const u = await onRole(PERMS);
    const k = await dash("/api/keys", withCookie(await sessionFor(u), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "k", write: true, del: true, domainIds: [], expiresInDays: 90 }) }));
    const secret = ((await k.json()) as { secret: string }).secret;
    const perms = PERMS.filter((x) => x !== p);
    await run("UPDATE roles SET perms = ? WHERE id = ?", JSON.stringify(perms), u.roleId);
    const bad: string[] = [];
    for (const [m, path, need] of V1) {
      const r = await v1(m, path, { authorization: `Bearer ${secret}`, ...(m === "GET" ? {} : { "content-type": "application/json" }) }, m === "GET" ? undefined : "{}");
      const b = (await r.json().catch(() => null)) as { error?: string } | null;
      const want = p === "keys" ? "keys_not_allowed" : refused(need, perms) ? "forbidden" : null;
      if (r.status === 401 || (want ? r.status !== 403 || b?.error !== want : r.status === 403)) bad.push(`${m} ${path}: ${r.status} ${JSON.stringify(b)} (want ${want ?? "not 403"})`);
    }
    expect(bad).toEqual([]);
  });
  it.each(V1)("%s /api/v1%s without a key is 401; a session cookie is not a key", async (m, path) => {
    expect((await v1(m, path)).status).toBe(401);
    expect((await v1(m, path, { cookie: member })).status).toBe(401);
  });
  it.each(V1.filter(([m]) => m === "POST" || m === "PATCH"))("%s /api/v1%s with a read key is 403 read_only", async (m, path) => {
    const r = await v1(m, path, { authorization: `Bearer ${await key(false)}`, "content-type": "application/json" }, "{}");
    expect([r.status, await r.json()]).toEqual([403, { error: "read_only" }]);
  });
  it("DELETE with a write key without delete is 403 delete_not_allowed", async () => {
    const r = await v1("DELETE", "/links/x", { authorization: `Bearer ${await key(true)}` });
    expect([r.status, await r.json()]).toEqual([403, { error: "delete_not_allowed" }]);
  });
  it.each([["GET", "/users"], ["GET", "/keys"], ["GET", "/audit"], ["POST", "/import"], ["GET", "/settings"], ["POST", "/export/start"]] as [M, string][])(
    "%s /api/v1%s is not on the machine API (404)", async (m, path) => {
      const r = await v1(m, path, { authorization: `Bearer ${await key(true)}`, "content-type": "application/json" }, m === "GET" ? undefined : "{}");
      expect(r.status).toBe(404);
    });
  it("a text/plain write with a key is 415", async () => {
    const r = await exports.default.fetch(`${ORIGIN}/api/v1/links`, { method: "POST", headers: { authorization: `Bearer ${await key(true)}`, "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  });
});

describe("/auth/* and /api/account/*", () => {
  const AUTH = ["/auth/email", "/auth/email/verify", "/auth/passkey/options", "/auth/passkey/verify"];
  it.each(AUTH)("POST %s: 404 in access mode, Origin required, 415 for text/plain", async (path) => {
    e.AUTH_MODE = "access";
    expect((await dash(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    e.AUTH_MODE = "app";
    const noOrigin = await exports.default.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([noOrigin.status, await noOrigin.json()]).toEqual([403, { error: "forbidden_origin" }]);
    const plain = await dash(path, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    expect((await dash(path, { method: "GET" })).status).toBe(404);
  });
  it("/api/account/* is 404 in access mode, before any auth check", async () => {
    e.AUTH_MODE = "access";
    expect((await dash("/api/account", { headers: { cookie: owner } })).status).toBe(404);
    expect((await dash("/api/account/sign-out", { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
});

describe("/mcp, /authorize, /token, /register", () => {
  const PATHS: [M, string][] = [["POST", "/mcp"], ["GET", "/authorize"], ["POST", "/authorize"], ["POST", "/token"], ["POST", "/register"]];
  it.each(PATHS)("%s %s is 404 when agent connections are off", async (m, path) => {
    e.MCP_ENABLED = "0";
    const r = await exports.default.fetch(`${ORIGIN}${path}`, { method: m, headers: { "content-type": "application/json", origin: ORIGIN }, body: m === "GET" ? undefined : "{}" });
    expect(r.status).toBe(404);
  });
  it("POST /mcp without a token is 401 when agent connections are on", async () => {
    e.MCP_ENABLED = "1";
    const r = await exports.default.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });
});
