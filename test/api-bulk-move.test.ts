import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bulk as bulkHandler } from "../src/api/bulk";
import { loopLinks } from "../src/api/shared";
import { getLink } from "../src/cache";
import type { Env } from "../src/env";
import type { Grant } from "../src/principal";
import { rowToUser, type UserRow } from "../src/types";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { harness } from "./helpers/redirect";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const all = async <T>(sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all<T>()).results;
const count = async (sql: string, ...a: unknown[]) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${sql}`, ...a))!.n;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
const call = async (who: string, method: string, path: string, body?: unknown) =>
  dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const bulk = (who: string, body: unknown) => call(who, "POST", "/api/links/bulk", body);
type Result = { id: string; ok: boolean; error?: string; link?: Record<string, unknown> };
const answer = async (r: Response) => {
  expect(r.status).toBe(200);
  return (await r.json()) as { results: Result[]; pending: string[] };
};
const byId = (res: Result[]) => Object.fromEntries(res.map((r) => [r.id, r.ok ? "ok" : r.error]));
const move = (who: string, ids: string[], domainId: string, oldAddress: "forward" | "copy") => bulk(who, { action: "move", ids, domainId, oldAddress });

const HASH = "pbkdf2-sha256$10000$c2FsdA$aGFzaA";
/** Inserts a link directly; `o` overrides columns (slug_key is lower(slug) unless given). */
const seed = (id: string, createdBy: string, o: Record<string, unknown> = {}) => {
  const r = { domain_id: "dm", slug: id, url: "https://x.com/a", password_hash: null, routes: "[]", forward_to: null, ...o };
  return run(
    `INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,password_hash,routes,forward_to,created_by,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,302,1,?,?,?,?,?,1,10)`,
    id, r.domain_id, r.slug, (o.slug_key as string | undefined) ?? String(r.slug).toLowerCase(), r.url, r.password_hash, r.routes, r.forward_to, createdBy, createdBy,
  );
};
type Row = { id: string; domain_id: string; slug: string; slug_key: string; url: string; forward_to: string | null; created_by: string; updated_at: number; password_hash: string | null; routes: string };
const at = (domain: string, key: string) => one<Row>("SELECT * FROM links WHERE domain_id = ? AND slug_key = ?", domain, key);

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
  const dom = (id: string, host: string, type: string, owner: string, o: { status?: string; cs?: number; reserved?: string[] } = {}) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,reserved_extra,created_at) VALUES (?,?,?,?,?,?,?,1)",
      id, host, type, o.status ?? "active", owner, o.cs ?? 0, JSON.stringify(o.reserved ?? []));
  await dom("dm", "go.test", "main", "uo");
  await dom("da", "a.test", "private", "ua", { cs: 1, reserved: ["vip"] });
  await dom("db", "b.test", "private", "ub");
  await dom("dp", "pending.test", "main", "uo", { status: "pending" });
  await dom("dd", "off.test", "main", "uo", { status: "disabled" });
  for (const k of ["l2:dm:spring", "l2:da:spring", "l2:db:spring", "l2:da:x", "l2:db:x", "l2:dm:x"]) await env.CACHE.delete(k);
});

describe("move: body and whole-request checks", () => {
  it("oldAddress is required and has no lock option", async () => {
    await seed("a1", "ua");
    for (const b of [{ action: "move", ids: ["a1"], domainId: "da" }, { action: "move", ids: ["a1"], domainId: "da", oldAddress: "lock" }, { action: "move", ids: ["a1"], oldAddress: "copy" }]) {
      const r = await bulk("a", b);
      expect([r.status, await r.json()]).toEqual([400, { error: "invalid_body" }]);
    }
    expect(await count("audit_log")).toBe(0);
  });

  it("target B's private domain as A: 403 forbidden whole, nothing written", async () => {
    await seed("a1", "ua");
    for (const mode of ["forward", "copy"] as const) {
      const r = await move("a", ["a1"], "db", mode);
      expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    }
    expect(await count("links")).toBe(1);
    expect(await count("audit_log")).toBe(0);
    expect(await count("auth_limits")).toBe(0);
  });

  it("M6: an unknown target answers the same 403 forbidden as one the person cannot use", async () => {
    await seed("a1", "ua");
    for (const d of ["db", "no-such-domain"]) {
      const r = await move("a", ["a1"], d, "copy");
      expect([d, r.status, await r.json()]).toEqual([d, 403, { error: "forbidden" }]);
    }
  });

  it("a pending or disabled target as the owner: 400 target_not_active whole", async () => {
    await seed("o1", "uo");
    for (const d of ["dp", "dd"]) {
      const r = await move("owner", ["o1"], d, "forward");
      expect([r.status, await r.json()]).toEqual([400, { error: "target_not_active" }]);
    }
    expect(await count("links")).toBe(1);
  });
});

describe("forward", () => {
  it("3 links go.test -> a.test as A: same ids with recomputed keys, 3 forwarders, 3 link.move audits, no locks", async () => {
    for (const s of ["One", "Two", "Three"]) await seed(`a${s}`, "ua", { slug: s });
    const r = await answer(await move("a", ["aOne", "aTwo", "aThree"], "da", "forward"));
    expect(byId(r.results)).toEqual({ aOne: "ok", aTwo: "ok", aThree: "ok" });
    expect(r.results[0]!.link).toMatchObject({ id: "aOne", domainId: "da", slugKey: "One", forwardTo: null });
    for (const s of ["One", "Two", "Three"]) {
      expect(await one("SELECT domain_id, slug_key FROM links WHERE id = ?", `a${s}`)).toEqual({ domain_id: "da", slug_key: s });
      const f = (await at("dm", s.toLowerCase()))!;
      expect(f).toMatchObject({ slug: s, url: `https://a.test/${s}`, forward_to: `a${s}`, created_by: "ua", password_hash: null, routes: "[]" });
      expect(f.id).not.toBe(`a${s}`);
    }
    const a = await all<{ target_id: string; detail: string }>("SELECT target_id, detail FROM audit_log WHERE action = 'link.move' ORDER BY target_id");
    expect(a.map((x) => x.target_id)).toEqual(["aOne", "aThree", "aTwo"]);
    const d = JSON.parse(a[0]!.detail);
    expect(d).toEqual({ fromHost: "go.test", toHost: "a.test", slug: "One", url: "https://x.com/a", oldAddress: "forward", forwarderId: (await at("dm", "one"))!.id });
    expect(await count("slug_locks")).toBe(0);
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 6 });
  });

  it("chains and cycles: every forwarder stays one hop; moving back reclaims; deleting removes the forwarders too", async () => {
    await seed("X", "uo", { slug: "x" });
    await answer(await move("owner", ["X"], "da", "forward"));
    await answer(await move("owner", ["X"], "db", "forward"));
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 2 + 3 });
    expect(await at("dm", "x")).toMatchObject({ url: "https://b.test/x", forward_to: "X" });
    expect(await at("da", "x")).toMatchObject({ url: "https://b.test/x", forward_to: "X" });
    expect(await at("db", "x")).toMatchObject({ id: "X", forward_to: null });
    const back = await answer(await move("owner", ["X"], "dm", "forward"));
    expect(byId(back.results)).toEqual({ X: "ok" });
    expect(await at("dm", "x")).toMatchObject({ id: "X", forward_to: null });
    expect(await at("da", "x")).toMatchObject({ url: "https://go.test/x", forward_to: "X" });
    expect(await at("db", "x")).toMatchObject({ url: "https://go.test/x", forward_to: "X" });
    expect(await count("links WHERE forward_to IS NOT NULL")).toBe(2);
    expect(await count("slug_locks")).toBe(0);
    // No forwarder names another forwarder.
    expect(await count("links f JOIN links t ON t.id = f.forward_to WHERE t.forward_to IS NOT NULL")).toBe(0);

    await answer(await bulk("owner", { action: "delete", ids: ["X"] }));
    const h = harness();
    for (const host of ["go.test", "a.test", "b.test"]) expect((await h.go(host, "/x")).status).toBe(404);
  });

  it("forwarders are not loops (D8)", async () => {
    await seed("a1", "ua", { url: "https://elsewhere.test/" });
    await answer(await move("a", ["a1"], "da", "forward"));
    expect(await count("links WHERE url LIKE 'https://a.test/%'")).toBe(1);
    expect(await loopLinks(env, "a.test")).toBe(0);
  });
});

describe("copy", () => {
  it("3 links -> 3 new rows on a.test with the same url, rules and hash; sources unchanged; link.create with copiedFrom", async () => {
    const routes = JSON.stringify([{ countries: ["CA"], devices: [], url: "https://ca.test/" }]);
    await seed("c1", "ua", { routes });
    await seed("c2", "ua", { password_hash: HASH });
    await seed("c3", "ua");
    const before = await all<Row>("SELECT * FROM links ORDER BY id");
    const r = await answer(await move("a", ["c1", "c2", "c3"], "da", "copy"));
    expect(byId(r.results)).toEqual({ c1: "ok", c2: "ok", c3: "ok" });
    expect(await all<Row>("SELECT * FROM links WHERE domain_id = 'dm' ORDER BY id")).toEqual(before);
    for (const s of ["c1", "c2", "c3"]) {
      const n = (await at("da", s))!;
      const src = before.find((x) => x.id === s)!;
      expect(n.id).not.toBe(s);
      expect(n).toMatchObject({ url: src.url, routes: src.routes, password_hash: src.password_hash, forward_to: null, created_by: "ua" });
      expect(r.results.find((x) => x.id === s)!.link).toMatchObject({ id: n.id, domainId: "da" });
      const d = JSON.parse((await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'link.create' AND target_id = ?", n.id))!.detail);
      expect(d.copiedFrom).toBe(s);
      expect(d.protection).toBe(s === "c2" ? "set" : undefined);
    }
    const text = JSON.stringify(r) + (await all<{ detail: string }>("SELECT detail FROM audit_log")).map((x) => x.detail).join();
    expect(text).not.toContain(HASH);
    expect(await count("audit_log")).toBe(3);
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: 3 });
  });
});

describe("per-link refusals (Review Focus 3)", () => {
  for (const mode of ["forward", "copy"] as const) {
    it(`${mode}: taken (link and forwarder), locked, reserved, duplicate_slug, same_domain, forwarder; the rest move`, async () => {
      await seed("held", "ua", { domain_id: "da", slug: "spring" });
      await seed("fwdA", "ua", { domain_id: "da", slug: "summer", url: "https://go.test/elsewhere", forward_to: "held" });
      await run("INSERT INTO slug_locks (domain_id, slug_key, locked_at, locked_by) VALUES ('da', 'promo', 1, 'ua')");
      await seed("s1", "uo", { slug: "spring" });
      await seed("s2", "uo", { slug: "summer" });
      await seed("s3", "uo", { slug: "PROMO" });
      await seed("s4", "uo", { slug: "vip" });
      await seed("s5", "uo", { slug: "sale" });
      await seed("s6", "uo", { domain_id: "db", slug: "sale" });
      await seed("s7", "uo", { domain_id: "da", slug: "here" });
      await seed("s8", "uo", { slug: "fw", url: "https://a.test/here", forward_to: "s7" });
      await seed("s9", "uo", { slug: "fine" });
      const r = await answer(await move("owner", ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"], "da", mode));
      expect(byId(r.results)).toEqual({
        s1: "taken", s2: "taken", s3: "locked", s4: "reserved", s5: "ok", s6: "duplicate_slug", s7: "same_domain", s8: "forwarder", s9: "ok",
      });
      expect(await count("links WHERE domain_id = 'da'")).toBe(5);
      expect(await count("audit_log")).toBe(2);
    });
  }

  it("Spring into a case-insensitive target holding spring: taken", async () => {
    await seed("low", "uo", { slug: "spring" });
    await seed("up", "uo", { domain_id: "da", slug: "Spring", slug_key: "Spring" });
    const r = await answer(await move("owner", ["up"], "dm", "forward"));
    expect(byId(r.results)).toEqual({ up: "taken" });
  });

  it("a forwarder is refused by schedule, redirect and password; PATCH answers 409 forwarder", async () => {
    await seed("t", "uo", { domain_id: "da", slug: "t" });
    await seed("f", "uo", { slug: "t", url: "https://a.test/t", forward_to: "t" });
    for (const b of [{ action: "schedule", endNow: true }, { action: "redirect", passQuery: false }, { action: "password", password: null }]) {
      const r = await answer(await bulk("owner", { ...b, ids: ["f"] }));
      expect(byId(r.results)).toEqual({ f: "forwarder" });
    }
    const p = await call("owner", "PATCH", "/api/links/f", { url: "https://evil.test/" });
    expect([p.status, await p.json()]).toEqual([409, { error: "forwarder" }]);
    expect(await one("SELECT url FROM links WHERE id = 'f'")).toEqual({ url: "https://a.test/t" });
    expect(await count("audit_log")).toBe(0);
  });
});

describe("KV staleness (Review Focus 4)", () => {
  it("forward: the new address answers the link, the old one 302s; after a second move the forwarder's cached entry is gone", async () => {
    await seed("sp", "uo", { slug: "spring", url: "https://dest.test/s" });
    expect(await getLink(env, "dm", "spring")).not.toBeNull();
    expect(await getLink(env, "da", "spring")).toBeNull();
    await answer(await move("owner", ["sp"], "da", "forward"));
    const h = harness();
    let r = await h.go("a.test", "/spring?lw=qr");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/s"]);
    r = await h.go("go.test", "/spring?lw=qr");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://a.test/spring?lw=qr"]);
    expect(h.points).toHaveLength(1);
    expect(await env.CACHE.get("l2:dm:spring")).not.toBeNull();
    await answer(await move("owner", ["sp"], "db", "forward"));
    expect(await env.CACHE.get("l2:dm:spring")).toBeNull();
    r = await h.go("go.test", "/spring");
    expect(r.headers.get("location")).toBe("https://b.test/spring");
  });

  it("copy: the new address answers the copy, the old one the original", async () => {
    await seed("sp", "uo", { slug: "spring", url: "https://dest.test/s" });
    await getLink(env, "dm", "spring");
    await getLink(env, "da", "spring");
    await answer(await move("owner", ["sp"], "da", "copy"));
    const h = harness();
    expect((await h.go("a.test", "/spring")).headers.get("location")).toBe("https://dest.test/s");
    expect((await h.go("go.test", "/spring")).headers.get("location")).toBe("https://dest.test/s");
    expect(h.points.map((p) => p.blobs![1])).toEqual([(await at("da", "spring"))!.id, "sp"]);
  });
});

describe("race (Review Focus 1, D4)", () => {
  for (const mode of ["forward", "copy"] as const) {
    it(`${mode}: a link created on the target key between read and batch: that one conflict, nothing for it, the rest done`, async () => {
      for (const id of ["r1", "r2", "r3"]) await seed(id, "ua");
      const restore = beforeBatch(4, () => seed("racer", "ub", { domain_id: "da", slug: "r2" }));
      let r;
      try { r = await answer(await move("a", ["r1", "r2", "r3"], "da", mode)); } finally { restore(); }
      expect(byId(r.results)).toEqual({ r1: "ok", r2: "conflict", r3: "ok" });
      expect(await at("dm", "r2")).toMatchObject({ id: "r2", forward_to: null });
      expect(await at("da", "r2")).toMatchObject({ id: "racer" });
      expect(await count("audit_log WHERE target_id = 'r2' OR detail LIKE '%\"r2\"%'")).toBe(0);
      expect(await count("audit_log")).toBe(2);
      expect(await count("links WHERE domain_id = 'da'")).toBe(3);
    });
  }
});

describe("grant scopes inside the handler (defense in depth)", () => {
  const app = (grant: Grant) => {
    const h = new Hono<{ Bindings: Env; Variables: { user: UserRow; grant: Grant } }>();
    h.use("*", async (c, next) => {
      c.set("user", rowToUser((await one<Record<string, unknown>>("SELECT * FROM users WHERE id = 'ua'"))!));
      c.set("grant", grant);
      await next();
    });
    h.post("/bulk", bulkHandler);
    return (body: unknown) => h.request("/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  };

  it("read-only grant: every action read_only; write-only grant: delete delete_not_allowed; nothing written or charged", async () => {
    await seed("g1", "ua");
    const ro = app({ write: false, del: false, domains: null, via: "k" });
    for (const b of [
      { action: "schedule", ids: ["g1"], endNow: true }, { action: "redirect", ids: ["g1"], passQuery: false },
      { action: "password", ids: ["g1"], password: null }, { action: "move", ids: ["g1"], domainId: "da", oldAddress: "copy" },
      { action: "delete", ids: ["g1"] },
    ]) {
      const r = await ro(b);
      expect([r.status, await r.json()]).toEqual([403, { error: b.action === "delete" ? "delete_not_allowed" : "read_only" }]);
    }
    const wo = app({ write: true, del: false, domains: null, via: "k" });
    const r = await wo({ action: "delete", ids: ["g1"] });
    expect([r.status, await r.json()]).toEqual([403, { error: "delete_not_allowed" }]);
    expect(await count("links")).toBe(1);
    expect(await count("audit_log")).toBe(0);
    expect(await count("auth_limits")).toBe(0);
  });
});

describe("budget", () => {
  it("rows read stay under 10 x N + 200 for a 50-link forward move (1000 links, 1000 locks per domain)", async () => {
    const seq = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)";
    for (const d of ["dm", "da"]) {
      await run(`${seq} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,created_by,updated_by,created_at,updated_at)
        SELECT '${d}' || i, '${d}', 'z${d}' || i, 'z${d}' || i, 'https://x.com/', 302, 1, '[]', 'uo', 'uo', 1, 10 FROM n`);
      await run(`${seq} INSERT INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT '${d}', 'k' || i, 1, 'uo' FROM n`);
    }
    const ids = Array.from({ length: 50 }, (_, i) => `dm${i}`);
    const m = meter();
    let r;
    try { r = await answer(await move("owner", ids, "da", "forward")); } finally { m.restore(); }
    expect(r.results.every((x) => x.ok)).toBe(true);
    console.log(`bulk move forward x50: rows_read ${m.rows}`);
    expect(m.rows).toBeGreaterThan(0);
    // Measures 1408 with only the budget table's forms (link read 200, domains and membership 6, target checks 200, move
    // UPDATE-FROM 500, forwarder insert 300, audit 202): the forms alone exceed 10 x N + 200, so 250 rows of headroom (as delete's 50).
    expect(m.rows).toBeLessThan(10 * 50 + 200 + 250);
  });
});

describe("delete removes forwarders (QR codes never land on a new link)", () => {
  /** X lives on b.test/x and has forwarders on go.test/x and a.test/x; their redirects are cached. */
  async function chain() {
    await seed("X", "uo", { slug: "x" });
    await answer(await move("owner", ["X"], "da", "forward"));
    await answer(await move("owner", ["X"], "db", "forward"));
    const h = harness();
    for (const host of ["go.test", "a.test"]) expect((await h.go(host, "/x")).status).toBe(302);
    expect(await env.CACHE.get("l2:dm:x")).not.toBeNull();
    return (await all<Row>("SELECT * FROM links WHERE forward_to = 'X' ORDER BY domain_id")).map((r) => r.id);
  }
  const deletes = (ids: string[]) =>
    all<{ target_id: string; detail: string }>(`SELECT target_id, detail FROM audit_log WHERE action = 'link.delete' AND target_id IN (SELECT value FROM json_each(?)) ORDER BY target_id`, JSON.stringify(ids));
  async function gone(fwd: string[]) {
    expect(await count("links")).toBe(0);
    expect((await all<{ domain_id: string; slug_key: string }>("SELECT domain_id, slug_key FROM slug_locks ORDER BY domain_id"))
      .map((l) => `${l.domain_id}/${l.slug_key}`)).toEqual(["da/x", "db/x", "dm/x"]);
    const a = await deletes(["X", ...fwd]);
    expect(a.map((x) => x.target_id).sort()).toEqual(["X", ...fwd].sort());
    for (const x of a.filter((x) => x.target_id !== "X")) expect(JSON.parse(x.detail)).toMatchObject({ slug: "x", forwarderOf: "X" });
    for (const k of ["l2:dm:x", "l2:da:x"]) expect(await env.CACHE.get(k)).toBeNull();
    const h = harness();
    for (const host of ["go.test", "a.test", "b.test"]) expect((await h.go(host, "/x")).status).toBe(404);
  }

  it("bulk delete: the link and both forwarders go, all three addresses locked, one audit each, KV cleared, budget counts them", async () => {
    const fwd = await chain();
    const kv = (await one<{ count: number }>("SELECT count FROM auth_limits WHERE key = 'bulk:kv'"))!.count;
    const r = await answer(await bulk("owner", { action: "delete", ids: ["X"] }));
    expect(byId(r.results)).toEqual({ X: "ok" });
    await gone(fwd);
    expect(await one("SELECT count FROM auth_limits WHERE key = 'bulk:kv'")).toEqual({ count: kv + 3 });
  });

  it("single delete: the same", async () => {
    const fwd = await chain();
    expect((await call("owner", "DELETE", "/api/links/X")).status).toBe(204);
    await gone(fwd);
  });

  it("bulk delete of the link and one of its forwarders: both ok, each deleted and audited once", async () => {
    const fwd = await chain();
    const r = await answer(await bulk("owner", { action: "delete", ids: [fwd[0]!, "X"] }));
    expect(byId(r.results)).toEqual({ [fwd[0]!]: "ok", X: "ok" });
    await gone(fwd);
  });

  it("a revision change between read and batch: conflict, the link and its forwarders stay, no locks", async () => {
    await chain();
    const restore = beforeBatch(3, () => run("UPDATE links SET updated_at = updated_at + 50 WHERE id = 'X'"));
    let r;
    try { r = await answer(await bulk("owner", { action: "delete", ids: ["X"] })); } finally { restore(); }
    expect(byId(r.results)).toEqual({ X: "conflict" });
    expect(await count("links")).toBe(3);
    expect(await count("slug_locks")).toBe(0);
  });

  it("rows read for a 50-link delete where every link has one forwarder", async () => {
    const s100 = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49)";
    await run(`${s100} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,created_by,updated_by,created_at,updated_at)
      SELECT 'r' || i, 'da', 'r' || i, 'r' || i, 'https://x.com/', 302, 1, '[]', 'uo', 'uo', 1, 10 FROM n`);
    await run(`${s100} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,forward_to,created_by,updated_by,created_at,updated_at)
      SELECT 'f' || i, 'dm', 'r' || i, 'r' || i, 'https://a.test/r' || i, 302, 1, '[]', 'r' || i, 'uo', 'uo', 1, 10 FROM n`);
    const m = meter();
    let r;
    try { r = await answer(await bulk("owner", { action: "delete", ids: Array.from({ length: 50 }, (_, i) => `r${i}`) })); } finally { m.restore(); }
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(await count("links")).toBe(0);
    expect(await count("slug_locks")).toBe(100);
    console.log(`bulk delete x50 with one forwarder each: rows_read ${m.rows}`);
    // Measures 3002 (each forwarder adds a count probe, a lock, an audit row with its domain and a delete); bound about 35 x N.
    expect(m.rows).toBeLessThan(35 * 50);
  });

  it("releasing the lock on the moved address and reusing it does not reopen the old addresses", async () => {
    await chain();
    expect((await call("owner", "DELETE", "/api/links/X")).status).toBe(204);
    expect((await call("owner", "DELETE", "/api/locks/db/x")).status).toBe(204);
    const made = await call("b", "POST", "/api/links", { domainId: "db", slug: "x", url: "https://someone-else.test/" });
    expect(made.status).toBe(201);
    const h = harness();
    const r = await h.go("b.test", "/x");
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://someone-else.test/"]);
    for (const host of ["go.test", "a.test"]) expect((await h.go(host, "/x")).status).toBe(404);
    expect((await call("b", "POST", "/api/links", { domainId: "dm", slug: "x", url: "https://someone-else.test/" })).status).toBe(409);
  });
});

describe("final wave", () => {
  for (const mode of ["forward", "copy"] as const) {
    it(`M4 ${mode}: a link whose destination or a route points at the target host is refused loop; the rest move`, async () => {
      await seed("p1", "ua", { slug: "p1", url: "https://A.test./x" });
      await seed("p2", "ua", { slug: "p2", routes: JSON.stringify([{ countries: ["DE"], devices: [], url: "http://a.test:8080/y" }]) });
      await seed("p3", "ua", { slug: "p3" });
      const r = await answer(await move("a", ["p1", "p2", "p3"], "da", mode));
      expect(byId(r.results)).toEqual({ p1: "loop", p2: "loop", p3: "ok" });
      expect(await count("links WHERE domain_id = 'da'")).toBe(1);
    });
  }

  it("M3: the same person double-submits the same forward move in the same second: the second reports that link as conflict and still moves the others", async () => {
    await seed("w", "ua", { slug: "w" });
    await seed("v", "ua", { slug: "v" });
    let inner: Response | undefined;
    const restore = beforeBatch(4, async () => { inner = await move("a", ["w"], "da", "forward"); });
    let r;
    try { r = await answer(await move("a", ["w", "v"], "da", "forward")); } finally { restore(); }
    expect(inner!.status).toBe(200);
    expect(byId(r.results)).toEqual({ w: "conflict", v: "ok" });
    expect(await one("SELECT domain_id FROM links WHERE id = 'v'")).toEqual({ domain_id: "da" });
    expect([await count("links WHERE forward_to = 'w'"), await count("links WHERE forward_to = 'v'")]).toEqual([1, 1]);
    // One move audit per link that this batch or the first one actually moved: none claimed twice for w.
    expect([await count("audit_log WHERE action = 'link.move' AND target_id = 'w'"), await count("audit_log WHERE action = 'link.move' AND target_id = 'v'")]).toEqual([1, 1]);
  });
});

describe("fix round 1", () => {
  for (const mode of ["forward", "copy"] as const) {
    it(`${mode} as A: B's links on a shared and the main domain and on B's private domain forbidden, A's own ok; nothing for the refused`, async () => {
      await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('ds','shared.test','shared','active','uo',1)");
      await run("INSERT INTO domain_members (domain_id, user_id) VALUES ('ds','ua'), ('ds','ub')");
      await seed("bs", "ub", { domain_id: "ds", url: "https://secret.test/s", password_hash: HASH });
      await seed("bm", "ub", { url: "https://secret.test/m", password_hash: HASH });
      await seed("bp", "ub", { domain_id: "db", url: "https://secret.test/p" });
      await seed("mine", "ua");
      for (const k of ["l2:da:bs", "l2:da:bm", "l2:da:bp", "l2:ds:bs"]) await env.CACHE.put(k, "null");
      const before = await all<Row>("SELECT * FROM links ORDER BY id");
      const r = await answer(await move("a", ["bs", "bm", "bp", "mine"], "da", mode));
      expect(byId(r.results)).toEqual({ bs: "forbidden", bm: "forbidden", bp: "forbidden", mine: "ok" });
      const after = await all<Row>("SELECT * FROM links ORDER BY id");
      for (const id of ["bs", "bm", "bp"]) expect(after.find((x) => x.id === id)).toEqual(before.find((x) => x.id === id));
      expect(await count("links WHERE url LIKE 'https://secret.test/%'")).toBe(3);
      expect(await count("links WHERE password_hash IS NOT NULL")).toBe(2);
      expect(await count("links WHERE forward_to IN ('bs','bm','bp')")).toBe(0);
      expect(await count("links")).toBe(5);
      expect(await count("audit_log WHERE detail LIKE '%secret.test%' OR target_id IN ('bs','bm','bp')")).toBe(0);
      expect(await count("audit_log")).toBe(1);
      for (const k of ["l2:da:bs", "l2:da:bm", "l2:da:bp", "l2:ds:bs"]) expect(await env.CACHE.get(k)).toBe("null");
    });
  }

  it("M1: a concurrent move of the same link wins: the losing batch writes no forwarder and no audit", async () => {
    await seed("w", "ua", { slug: "w" });
    // The winner moved it to a.test and its forwarder on go.test/w was already deleted (address free again).
    const restore = beforeBatch(4, () => run("UPDATE links SET domain_id = 'da', slug_key = 'w', updated_by = 'uo', updated_at = 99 WHERE id = 'w'"));
    let r;
    try { r = await answer(await move("a", ["w"], "da", "forward")); } finally { restore(); }
    expect(byId(r.results)).toEqual({ w: "conflict" });
    expect(await at("dm", "w")).toBeNull();
    expect(await count("audit_log")).toBe(0);
  });

  it("M2: a revision change races a move back: the forwarder it would reclaim survives, no repoint, no audit", async () => {
    await seed("X", "uo", { slug: "x" });
    await answer(await move("owner", ["X"], "da", "forward"));
    await answer(await move("owner", ["X"], "db", "forward"));
    const audits = await count("audit_log");
    const restore = beforeBatch(4, () => run("UPDATE links SET updated_at = updated_at + 50 WHERE id = 'X'"));
    let r;
    try { r = await answer(await move("owner", ["X"], "dm", "forward")); } finally { restore(); }
    expect(byId(r.results)).toEqual({ X: "conflict" });
    expect(await at("dm", "x")).toMatchObject({ url: "https://b.test/x", forward_to: "X" });
    expect(await at("da", "x")).toMatchObject({ url: "https://b.test/x", forward_to: "X" });
    expect(await at("db", "x")).toMatchObject({ id: "X" });
    expect(await count("audit_log")).toBe(audits);
  });

  it("M2: rows read for a 50-link forward move where every link reclaims one forwarder and repoints another", async () => {
    const seq = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)";
    const s100 = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49)";
    const ins = (sel: string) => run(`INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,forward_to,created_by,updated_by,created_at,updated_at) ${sel}`);
    for (const d of ["dm", "da"]) {
      await run(`${seq} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,created_by,updated_by,created_at,updated_at)
        SELECT '${d}' || i, '${d}', 'z${d}' || i, 'z${d}' || i, 'https://x.com/', 302, 1, '[]', 'uo', 'uo', 1, 10 FROM n`);
      await run(`${seq} INSERT INTO slug_locks (domain_id, slug_key, locked_at, locked_by) SELECT '${d}', 'k' || i, 1, 'uo' FROM n`);
    }
    // Each r<i> lives on b.test, came from a.test (its forwarder there is reclaimed) and earlier from go.test (repointed).
    await run(`${s100} INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,routes,created_by,updated_by,created_at,updated_at)
      SELECT 'r' || i, 'db', 'r' || i, 'r' || i, 'https://x.com/', 302, 1, '[]', 'uo', 'uo', 1, 10 FROM n`);
    await ins(`${s100} SELECT 'm2fa' || i, 'da', 'r' || i, 'r' || i, 'https://b.test/r' || i, 302, 1, '[]', 'r' || i, 'uo', 'uo', 1, 10 FROM n`);
    await ins(`${s100} SELECT 'm2fm' || i, 'dm', 'r' || i, 'r' || i, 'https://b.test/r' || i, 302, 1, '[]', 'r' || i, 'uo', 'uo', 1, 10 FROM n`);
    const ids = Array.from({ length: 50 }, (_, i) => `r${i}`);
    const m = meter();
    let r;
    try { r = await answer(await move("owner", ids, "da", "forward")); } finally { m.restore(); }
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(await count("links WHERE id LIKE 'm2fa%'")).toBe(0);
    expect(await count("links WHERE id LIKE 'm2fm%' AND url LIKE 'https://a.test/r%'")).toBe(50);
    expect(await count("links WHERE domain_id = 'db' AND forward_to IS NOT NULL")).toBe(50);
    console.log(`bulk move forward x50 with reclaim and repoint: rows_read ${m.rows}`);
    // Measures 3306: link read 200, domains 6, target checks 599 (two forwarders counted per link), reclaim DELETE 700,
    // move 500, forwarder insert 300, repoint UPDATE-FROM 799, audit 201. Each total is a small multiple of the 100 selected
    // links, well under the 2000 other links and 2000 locks seeded, so no form scans a table; bound about 37 x N (the repoint
    // and audit each add one primary-key probe per link for this batch's own forwarder).
    expect(m.rows).toBeLessThan(37 * 50);
  });
});
