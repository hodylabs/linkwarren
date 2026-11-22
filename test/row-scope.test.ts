// Every UPDATE and DELETE path must touch only its target row(s): the rows around it stay byte-identical.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const rows = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who] ?? who), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Snapshot of every table except the rows the call may legitimately change. */
const others = async (skip: { domain?: string; link?: string; lockDomain?: string; user?: string; members?: string } = {}) => ({
  domains: await rows("SELECT * FROM domains WHERE id != ? ORDER BY id", skip.domain ?? ""),
  links: await rows("SELECT * FROM links WHERE id != ? AND (? = '' OR domain_id != ?) ORDER BY id", skip.link ?? "", skip.domain ?? "", skip.domain ?? ""),
  locks: await rows("SELECT * FROM slug_locks WHERE domain_id != ? ORDER BY domain_id, slug_key", skip.lockDomain ?? ""),
  users: await rows("SELECT * FROM users WHERE id != ? ORDER BY id", skip.user ?? ""),
  members: await rows("SELECT * FROM domain_members WHERE domain_id != ? ORDER BY domain_id, user_id", skip.members ?? ""),
});

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "agent_connections", "sessions", "login_tokens", "links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, email, role);
  const dom = (id: string, host: string, type: string, owner: string, cs: number, noindex: number, bare: string | null, nf: string | null, reserved: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,noindex,bare_redirect,notfound_redirect,reserved_extra,created_at) VALUES (?,?,?,'active',?,?,?,?,?,?,1)",
      id, host, type, owner, cs, noindex, bare, nf, reserved);
  await dom("dA", "a.test", "private", "ua", 0, 1, null, null, "[]");
  await dom("dB", "b.test", "private", "ub", 1, 0, "https://b.example/bare", "https://b.example/nf", '["keep"]');
  await dom("dM", "m.test", "main", "uo", 0, 1, "https://m.example/", null, "[]");
  const ln = (id: string, d: string, slug: string, key: string, by: string) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", id, d, slug, key, by, by);
  await ln("la", "dA", "Same", "same", "ua");
  await ln("lb", "dB", "Same", "Same", "ub");
  await ln("lm", "dM", "same", "same", "uo");
  await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dA','gone',1,'ua'),('dB','gone',1,'ub'),('dM','gone',1,'uo')");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dA','ub'),('dB','ua')");
});

describe("rows outside the target stay identical", () => {
  it("domain PATCH (noindex, redirects, reservedExtra, case flips) by the domain's member owner", async () => {
    const before = await others({ domain: "dA" });
    const patches = [
      { noindex: false }, { bareRedirect: "https://a.example/bare", notfoundRedirect: "https://a.example/nf" },
      { reservedExtra: ["mine"] }, { caseSensitive: true }, { caseSensitive: false },
    ];
    for (const p of patches) expect([p, (await call("a", "PATCH", "/api/domains/dA", p)).status]).toEqual([p, 200]);
    expect(await others({ domain: "dA" })).toEqual(before);
    expect((await rows("SELECT noindex, bare_redirect, reserved_extra, case_sensitive FROM domains WHERE id='dA'"))[0])
      .toEqual({ noindex: 0, bare_redirect: "https://a.example/bare", reserved_extra: '["mine"]', case_sensitive: 0 });
  });
  it("domain approve and disable", async () => {
    const before = await others({ domain: "dA" });
    expect((await call("owner", "POST", "/api/domains/dA/disable")).status).toBe(200);
    expect((await call("owner", "POST", "/api/domains/dA/approve")).status).toBe(200);
    expect(await others({ domain: "dA" })).toEqual(before);
  });
  it("domain members replace", async () => {
    const before = await others({ members: "dA" });
    expect((await call("owner", "PUT", "/api/domains/dA/members", { userIds: [] })).status).toBe(200);
    expect(await others({ members: "dA" })).toEqual(before);
  });
  it("link PATCH and DELETE", async () => {
    const before = await others({ link: "la", lockDomain: "dA" });
    expect((await call("a", "PATCH", "/api/links/la", { url: "https://y.com/" })).status).toBe(200);
    expect((await call("a", "DELETE", "/api/links/la")).status).toBe(204);
    expect(await others({ link: "la", lockDomain: "dA" })).toEqual(before);
  });
  it("lock release", async () => {
    const before = await others({ lockDomain: "dA" });
    expect((await call("owner", "DELETE", "/api/locks/dA/gone")).status).toBe(204);
    expect(await others({ lockDomain: "dA" })).toEqual(before);
    expect(await rows("SELECT * FROM slug_locks WHERE domain_id='dA'")).toEqual([]);
  });
  it("import fills of null redirects", async () => {
    await run("UPDATE domains SET bare_redirect = NULL, notfound_redirect = NULL WHERE id = 'dB'");
    const before = await others({ domain: "dA" });
    const r = await call("owner", "POST", "/api/import", {
      mainHost: "m.test", links: [], domains: [{ host: "a.test", customIndexUrl: "https://a.example/i", customNotFoundUrl: "https://a.example/n" }],
    });
    expect(r.status).toBe(200);
    expect(await others({ domain: "dA" })).toEqual(before);
    expect((await rows("SELECT bare_redirect, notfound_redirect FROM domains WHERE id='dA'"))[0])
      .toEqual({ bare_redirect: "https://a.example/i", notfound_redirect: "https://a.example/n" });
  });
  it("user activation on first sign-in", async () => {
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ui','i@example.com','member','invited',1),('uj','j@example.com','member','invited',1)");
    const before = await others({ user: "ui" });
    expect((await call("i@example.com", "GET", "/api/me")).status).toBe(200);
    expect(await others({ user: "ui" })).toEqual(before);
  });
});

describe("sign-in tables: deletes and renames touch only the target", () => {
  it("passkey rename and remove, session end, sign-out-everywhere leave a second person's rows alone", async () => {
    const { signedIn, withCookie } = await import("./helpers/session");
    const mode = env as { AUTH_MODE?: string };
    const prev = mode.AUTH_MODE;
    mode.AUTH_MODE = "app";
    try {
      await env.DB.batch(["passkeys", "sessions", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      const a = await signedIn("sa@example.com"), b = await signedIn("sb@example.com");
      for (const [id, u] of [["pa", a.user.id], ["pb", b.user.id]] as const)
        await run("INSERT INTO passkeys (id,credential_id,user_id,public_key,counter,name,created_at) VALUES (?,?,?,'k',0,'n',1)", id, `c${id}`, u);
      const theirs = { passkeys: await rows("SELECT * FROM passkeys WHERE user_id = ?", b.user.id), sessions: await rows("SELECT * FROM sessions WHERE user_id = ?", b.user.id) };
      const go = (method: string, path: string, body?: unknown) => dash(path, withCookie(a.cookie, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }));
      expect((await go("PATCH", "/api/account/passkeys/pb", { name: "x" })).status).toBe(404);
      expect((await go("PATCH", "/api/account/passkeys/pa", { name: "x" })).status).toBe(200);
      expect((await go("DELETE", "/api/account/passkeys/pb")).status).toBe(404);
      expect((await go("DELETE", "/api/account/passkeys/pa")).status).toBe(204);
      expect((await go("DELETE", `/api/account/sessions/${(theirs.sessions[0] as { id: string }).id}`)).status).toBe(404);
      expect((await go("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
      expect({ passkeys: await rows("SELECT * FROM passkeys WHERE user_id = ?", b.user.id), sessions: await rows("SELECT * FROM sessions WHERE user_id = ?", b.user.id) }).toEqual(theirs);
    } finally {
      mode.AUTH_MODE = prev;
    }
  });
});

describe("owner end-all", () => {
  it("ends one person's sessions and leaves a third person's alone", async () => {
    const { signedIn, withCookie } = await import("./helpers/session");
    const mode = env as { AUTH_MODE?: string };
    const prev = mode.AUTH_MODE;
    mode.AUTH_MODE = "app";
    try {
      await env.DB.batch(["passkeys", "sessions", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      const o = await signedIn("so@example.com", { role: "owner" }), b = await signedIn("sb2@example.com"), c = await signedIn("sc@example.com");
      await run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES ('c2','hc2',?, 'email',1,1,9999999999)", c.user.id);
      const third = await rows("SELECT * FROM sessions WHERE user_id = ?", c.user.id);
      const mine = await rows("SELECT * FROM sessions WHERE user_id = ?", o.user.id);
      const r = await dash(`/api/users/${b.user.id}/sessions`, withCookie(o.cookie, { method: "DELETE" }));
      expect(r.status).toBe(204);
      expect(await rows("SELECT * FROM sessions WHERE user_id = ?", b.user.id)).toEqual([]);
      expect(await rows("SELECT * FROM sessions WHERE user_id = ?", c.user.id)).toEqual(third);
      expect(await rows("SELECT * FROM sessions WHERE user_id = ?", o.user.id)).toEqual(mine);
    } finally {
      mode.AUTH_MODE = prev;
    }
  });
});

describe("user admin: role, disable and remove touch only the person", () => {
  it("demote, disable and remove leave a second person's links, domains, grants, keys, connections, tokens and sessions alone", async () => {
    const { signedIn } = await import("./helpers/session");
    const mode = env as { AUTH_MODE?: string };
    const prev = mode.AUTH_MODE;
    mode.AUTH_MODE = "app";
    try {
      await env.DB.batch(["api_keys", "agent_connections", "login_tokens", "passkeys", "sessions", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      const o = await signedIn("so@example.com", { role: "owner" });
      const p = await signedIn("sp@example.com", { role: "owner" });
      const q = await signedIn("sq@example.com", { role: "owner" });
      for (const [u, d, host, type] of [[p.user.id, "pM", "pm.test", "shared"], [q.user.id, "qM", "qm.test", "shared"], [p.user.id, "pP", "pp.test", "private"], [q.user.id, "qP", "qp.test", "private"]])
        await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", d, host, type, u);
      for (const [l, d, u] of [["pl", "pP", p.user.id], ["ql", "qP", q.user.id]])
        await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", l, d, l, l, u, u);
      for (const [u, e, k] of [[p.user.id, "sp@example.com", "p"], [q.user.id, "sq@example.com", "q"]]) {
        await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dM',?)", u);
        await run("INSERT INTO api_keys (id,user_id,name,prefix,hash,expires_at,created_at) VALUES (?,?,'k','lw_x',?,9999999999,1)", `k${k}`, u, `h${k}`);
        await run("INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,created_at) VALUES (?,?,'c','C','claude.ai',1)", `c${k}`, u);
        await run("INSERT INTO login_tokens (token_hash,email,created_at,expires_at) VALUES (?,?,1,9999999999)", `t${k}`, e);
      }
      const qRows = async () => ({
        users: await rows("SELECT * FROM users WHERE id = ?", q.user.id),
        domains: await rows("SELECT * FROM domains WHERE owner_id = ? ORDER BY id", q.user.id),
        links: await rows("SELECT * FROM links WHERE created_by = ? ORDER BY id", q.user.id),
        members: await rows("SELECT * FROM domain_members WHERE user_id = ?", q.user.id),
        keys: await rows("SELECT * FROM api_keys WHERE user_id = ?", q.user.id),
        conns: await rows("SELECT * FROM agent_connections WHERE user_id = ?", q.user.id),
        tokens: await rows("SELECT * FROM login_tokens WHERE email = 'sq@example.com'"),
        sessions: await rows("SELECT * FROM sessions WHERE user_id = ?", q.user.id),
      });
      const before = await qRows();
      const go = (method: string, path: string, body?: unknown) =>
        dash(path, { method, headers: { cookie: o.cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      expect((await go("PATCH", `/api/users/${p.user.id}`, { roleId: "member" })).status).toBe(200);
      expect((await go("PATCH", `/api/users/${p.user.id}`, { status: "disabled" })).status).toBe(200);
      expect((await go("PATCH", `/api/users/${p.user.id}`, { status: "active" })).status).toBe(200);
      expect((await go("DELETE", `/api/users/${p.user.id}`)).status).toBe(200);
      expect(await qRows()).toEqual(before);
      expect(await rows("SELECT id FROM users WHERE id = ?", p.user.id)).toEqual([]);
    } finally {
      mode.AUTH_MODE = prev;
    }
  });
});

describe("S6 and S7 writes touch only their target (Task 11 sweep)", () => {
  const appMode = async <T>(fn: () => Promise<T>) => {
    const mode = env as { AUTH_MODE?: string };
    const prev = mode.AUTH_MODE;
    mode.AUTH_MODE = "app";
    try { return await fn(); } finally { mode.AUTH_MODE = prev; }
  };
  const go = (cookie: string, method: string, path: string, body?: unknown) =>
    dash(path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

  it("invite revoke leaves another invitee, their grants and their sign-in links alone", () => appMode(async () => {
    const { signedIn } = await import("./helpers/session");
    await env.DB.batch(["login_tokens", "sessions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const o = await signedIn("ro@example.com", { role: "owner" });
    for (const [id, e] of [["i1", "i1@example.com"], ["i2", "i2@example.com"]]) {
      await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,'member','invited',1)", id, e);
      await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dM',?)", id);
      await run("INSERT INTO login_tokens (token_hash,email,created_at,expires_at) VALUES (?,?,1,9999999999)", `t${id}`, e);
    }
    const i2 = async () => ({ u: await rows("SELECT * FROM users WHERE id = 'i2'"), m: await rows("SELECT * FROM domain_members WHERE user_id = 'i2'"), t: await rows("SELECT * FROM login_tokens WHERE email = 'i2@example.com'") });
    const before = { i2: await i2(), rest: await others({ user: "i1", members: "dM" }) };
    expect((await go(o.cookie, "DELETE", "/api/users/i1/invite")).status).toBe(200);
    expect({ i2: await i2(), rest: await others({ user: "i1", members: "dM" }) }).toEqual(before);
  }));

  it("settings PATCH, logo and secret removal leave the other settings rows alone", () => appMode(async () => {
    const { signedIn } = await import("./helpers/session");
    await run("DELETE FROM settings");
    await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('cf.controls','1',1,'x'),('mcp.enabled','1',1,'x'),('secret.CF_API_TOKEN','v1.a.b',1,'x'),('links.defaultPassQuery','true',1,'x')");
    const keep = () => rows("SELECT * FROM settings WHERE key IN ('cf.controls','mcp.enabled','secret.CF_API_TOKEN','links.defaultPassQuery') ORDER BY key");
    const before = await keep();
    const o = await signedIn("so2@example.com", { role: "owner" });
    expect((await go(o.cookie, "PATCH", "/api/settings", { name: "Acme" })).status).toBe(200);
    expect((await go(o.cookie, "DELETE", "/api/settings/secrets/resend")).status).toBe(200);
    expect((await go(o.cookie, "DELETE", "/api/settings/logo")).status).toBe(200);
    expect(await keep()).toEqual(before);
  }));

  it("API key revoke and agent connection change or revoke leave another person's rows alone", () => appMode(async () => {
    const { signedIn } = await import("./helpers/session");
    await env.DB.batch(["api_keys", "agent_connections", "sessions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const p = await signedIn("kp@example.com"), q = await signedIn("kq@example.com");
    for (const [u, k] of [[p.user.id, "p"], [q.user.id, "q"]]) {
      await run("INSERT INTO api_keys (id,user_id,name,prefix,hash,expires_at,created_at) VALUES (?,?,'k','lw_x',?,9999999999,1)", `k${k}`, u, `h${k}`);
      await run("INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,can_write,created_at) VALUES (?,?,'c','C','claude.ai',1,1)", `c${k}`, u);
    }
    const qRows = async () => ({ k: await rows("SELECT * FROM api_keys WHERE user_id = ?", q.user.id), c: await rows("SELECT * FROM agent_connections WHERE user_id = ?", q.user.id) });
    const before = await qRows();
    expect((await go(p.cookie, "DELETE", "/api/keys/kp")).status).toBeLessThan(300);
    expect((await go(p.cookie, "PATCH", "/api/agents/connections/cp", { write: false, del: false })).status).toBeLessThan(300);
    expect((await go(p.cookie, "DELETE", "/api/agents/connections/cp")).status).toBeLessThan(300);
    expect(await qRows()).toEqual(before);
    expect((await rows("SELECT revoked_at FROM api_keys WHERE id = 'kp'"))[0]!.revoked_at).not.toBeNull();
  }));
});
