import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { getLink } from "../src/cache";
import { verifyPassword } from "../src/password";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const all = async <T>(sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all<T>()).results;
const count = async (sql: string, ...a: unknown[]) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${sql}`, ...a))!.n;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
const bulk = async (who: string, body: unknown, headers: Record<string, string> = {}) =>
  dash("/api/links/bulk", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
type Result = { id: string; ok: boolean; error?: string; link?: Record<string, unknown> };
const answer = async (r: Response) => {
  expect(r.status).toBe(200);
  return (await r.json()) as { results: Result[]; pending: string[] };
};
const byId = (res: Result[]) => Object.fromEntries(res.map((r) => [r.id, r.ok ? "ok" : r.error]));

/** Inserts a link directly (no hashing); `o` overrides columns. */
const seed = (id: string, createdBy: string, o: Record<string, unknown> = {}) => {
  const row = { domain_id: "dm", slug: id, url: "https://x.com/a", redirect_code: 302, starts_at: null, expires_at: null, pass_query: 1, password_hash: null, ...o };
  return run(
    `INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,password_hash,routes,created_by,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'[]',?,?,1,10)`,
    id, row.domain_id, row.slug, String(row.slug).toLowerCase(), row.url, row.redirect_code, row.starts_at, row.expires_at, row.pass_query, row.password_hash, createdBy, createdBy,
  );
};

/** Swaps env.DB for a proxy that sums meta.rows_read over every batch the Worker runs. */
function meter() {
  const real = env.DB;
  const m = { rows: 0, restore: () => { (env as { DB: D1Database }).DB = real; } };
  (env as { DB: D1Database }).DB = new Proxy(real, {
    get(t, p) {
      if (p === "batch") return async (s: D1PreparedStatement[]) => {
        const res = await t.batch(s);
        for (const x of res) m.rows += x.meta.rows_read ?? 0;
        return res;
      };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return m;
}

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "auth_limits", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  const dom = (id: string, host: string, type: string, owner: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dm", "go.test", "main", "uo");
  await dom("da", "a.test", "private", "ua");
  await dom("db", "b.test", "private", "ub");
  for (const id of ["o1", "o2", "o3"]) await seed(id, "uo");
  await seed("pw", "uo", { password_hash: "pbkdf2-sha256$10000$c2FsdA$aGFzaA" });
  await seed("p301", "uo", { redirect_code: 301 });
});

describe("delete", () => {
  it("3 own links: 3 ok, 3 locks, 3 link.delete audits with via NULL, links gone", async () => {
    const r = await answer(await bulk("owner", { action: "delete", ids: ["o1", "o2", "o3"] }));
    expect(r).toEqual({ results: [{ id: "o1", ok: true }, { id: "o2", ok: true }, { id: "o3", ok: true }], pending: [] });
    expect(await count("slug_locks WHERE domain_id = 'dm' AND slug_key IN ('o1','o2','o3')")).toBe(3);
    const a = await all<{ target_id: string; via: string | null; detail: string }>("SELECT target_id, via, detail FROM audit_log WHERE action = 'link.delete' ORDER BY target_id");
    expect(a.map((x) => [x.target_id, x.via])).toEqual([["o1", null], ["o2", null], ["o3", null]]);
    expect(JSON.parse(a[0]!.detail)).toEqual({ host: "go.test", slug: "o1", url: "https://x.com/a" });
    expect(await count("links WHERE id IN ('o1','o2','o3')")).toBe(0);
  });

  it("a link edited between read and batch answers conflict (stricter than single delete)", async () => {
    const restore = beforeBatch(3, () => run("UPDATE links SET updated_at = 99 WHERE id = 'o2'"));
    let r;
    try { r = await answer(await bulk("owner", { action: "delete", ids: ["o1", "o2", "o3"] })); } finally { restore(); }
    expect(byId(r.results)).toEqual({ o1: "ok", o2: "conflict", o3: "ok" });
    expect(await one("SELECT 1 FROM links WHERE id = 'o2'")).not.toBeNull();
    expect(await count("slug_locks WHERE slug_key = 'o2'")).toBe(0);
    expect(await count("audit_log WHERE target_id = 'o2'")).toBe(0);
    expect(await count("audit_log WHERE action = 'link.delete'")).toBe(2);
  });
});

describe("schedule", () => {
  it("endNow sets expires_at to server now on all", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await answer(await bulk("owner", { action: "schedule", ids: ["o1", "o2"], endNow: true }));
    expect(byId(r.results)).toEqual({ o1: "ok", o2: "ok" });
    for (const x of await all<{ expires_at: number }>("SELECT expires_at FROM links WHERE id IN ('o1','o2')"))
      expect(Math.abs(x.expires_at - now)).toBeLessThanOrEqual(2);
    expect(r.results[0]!.link).toMatchObject({ id: "o1", expiresAt: expect.any(Number) });
    const d = JSON.parse((await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'link.update' AND target_id = 'o1'"))!.detail);
    expect(d).toEqual({ host: "go.test", slug: "o1", url: "https://x.com/a", bulk: "schedule" });
  });

  it("endNow on a link that starts later: that one bad_window, the others ok", async () => {
    await run("UPDATE links SET starts_at = ? WHERE id = 'o2'", Math.floor(Date.now() / 1000) + 3600);
    const r = await answer(await bulk("owner", { action: "schedule", ids: ["o1", "o2", "o3"], endNow: true }));
    expect(byId(r.results)).toEqual({ o1: "ok", o2: "bad_window", o3: "ok" });
    expect(await one("SELECT expires_at FROM links WHERE id = 'o2'")).toEqual({ expires_at: null });
    expect(await count("audit_log WHERE target_id = 'o2'")).toBe(0);
  });

  it("startsAt null clears; a number sets", async () => {
    await run("UPDATE links SET starts_at = 50 WHERE id IN ('o1','o2')");
    await answer(await bulk("owner", { action: "schedule", ids: ["o1", "o2"], startsAt: null }));
    expect(await count("links WHERE id IN ('o1','o2') AND starts_at IS NULL")).toBe(2);
    await answer(await bulk("owner", { action: "schedule", ids: ["o1"], startsAt: 70, expiresAt: 90 }));
    expect(await one("SELECT starts_at, expires_at FROM links WHERE id = 'o1'")).toEqual({ starts_at: 70, expires_at: 90 });
  });

  it("invalid bodies: no field, endNow with expiresAt, unknown key", async () => {
    for (const b of [
      { action: "schedule", ids: ["o1"] }, { action: "schedule", ids: ["o1"], endNow: true, expiresAt: 5 },
      { action: "schedule", ids: ["o1"], endNow: true, evil: 1 },
      { action: "nuke", ids: ["o1"] }, { action: "delete", ids: [] }, { action: "delete", ids: ["bad id"] },
    ]) {
      const r = await bulk("owner", b);
      expect([r.status, await r.json()]).toEqual([400, { error: "invalid_body" }]);
    }
    expect(await count("audit_log")).toBe(0);
  });
});

describe("redirect", () => {
  it("301 on a password link answers password_301 for it only", async () => {
    const r = await answer(await bulk("owner", { action: "redirect", ids: ["o1", "pw"], redirectCode: 301 }));
    expect(byId(r.results)).toEqual({ o1: "ok", pw: "password_301" });
    expect(await one("SELECT redirect_code FROM links WHERE id = 'pw'")).toEqual({ redirect_code: 302 });
    expect(await one("SELECT redirect_code FROM links WHERE id = 'o1'")).toEqual({ redirect_code: 301 });
  });

  it("passQuery false on all", async () => {
    const r = await answer(await bulk("owner", { action: "redirect", ids: ["o1", "o2", "pw", "p301"], passQuery: false }));
    expect(r.results.every((x) => x.ok && x.link?.passQuery === false)).toBe(true);
    expect(await count("links WHERE pass_query = 0")).toBe(4);
  });

  it("needs at least one field", async () => {
    expect((await bulk("owner", { action: "redirect", ids: ["o1"] })).status).toBe(400);
  });
});

describe("password", () => {
  it("null on 50 links: 50 ok, none pending, protection cleared only where one was set", async () => {
    for (let i = 0; i < 45; i++) await seed(`n${i}`, "uo");
    const ids = ["o1", "o2", "o3", "pw", "p301", ...Array.from({ length: 45 }, (_, i) => `n${i}`)];
    const r = await answer(await bulk("owner", { action: "password", ids, password: null }));
    expect(r.results.filter((x) => x.ok)).toHaveLength(50);
    expect(r.pending).toEqual([]);
    expect(await count("audit_log WHERE action = 'link.update'")).toBe(50);
    const cleared = await all<{ target_id: string }>("SELECT target_id FROM audit_log WHERE json_extract(detail,'$.protection') = 'cleared'");
    expect(cleared.map((x) => x.target_id)).toEqual(["pw"]);
    expect(await count("links WHERE password_hash IS NOT NULL")).toBe(0);
  });

  it("a string sets one per request, the rest pending; resending finishes them with own salts, never leaked", async () => {
    const pw = "long-enough-1";
    const bodies: string[] = [];
    const send = async (ids: string[]) => {
      const res = await bulk("owner", { action: "password", ids, password: pw });
      const text = await res.text();
      bodies.push(text);
      expect(res.status).toBe(200);
      return JSON.parse(text) as { results: Result[]; pending: string[] };
    };
    const r1 = await send(["o1", "o2", "o3"]);
    expect(r1.results).toHaveLength(1);
    expect(r1.results[0]).toMatchObject({ id: "o1", ok: true, link: { hasPassword: true } });
    expect(r1.pending).toEqual(["o2", "o3"]);
    const r2 = await send(r1.pending);
    expect(r2.pending).toEqual(["o3"]);
    const r3 = await send(r2.pending);
    expect([r3.results.map((x) => x.ok), r3.pending]).toEqual([[true], []]);
    const hashes = (await all<{ password_hash: string }>("SELECT password_hash FROM links WHERE id IN ('o1','o2','o3')")).map((x) => x.password_hash);
    expect(new Set(hashes).size).toBe(3);
    for (const h of hashes) expect(await verifyPassword(pw, h)).toBe(true);
    const audit = (await all<{ detail: string }>("SELECT detail FROM audit_log")).map((x) => x.detail).join("\n");
    expect(audit).toContain('"protection":"set"');
    for (const text of [...bodies, audit]) {
      expect(text).not.toContain(pw);
      for (const h of hashes) expect(text).not.toContain(h);
    }
  });

  it("301 link refused with password_301 and does not block the hash slot", async () => {
    const r = await answer(await bulk("owner", { action: "password", ids: ["p301", "o1"], password: "long-enough-1" }));
    expect(byId(r.results)).toEqual({ p301: "password_301", o1: "ok" });
    expect(r.pending).toEqual([]);
  });

  it("short and long passwords are whole-request errors and write nothing", async () => {
    let r = await bulk("owner", { action: "password", ids: ["o1"], password: "short" });
    expect([r.status, await r.json()]).toEqual([400, { error: "password_short" }]);
    r = await bulk("owner", { action: "password", ids: ["o1"], password: "x".repeat(1025) });
    expect([r.status, await r.json()]).toEqual([400, { error: "password_long" }]);
    r = await bulk("owner", { action: "password", ids: ["o1"], password: "x".repeat(200) });
    expect([r.status, await r.json()]).toEqual([400, { error: "password_long" }]);
    expect(await count("audit_log")).toBe(0);
    expect(await count("links WHERE password_hash IS NOT NULL")).toBe(1);
  });
});

describe("ids", () => {
  it("51 distinct ids: too_many; 75 ids that dedupe to 50: accepted, deduped in request order", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `x${i}`);
    const r = await bulk("owner", { action: "delete", ids: many });
    expect([r.status, await r.json()]).toEqual([400, { error: "too_many" }]);
    const ids = [...many.slice(0, 50), ...many.slice(0, 25)];
    const ok = await answer(await bulk("owner", { action: "delete", ids }));
    expect(ok.results.map((x) => x.id)).toEqual(many.slice(0, 50));
    expect(ok.results.every((x) => x.error === "not_found")).toBe(true);
  });
});

describe("partial failure and permissions (Review Focus 1, 2)", () => {
  it("a revision change between read and batch: that link conflict, the others written with their audit rows", async () => {
    const restore = beforeBatch(3, () => run("UPDATE links SET updated_at = 99 WHERE id = 'o2'"));
    let r;
    try { r = await answer(await bulk("owner", { action: "redirect", ids: ["o1", "o2", "o3"], passQuery: false })); } finally { restore(); }
    expect(byId(r.results)).toEqual({ o1: "ok", o2: "conflict", o3: "ok" });
    expect(r.results.find((x) => x.id === "o2")!.link).toBeUndefined();
    expect(await one("SELECT pass_query FROM links WHERE id = 'o2'")).toEqual({ pass_query: 1 });
    expect(await count("links WHERE pass_query = 0")).toBe(2);
    expect((await all<{ target_id: string }>("SELECT target_id FROM audit_log ORDER BY target_id")).map((x) => x.target_id)).toEqual(["o1", "o3"]);
  });

  it("member A: own main link ok, B's main link, B's private link forbidden, unknown not_found; refused writes no audit, no KV delete", async () => {
    await seed("am", "ua");
    await seed("bm", "ub");
    await seed("bp", "ub", { domain_id: "db" });
    await getLink(env, "dm", "bm");
    await getLink(env, "dm", "am");
    expect(await env.CACHE.get("l2:dm:bm")).not.toBeNull();
    const r = await answer(await bulk("a", { action: "schedule", ids: ["am", "bm", "bp", "nope"], endNow: true }));
    expect(byId(r.results)).toEqual({ am: "ok", bm: "forbidden", bp: "forbidden", nope: "not_found" });
    expect((await all<{ target_id: string; actor_id: string }>("SELECT target_id, actor_id FROM audit_log"))).toEqual([{ target_id: "am", actor_id: "ua" }]);
    expect(await env.CACHE.get("l2:dm:bm")).not.toBeNull();
    expect(await env.CACHE.get("l2:dm:am")).toBeNull();
    expect(await count("links WHERE expires_at IS NOT NULL")).toBe(1);
  });

  it("delete purges the cached key of every deleted link", async () => {
    await getLink(env, "dm", "o1");
    expect(await env.CACHE.get("l2:dm:o1")).not.toBeNull();
    await answer(await bulk("owner", { action: "delete", ids: ["o1"] }));
    expect(await env.CACHE.get("l2:dm:o1")).toBeNull();
  });
});

describe("budget and guards", () => {
  it("bulk:kv at 499 and a 2-link request: 429 kv_budget, nothing written", async () => {
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('bulk:kv', ?, 499)", Math.floor(Date.now() / 1000));
    const r = await bulk("owner", { action: "delete", ids: ["o1", "o2"] });
    expect([r.status, await r.json()]).toEqual([429, { error: "kv_budget" }]);
    expect(await count("links WHERE id IN ('o1','o2')")).toBe(2);
    expect(await count("audit_log")).toBe(0);
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 499 });
    // One link still fits and is charged.
    await answer(await bulk("owner", { action: "delete", ids: ["o1"] }));
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 500 });
  });

  it("refused links are not charged", async () => {
    await answer(await bulk("owner", { action: "redirect", ids: ["o1", "pw", "nope"], redirectCode: 301 }));
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 1 });
  });

  it("Origin from another site is 403, text/plain is 415", async () => {
    let r = await bulk("owner", { action: "delete", ids: ["o1"] }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    r = await bulk("owner", JSON.stringify({ action: "delete", ids: ["o1"] }), { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    expect(await count("links WHERE id = 'o1'")).toBe(1);
  });

  it("rows read stay under 10 x N + 200 for a 50-link schedule and a 50-link delete (1000 links, 1000 locks)", async () => {
    const seq = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)";
    await run(`${seq} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,created_by,updated_by,created_at,updated_at)
      SELECT 'm' || i, 'dm', 'm' || i, 'm' || i, 'https://x.com/', 302, 1, '[]', 'uo', 'uo', 1, 10 FROM n`);
    await run(`${seq} INSERT INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT 'dm', 'k' || i, 1, 'uo' FROM n`);
    // Also as a non-owner whose right on these links is links.editAny: the role guards must not add per-link reads.
    await run(`INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('ea','Editors','["links.create","links.bulk","links.editAny"]',0,1,1)
      ON CONFLICT(id) DO UPDATE SET perms = excluded.perms`);
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('uea','ea@example.com','member','ea','active',1)");
    EMAIL.ea = "ea@example.com";
    for (const [who, action, extra, from] of [["owner", "schedule", { endNow: true }, 0], ["owner", "delete", {}, 500],
      ["ea", "schedule", { endNow: true }, 50], ["ea", "delete", {}, 600]] as const) {
      const ids = Array.from({ length: 50 }, (_, i) => `m${from + i}`);
      const m = meter();
      let r;
      try { r = await answer(await bulk(who, { action, ids, ...extra })); } finally { m.restore(); }
      expect(r.results.every((x) => x.ok)).toBe(true);
      console.log(`bulk ${action} x50 as ${who}: rows_read ${m.rows}`);
      expect(m.rows).toBeGreaterThan(0);
      // Delete measures 1205 with only the budget table's forms (link read 200, domains and membership 3, lock insert 200,
      // audit 202, DELETE 600: json_each rows count as read), so it gets 50 rows of headroom over 10 x N + 200.
      expect(m.rows).toBeLessThan(10 * 50 + 200 + (action === "delete" ? 50 : 0));
    }
  });
});

describe("roles (S8 R9)", () => {
  const as = async (email: string, body: unknown) => dash("/api/links/bulk", {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const setPerms = (id: string, perms: string[]) => run("UPDATE roles SET perms = ? WHERE id = ?", JSON.stringify(perms), id);
  beforeEach(async () => {
    await run("DELETE FROM roles WHERE builtin = 0");
    for (const [id, perms] of [["nb", ["links.create"]], ["ea", ["links.create", "links.bulk", "links.editAny"]], ["dmg", ["links.create", "links.bulk", "domains.manage"]]] as const)
      await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES (?,?,?,0,1,1)", id, `Role ${id}`, JSON.stringify(perms));
    for (const id of ["nb", "ea", "dmg"])
      await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,'member',?,'active',1)", `u${id}`, `${id}@example.com`, id);
    await seed("a1", "ua");
  });

  it("403 without links.bulk, before the body is read; nothing written", async () => {
    await seed("n1", "unb");
    for (const body of [{ action: "delete", ids: ["n1"] }, "{nope"]) {
      const r = await as("nb@example.com", body);
      expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    }
    expect(await count("links WHERE id = 'n1'")).toBe(1);
  });

  it("links.editAny edits a teammate's link in bulk; domains.manage alone does not", async () => {
    let r = await answer(await as("ea@example.com", { action: "redirect", ids: ["a1"], redirectCode: 301 }));
    expect(byId(r.results)).toEqual({ a1: "ok" });
    r = await answer(await as("dmg@example.com", { action: "redirect", ids: ["a1"], redirectCode: 302 }));
    expect(byId(r.results)).toEqual({ a1: "forbidden" });
    expect(await one("SELECT redirect_code FROM links WHERE id = 'a1'")).toEqual({ redirect_code: 301 });
  });

  it("race: links.bulk removed between the reads and the batch: 403, nothing written", async () => {
    await seed("e1", "uea");
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm2','go2.test','main','active','uo',1)");
    // The move reads the target keys in a third batch, so its write is the fourth.
    for (const [body, nth] of [[{ action: "delete", ids: ["e1", "a1"] }, 3], [{ action: "redirect", ids: ["e1", "a1"], redirectCode: 301 }, 3],
      [{ action: "move", ids: ["e1", "a1"], domainId: "dm2", oldAddress: "forward" }, 4], [{ action: "move", ids: ["e1", "a1"], domainId: "dm2", oldAddress: "copy" }, 4]] as const) {
      await setPerms("ea", ["links.create", "links.bulk", "links.editAny"]);
      const restore = beforeBatch(nth, () => setPerms("ea", ["links.create", "links.editAny"]));
      let r;
      try { r = await as("ea@example.com", body); } finally { restore(); }
      expect([body.action, r.status, await r.json()]).toEqual([body.action, 403, { error: "forbidden" }]);
    }
    expect(await all("SELECT id, domain_id, redirect_code FROM links WHERE id IN ('e1','a1') OR domain_id = 'dm2' ORDER BY id"))
      .toEqual([{ id: "a1", domain_id: "dm", redirect_code: 302 }, { id: "e1", domain_id: "dm", redirect_code: 302 }]);
    expect(await count("slug_locks")).toBe(0);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("copy needs links.create: 403 without it, nothing written", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm2','go2.test','main','active','uo',1)");
    await setPerms("ea", ["links.bulk", "links.editAny"]);
    const r = await as("ea@example.com", { action: "move", ids: ["a1"], domainId: "dm2", oldAddress: "copy" });
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    // forward creates no new link of its own, so it still works
    expect(byId((await answer(await as("ea@example.com", { action: "move", ids: ["a1"], domainId: "dm2", oldAddress: "forward" }))).results)).toEqual({ a1: "ok" });
    expect(await count("links WHERE domain_id = 'dm2' AND forward_to IS NULL")).toBe(1);
  });

  it("race: links.create removed before a copy's batch: 403, no copy, no audit", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm2','go2.test','main','active','uo',1)");
    const restore = beforeBatch(4, () => setPerms("ea", ["links.bulk", "links.editAny"]));
    let r;
    try { r = await as("ea@example.com", { action: "move", ids: ["a1"], domainId: "dm2", oldAddress: "copy" }); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await count("links WHERE domain_id = 'dm2'")).toBe(0);
    expect(await count("audit_log WHERE action LIKE 'link.%'")).toBe(0);
  });

  it("race: a creator who loses links.create but keeps links.editAny still edits their link in bulk", async () => {
    await seed("e1", "uea");
    const restore = beforeBatch(3, () => setPerms("ea", ["links.bulk", "links.editAny"]));
    let r;
    try { r = await answer(await as("ea@example.com", { action: "redirect", ids: ["e1"], redirectCode: 301 })); } finally { restore(); }
    expect(byId(r.results)).toEqual({ e1: "ok" });
  });

  it("race: links.editAny removed mid-request: the teammate's link is refused, the own link still written", async () => {
    await seed("e1", "uea");
    const restore = beforeBatch(3, () => setPerms("ea", ["links.create", "links.bulk"]));
    let r;
    try { r = await answer(await as("ea@example.com", { action: "redirect", ids: ["e1", "a1"], redirectCode: 301 })); } finally { restore(); }
    expect(byId(r.results)).toEqual({ e1: "ok", a1: "forbidden" });
    expect(await one("SELECT redirect_code FROM links WHERE id = 'a1'")).toEqual({ redirect_code: 302 });
    expect(await count("audit_log WHERE action = 'link.update'")).toBe(1);
  });
});
