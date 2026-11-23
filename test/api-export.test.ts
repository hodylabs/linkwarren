import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_TABLES } from "../src/api/export";
import { hashKey } from "../src/keys";
import { hashPassword } from "../src/password";
import { encryptValue, putSecretStmts } from "../src/secrets";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { signedIn } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com" };
const e = env as unknown as Record<string, string | undefined>;
async function call(who: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return dash(path, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}
const start = (who = "owner", body: unknown = {}) => call(who, "/api/export/start", body);
let runId = "";
/** Starts a run as the owner and keeps its run id for page(). */
async function begin(includeAnalytics = false) {
  const r = await start("owner", { includeAnalytics });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { run: string; tables: { name: string }[] };
  runId = j.run;
  return j;
}
const page = (table: string, after: number | null, who = "owner", run = runId) => call(who, "/api/export/page", { run, table, after });

const PLAIN = "cfPLAINTEXT_token_123456";
const KEY_SECRET = "lw_secretKEYsecretKEYsecretKEYsecretKEYsecretK";
let keyHash = "", pwHash = "", cipher = "", qrCipher = "";
const WIFI = "wifiPLAINpass";

/** Counts D1 calls (each first/all/run/raw and each batch is one query), as test/binding-calls.test.ts does. */
const realDB = env.DB;
let d1 = 0;
function countD1() {
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => stmt(t.bind(...a));
        if (k === "first" || k === "all" || k === "run" || k === "raw") return (...a: unknown[]) => { d1++; return (t[k] as (...x: unknown[]) => unknown)(...a); };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    unwrap.set(p, s);
    return p;
  };
  (env as unknown as Record<string, unknown>).DB = new Proxy(realDB, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => stmt(t.prepare(sql));
      if (k === "batch") return (s: D1PreparedStatement[]) => { d1++; return t.batch(s.map((x) => unwrap.get(x) ?? x)); };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
const restoreDB = () => { (env as unknown as Record<string, unknown>).DB = realDB; };

// roles first: a restore needs them before users.role_id refers to them. Never deleted here: the built-in rows stay.
const BASE_TABLES = ["roles", "users", "domains", "domain_cf", "domain_members", "links", "vcards", "qr_codes", "slug_locks", "audit_log", "settings", "api_keys", "agent_connections", "tool_calls"];
const ALL_TABLES = ["roles", "users", "domains", "domain_cf", "domain_members", "links", "vcards", "qr_codes", "slug_locks", "audit_log", "settings", "clicks_daily", "clicks_daily_dim", "api_keys", "agent_connections", "tool_calls"];
const NEVER = ["sessions", "login_tokens", "passkeys", "auth_challenges", "auth_limits", "locks", "analytics_state"];

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch([...ALL_TABLES.filter((t) => t !== "roles"), ...NEVER].reverse().map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('d1','a.test','main','active','uo',1)");
  await run("INSERT INTO domain_cf (domain_id,kind,updated_at) VALUES ('d1','manual',1)");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('d1','ua')");
  pwHash = await hashPassword("hunter22", 10);
  const ins = "INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at,password_hash,routes,forward_to) VALUES (?,?,?,?,?,'uo','uo',1,1,?,?,?)";
  await run(ins, "l1", "d1", "open", "open", "https://example.com/", null, JSON.stringify([{ device: "ios", url: "https://example.com/ios" }]), null);
  await run(ins, "l2", "d1", "pw", "pw", "https://example.com/p", pwHash, "[]", null);
  await run(ins, "l3", "d1", "fw", "fw", "https://example.com/f", null, "[]", "l1");
  await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('d1','old',1,'uo')");
  await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('instance.name','\"Acme\"',1,'uo')");
  e.SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  await env.DB.batch(await putSecretStmts(env, "uo", "CF_API_TOKEN", PLAIN));
  cipher = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'secret.CF_API_TOKEN'").first<{ value: string }>())!.value;
  qrCipher = await encryptValue(env, "qr.q1", WIFI);
  await run("INSERT INTO qr_codes (id,name,kind,data,secret,style,created_by,updated_by,created_at,updated_at) VALUES ('q1','Office','wifi','{}',?,'{}','uo','uo',1,1)", qrCipher);
  await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed,bots,visitors) VALUES ('2026-01-01','l1','d1','open',1,2,0,3)");
  await run("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES ('2026-01-01','l1','d1','device','ios',3)");
  keyHash = await hashKey(KEY_SECRET);
  await run("INSERT INTO api_keys (id,user_id,name,prefix,hash,can_write,can_delete,domain_ids,expires_at,created_at) VALUES ('k1','uo','ci','lw_secr',?,1,0,'[]',9999999999,1)", keyHash);
  await run("INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,created_at) VALUES ('c1','uo','cl','Agent','agent.test',1)");
  await run("INSERT INTO tool_calls (at,user_id,via,conn_id,tool,status) VALUES (1,'uo','mcp','c1','list_links','ok')");
  // Rows that must never appear.
  await run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES ('s1','sessHASHabc','uo','email',1,1,9999999999)");
  await run("INSERT INTO login_tokens (token_hash,email,created_at,expires_at) VALUES ('loginHASHabc','owner@example.com',1,9999999999)");
  await run("INSERT INTO passkeys (id,credential_id,user_id,public_key,name,created_at) VALUES ('p1','credIDabc','uo','pubKEYabc','Laptop',1)");
  await run("INSERT INTO auth_challenges (challenge,purpose,expires_at) VALUES ('chalABC','login',9999999999)");
  await run("INSERT INTO auth_limits (key,window_start,count) VALUES ('limKEYabc',1,1)");
  await run("INSERT INTO locks (key,token,until) VALUES ('lockKEY','lockTOKENabc',1)");
  await run("INSERT INTO analytics_state (k,v) VALUES ('watermarkK','watermarkV')");
});
afterEach(() => {
  restoreDB();
  e.SECRETS_KEY = undefined;
});

/** Every page of `table`, plus the raw text of each response. */
async function pages(table: string) {
  const rows: Record<string, unknown>[] = [], raw: string[] = [];
  let after: number | null = null;
  for (let i = 0; i < 20; i++) {
    const r = await page(table, after);
    expect(r.status).toBe(200);
    const text = await r.text();
    raw.push(text);
    const j = JSON.parse(text) as { rows: Record<string, unknown>[]; next: number | null };
    rows.push(...j.rows);
    if (j.next === null) return { rows, raw, count: i + 1 };
    after = j.next;
  }
  throw new Error("no end");
}

describe("POST /api/export/start", () => {
  it("returns the format, the tables without analytics by default, row estimates and one export.run audit", async () => {
    const r = await start();
    expect(r.status).toBe(200);
    const j = (await r.json()) as { format: string; version: number; exportedAt: number; run: string; includeAnalytics: boolean; estimatedReads: number; tables: { name: string; columns: string[]; rows: number }[]; logo: unknown };
    expect(j.format).toBe("linkwarren-export");
    expect(j.version).toBe(1);
    expect(typeof j.exportedAt).toBe("number");
    expect(j.run).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.includeAnalytics).toBe(false);
    expect(j.logo).toBeNull();
    expect(j.tables.map((t) => t.name)).toEqual(BASE_TABLES);
    expect(j.tables.find((t) => t.name === "links")!.rows).toBe(3);
    expect(j.estimatedReads).toBe(j.tables.reduce((n, t) => n + t.rows, 0));
    // Estimates come from MAX(rowid): never a scan, so no table reads its rows to count them.
    expect(j.estimatedReads).toBeGreaterThan(0);
    expect(j.tables.find((t) => t.name === "links")!.columns).toContain("protected");
    expect(j.tables.find((t) => t.name === "links")!.columns).not.toContain("password_hash");
    expect(j.tables.find((t) => t.name === "api_keys")!.columns).not.toContain("hash");
    const audit = (await env.DB.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'export.run'").all()).results;
    expect(audit).toEqual([{ actor_id: "uo", detail: JSON.stringify({ tables: BASE_TABLES, includeAnalytics: false, estimatedReads: j.estimatedReads }) }]);
  });
  it("includeAnalytics adds the rollup tables; a bad body is 400 and audits nothing", async () => {
    const j = await begin(true);
    expect(j.tables.map((t: { name: string }) => t.name)).toEqual(ALL_TABLES);
    for (const body of [{ includeAnalytics: "yes" }, { x: 1 }]) expect((await start("owner", body)).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'export.run'").first<{ n: number }>())!.n).toBe(1);
  });
  it("includes the logo from KV when one is set", async () => {
    await env.CACHE.put("instance:logo", new Uint8Array([137, 80, 78, 71]), { metadata: { type: "image/png", v: 3 } });
    try {
      const j = (await (await start()).json()) as { logo: unknown };
      expect(j.logo).toEqual({ type: "image/png", data: btoa(String.fromCharCode(137, 80, 78, 71)) });
    } finally {
      await env.CACHE.delete("instance:logo");
    }
  });
  it("member 403, cross-origin 403, Bearer key 401, and none of them audits", async () => {
    expect([(await start("a")).status, await (await start("a")).json()]).toEqual([403, { error: "forbidden" }]);
    const x = await call("owner", "/api/export/start", {}, { origin: "https://evil.test" });
    expect([x.status, await x.json()]).toEqual([403, { error: "forbidden_origin" }]);
    const b = await dash("/api/export/start", { method: "POST", headers: { authorization: `Bearer ${KEY_SECRET}`, "content-type": "application/json" }, body: "{}" });
    expect(b.status).toBe(401);
    const v = await exports.default.fetch("https://dash.test/api/v1/export/start", { method: "POST", headers: { authorization: `Bearer ${KEY_SECRET}` } });
    expect(v.status).not.toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'export.run'").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("POST /api/export/page", () => {
  it("returns every seeded row of every table, with no secrets, hashes or session data anywhere", async () => {
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,kind,created_by,updated_by,created_at,updated_at) VALUES ('l4','d1','card','card','https://vcard.invalid/','vcard','uo','uo',1,1)");
    await run("INSERT INTO vcards (link_id,data,photo) VALUES ('l4','{\"firstName\":\"Ada\"}',NULL)");
    await begin(true);
    const out: Record<string, Record<string, unknown>[]> = {};
    let text = "";
    for (const t of ALL_TABLES) {
      const p = await pages(t);
      out[t] = p.rows;
      text += p.raw.join("\n");
    }
    for (const t of ALL_TABLES) expect([t, out[t]!.length > 0]).toEqual([t, true]);
    expect(out.links!.map((l) => [l.id, l.protected, l.kind])).toEqual([["l1", false, "url"], ["l2", true, "url"], ["l3", false, "url"], ["l4", false, "vcard"]]);
    expect(out.vcards).toEqual([{ link_id: "l4", data: '{"firstName":"Ada"}', photo: null }]);
    expect(out.links!.find((l) => l.id === "l3")!.forward_to).toBe("l1");
    expect(JSON.parse(out.links![0]!.routes as string)).toEqual([{ device: "ios", url: "https://example.com/ios" }]);
    for (const l of out.links!) expect(Object.keys(l)).not.toContain("password_hash");
    expect(Object.keys(out.api_keys![0]!).sort()).toEqual(["can_delete", "can_write", "created_at", "domain_ids", "expires_at", "id", "last_used_at", "name", "prefix", "revoked_at", "user_id"]);
    expect(out.settings!.map((s) => s.key)).toEqual(["instance.name"]);
    for (const rows of Object.values(out)) for (const r of rows) expect(Object.keys(r)).not.toContain("_r");
    expect(out.qr_codes!.map((q) => [q.id, q.hasPassword, "secret" in q])).toEqual([["q1", true, false]]);
    for (const bad of ['"hash"', "password_hash", "pbkdf2", pwHash, keyHash, KEY_SECRET, PLAIN, cipher, WIFI, qrCipher, '"v1.', "secret.CF_API_TOKEN\",\"value",
      "sessHASHabc", "loginHASHabc", "credIDabc", "pubKEYabc", "chalABC", "limKEYabc", "lockTOKENabc", "watermarkV"])
      expect([bad, text.includes(bad)]).toEqual([bad, false]);
  });
  it("1,201 audit rows come back in 3 pages of at most 500, in id order, each page within 10 D1 queries", async () => {
    await env.DB.prepare("DELETE FROM audit_log").run();
    await begin();
    await env.DB.prepare("DELETE FROM audit_log").run();
    await run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1201) INSERT INTO audit_log (at,actor_id,action,target_type,target_id) SELECT i,'uo','x','t',CAST(i AS TEXT) FROM n");
    const ids: number[] = [];
    let after: number | null = null, n = 0;
    do {
      d1 = 0;
      countD1();
      const r = await page("audit_log", after);
      const j = (await r.json()) as { rows: { id: number }[]; next: number | null };
      restoreDB();
      expect(d1).toBeLessThanOrEqual(10);
      expect(j.rows.length).toBeLessThanOrEqual(500);
      ids.push(...j.rows.map((x) => x.id));
      after = j.next;
      n++;
    } while (after !== null);
    expect(n).toBe(3);
    expect(ids.length).toBe(1201);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
  it("unknown or never-exported table 400, extra keys 400, bad after 400", async () => {
    await begin();
    for (const body of [{ table: "sessions", after: null }, { table: "nope", after: null }, { table: "users" }, { table: "users", after: 1.5 }, { table: "users", after: null, x: 1 }, { table: "users; DROP TABLE users", after: null }].map((b) => ({ run: runId, ...b }))) {
      const r = await call("owner", "/api/export/page", body);
      expect([body, r.status]).toEqual([body, 400]);
    }
  });
  it("re-checks the owner on every page: member 403, cross-origin 403", async () => {
    await begin();
    const m = await page("users", null, "a");
    expect([m.status, await m.json()]).toEqual([403, { error: "forbidden" }]);
    const x = await call("owner", "/api/export/page", { run: runId, table: "users", after: null }, { origin: "https://evil.test" });
    expect([x.status, await x.json()]).toEqual([403, { error: "forbidden_origin" }]);
    await run("UPDATE users SET role = 'member' WHERE id = 'uo'");
    expect((await page("users", null)).status).toBe(403);
  });
  it("a page needs a live run of this owner, and analytics tables only when the run included them", async () => {
    const gone = await page("users", null, "owner", crypto.randomUUID());
    expect([gone.status, await gone.json()]).toEqual([409, { error: "export_expired" }]);
    await begin(false);
    const no = await page("clicks_daily", null);
    expect([no.status, await no.json()]).toEqual([409, { error: "analytics_not_included" }]);
    expect((await page("users", null)).status).toBe(200);
    // Another owner cannot reuse this run id.
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('ub','b@example.com','owner','active',1)");
    EMAIL.b = "b@example.com";
    expect((await page("users", null, "b")).status).toBe(409);
    await run("UPDATE locks SET until = 1 WHERE key LIKE 'export:%'");
    expect((await page("users", null)).status).toBe(409);
    await begin(true);
    expect((await page("clicks_daily", null)).status).toBe(200);
  });
  it("caps a page near 1 MB of JSON and continues by keyset", async () => {
    await begin();
    const long = `https://example.com/${"a".repeat(2000)}`;
    await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
      INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) SELECT 'b'||i,'d1','b'||i,'b'||i,?,'uo','uo',1,1 FROM n`, long);
    const first = await page("links", null);
    const text = await first.text();
    const j = JSON.parse(text) as { rows: unknown[]; next: number | null };
    expect(j.rows.length).toBeLessThan(500);
    expect(text.length).toBeLessThan(1_100_000);
    expect(j.next).not.toBeNull();
    const p = await pages("links");
    expect(p.rows.length).toBe(603);
    expect(new Set(p.rows.map((r) => r.id)).size).toBe(603);
  });
  it("app mode: a page stays within 10 D1 queries with a session cookie", async () => {
    const mode = e.AUTH_MODE;
    e.AUTH_MODE = "app";
    try {
      const { cookie } = await signedIn("owner2@example.com", { role: "owner" });
      const post = (path: string, body: unknown) => dash(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const s = (await (await post("/api/export/start", {})).json()) as { run: string };
      d1 = 0;
      countD1();
      const r = await post("/api/export/page", { run: s.run, table: "audit_log", after: null });
      await r.arrayBuffer();
      restoreDB();
      expect(r.status).toBe(200);
      expect(d1).toBeLessThanOrEqual(10);
    } finally {
      e.AUTH_MODE = mode;
    }
  });
  it("EXPORT_TABLES names only real columns and never a secret column", () => {
    for (const t of EXPORT_TABLES) {
      expect(NEVER).not.toContain(t.table);
      expect(t.columns).not.toContain("hash");
      expect(t.columns).not.toContain("password_hash");
    }
  });
});

// S8 R12: `data` exports the whole instance, roles included, so a restore keeps custom roles.
describe("export by permission (S8 R12)", () => {
  beforeEach(async () => {
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('dt','Data','[\"data\"]',0,1,1)");
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('ud','d@example.com','member','dt','active',1)");
    EMAIL.d = "d@example.com";
  });
  it("a data role exports every table but the audit log, roles and role_id included, and the run is audited as them", async () => {
    const s = await start("d");
    expect(s.status).toBe(200);
    const j = (await s.json()) as { run: string; tables: { name: string; columns: string[] }[] };
    expect(j.tables.map((t) => t.name)).toEqual(BASE_TABLES.filter((t) => t !== "audit_log"));
    const a = await page("audit_log", null, "d", j.run);
    expect([a.status, await a.json()]).toEqual([403, { error: "forbidden" }]);
    expect(j.tables.find((t) => t.name === "users")!.columns).toContain("role_id");
    const rows = async (table: string) => ((await (await page(table, null, "d", j.run)).json()) as { rows: Record<string, unknown>[] }).rows;
    expect((await rows("users")).find((u) => u.id === "ud")).toMatchObject({ role: "member", role_id: "dt" });
    expect((await rows("roles")).map((r) => [r.id, r.perms])).toEqual(expect.arrayContaining([["dt", '["data"]'], ["member", expect.any(String)], ["owner", "[]"]]));
    expect((await env.DB.prepare("SELECT actor_id FROM audit_log WHERE action = 'export.run'").all()).results).toEqual([{ actor_id: "ud" }]);
  });
  it("a role with data and audit exports the audit log too", async () => {
    await run("UPDATE roles SET perms = '[\"data\",\"audit\"]' WHERE id = 'dt'");
    const j = (await (await start("d")).json()) as { run: string; tables: { name: string }[] };
    expect(j.tables.map((t) => t.name)).toEqual(BASE_TABLES);
    const a = await page("audit_log", null, "d", j.run);
    expect(a.status).toBe(200);
    expect(((await a.json()) as { rows: { action: string }[] }).rows.map((r) => r.action)).toContain("export.run");
  });
  it("data lost: the next page is 403; lost just before the start batch, no run and no audit", async () => {
    const s = (await (await start("d")).json()) as { run: string };
    await run("UPDATE roles SET perms = '[]' WHERE id = 'dt'");
    const p = await page("users", null, "d", s.run);
    expect([p.status, await p.json()]).toEqual([403, { error: "forbidden" }]);
    await run("UPDATE roles SET perms = '[\"data\"]' WHERE id = 'dt'");
    await run("DELETE FROM locks WHERE key LIKE 'export:%'");
    await run("DELETE FROM audit_log");
    const restore = beforeBatch(2, () => run("UPDATE roles SET perms = '[]' WHERE id = 'dt'"));
    let r: Response;
    try { r = await start("d"); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM locks WHERE key LIKE 'export:%'").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log").first<{ n: number }>())!.n).toBe(0);
  });
});
