import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/sample-export.json";
import { chunkLinks, filterHosts, parseExport } from "../src/importFormat";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).all<T>().then((r) => r.results);
const count = async (t: string) => (await all<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))[0]!.n;
const audits = async (a: string) => (await all<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = ?", a))[0]!.n;

type L = { host: string | null; slug: string; destination: string; enabled?: boolean; protected?: boolean; startDate?: string | null; endDate?: string | null };
const link = (l: L) => ({ enabled: true, startDate: null, endDate: null, ...l });
const body = (links: L[], domains: unknown[] = [], mainHost = "main.example") => ({ mainHost, domains, links: links.map(link) });
async function imp(who: string, b: unknown, q = "") {
  return dash(`/api/import${q}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(who), "content-type": "application/json" },
    body: JSON.stringify(b),
  });
}
// Most cases are about other rules: they confirm "no password links" unless the body says otherwise (N2 tests use imp).
const owner = (b: unknown, q = "") => imp("owner@example.com", { confirmNoPasswords: true, ...(b as object) }, q);
const get = (host: string, path: string) => exports.default.fetch(`https://${host}${path}`, { redirect: "manual" });
const rep = async (r: Response) => (await r.json()) as { created: number; skipped: number; conflicts: { host: string; slug: string; reason: string }[]; caseSensitiveDomains: string[]; domainsCreated: string[]; ignored: { host: string; field: string }[]; protected: { host: string; slug: string }[] };
const D = (host: string, i: string | null = null, n: string | null = null) => ({ host, customIndexUrl: i, customNotFoundUrl: n });

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "settings", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)");
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('um','m@example.com','member','active',1)");
});

describe("fixture import (main.example only)", () => {
  const filtered = () => filterHosts(parseExport(fixture), ["main.example"]);
  it("first run creates domain and links with exact slugs; second run skips all", async () => {
    const r1 = await owner(filtered());
    expect(r1.status).toBe(200);
    expect(await rep(r1)).toEqual({ created: 4, skipped: 0, conflicts: [], caseSensitiveDomains: [], domainsCreated: ["main.example"], ignored: [], protected: [] });
    const dom = (await all<Record<string, unknown>>("SELECT * FROM domains"))[0]!;
    expect(dom).toMatchObject({ host: "main.example", type: "private", status: "active", owner_id: "uo", bare_redirect: "https://example.org/home", notfound_redirect: "https://example.org/missing" });
    expect((await all<{ slug: string }>("SELECT slug FROM links ORDER BY slug")).map((r) => r.slug)).toEqual(["Spring", "app", "promo"]);
    expect((await all<{ slug_key: string }>("SELECT slug_key FROM slug_locks")).map((r) => r.slug_key)).toEqual(["old"]);
    const promo = (await all<{ starts_at: number; expires_at: number }>("SELECT * FROM links WHERE slug='promo'"))[0]!;
    expect([promo.starts_at, promo.expires_at]).toEqual([Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 1, 1, 12, 30) / 1000]);
    expect((await get("main.example", "/spring")).headers.get("location")).toBe("https://example.org/spring");
    expect(await audits("import.run")).toBe(1);

    const r2 = await rep(await owner(filtered()));
    expect(r2).toMatchObject({ created: 0, skipped: 4, conflicts: [] });
    expect(await count("links")).toBe(3);
    expect(await audits("import.run")).toBe(2);
  });
});

describe("instance link defaults", () => {
  it("imported links use the instance redirect code and query pass-through", async () => {
    expect(await rep(await owner(body([{ host: null, slug: "a", destination: "https://example.org/a" }])))).toMatchObject({ created: 1 });
    expect(await all("SELECT redirect_code, pass_query FROM links")).toEqual([{ redirect_code: 302, pass_query: 1 }]);
    await run(`INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('links.defaultRedirectCode','301',1,'uo'),('links.defaultPassQuery','false',1,'uo')`);
    expect(await rep(await owner(body([{ host: null, slug: "b", destination: "https://example.org/b" }])))).toMatchObject({ created: 1 });
    expect(await all("SELECT redirect_code, pass_query FROM links WHERE slug = 'b'")).toEqual([{ redirect_code: 301, pass_query: 0 }]);
  });
});

describe("rules", () => {
  it("is owner only, validates the body, caps at 1000", async () => {
    expect((await imp("m@example.com", body([]))).status).toBe(403);
    expect((await owner({ nope: 1 })).status).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i) => ({ host: "a.test", slug: `s${i}`, destination: "https://e.org/" }));
    const r = await owner(body(many));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "too_many" });
    expect(await count("domains")).toBe(0);
  });
  it("changed destination is a conflict and the original is kept", async () => {
    await owner(body([{ host: "a.test", slug: "x", destination: "https://e.org/1" }]));
    const r = await rep(await owner(body([{ host: "a.test", slug: "x", destination: "https://e.org/2" }])));
    expect(r).toMatchObject({ created: 0, skipped: 0, conflicts: [{ host: "a.test", slug: "x", reason: "exists" }] });
    expect((await get("a.test", "/x")).headers.get("location")).toBe("https://e.org/1");
  });
  it("case twins create a case-sensitive domain and both resolve", async () => {
    const r = await rep(await owner(body([
      { host: "t.test", slug: "Abc", destination: "https://e.org/upper" }, { host: "t.test", slug: "abc", destination: "https://e.org/lower" },
    ])));
    expect(r).toMatchObject({ created: 2, caseSensitiveDomains: ["t.test"], conflicts: [] });
    expect((await get("t.test", "/Abc")).headers.get("location")).toBe("https://e.org/upper");
    expect((await get("t.test", "/abc")).headers.get("location")).toBe("https://e.org/lower");
  });
  it("case twins on an existing case-insensitive domain are conflicts; the domain is not flipped", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('d1','e.test','shared','active','uo',1)");
    const r = await rep(await owner(body([
      { host: "e.test", slug: "Abc", destination: "https://e.org/u" }, { host: "e.test", slug: "abc", destination: "https://e.org/l" },
    ])));
    expect(r.created).toBe(0);
    expect(r.conflicts.map((c) => c.reason)).toEqual(["case_twin", "case_twin"]);
    expect((await all<{ case_sensitive: number; type: string }>("SELECT * FROM domains"))[0]).toMatchObject({ case_sensitive: 0, type: "shared" });
  });
  it("disabled link becomes a lock only; live link onto a lock conflicts; disabled onto live link conflicts", async () => {
    const r = await rep(await owner(body([{ host: "a.test", slug: "Gone", destination: "https://e.org/g", enabled: false }])));
    expect(r.created).toBe(1);
    expect(await count("links")).toBe(0);
    expect((await get("a.test", "/gone")).status).not.toBe(302);
    const r2 = await rep(await owner(body([{ host: "a.test", slug: "gone", destination: "https://e.org/g" }])));
    expect(r2.conflicts).toEqual([{ host: "a.test", slug: "gone", reason: "locked" }]);
    await owner(body([{ host: "a.test", slug: "live", destination: "https://e.org/l" }]));
    const r3 = await rep(await owner(body([{ host: "a.test", slug: "live", destination: "https://e.org/l", enabled: false }])));
    expect(r3.conflicts).toEqual([{ host: "a.test", slug: "live", reason: "exists" }]);
    expect(await count("slug_locks")).toBe(1);
  });
  it("a protected legacy link arrives as a lock, never live, and is listed", async () => {
    const b = body([{ host: "a.test", slug: "Secret", destination: "https://e.org/private", protected: true }, { host: "a.test", slug: "open", destination: "https://e.org/o" }]);
    const dry = await rep(await owner(b, "?dryRun=1"));
    expect(dry.protected).toEqual([{ host: "a.test", slug: "Secret" }]);
    const r = await rep(await owner(b));
    expect(r).toMatchObject({ created: 2, conflicts: [], protected: [{ host: "a.test", slug: "Secret" }] });
    expect((await all<{ slug: string }>("SELECT slug FROM links")).map((x) => x.slug)).toEqual(["open"]);
    expect((await all<{ slug_key: string }>("SELECT slug_key FROM slug_locks")).map((x) => x.slug_key)).toEqual(["secret"]);
    const res = await get("a.test", "/Secret");
    expect(res.status).not.toBe(302);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain("e.org/private");
    // Running it again keeps it locked and still lists it, so the owner can find it.
    const r2 = await rep(await owner(b));
    expect(r2).toMatchObject({ created: 0, skipped: 2, protected: [{ host: "a.test", slug: "Secret" }] });
  });
  it("a protected link whose slug is already live is the conflict protected_live, so the owner sees the live open redirect", async () => {
    // An earlier import (an old export, confirmed) put the password link live; the corrected export marks it protected.
    await owner(body([{ host: "a.test", slug: "Secret", destination: "https://e.org/private" }]));
    const r = await rep(await owner(body([{ host: "a.test", slug: "Secret", destination: "https://e.org/private", protected: true }])));
    expect(r).toMatchObject({ created: 0, conflicts: [{ host: "a.test", slug: "Secret", reason: "protected_live" }], protected: [] });
  });
  it("protected must be a boolean", async () => {
    expect((await owner({ ...body([]), links: [{ ...link({ host: null, slug: "a", destination: "https://e.org/" }), protected: "yes" }] })).status).toBe(400);
  });
  it("legacy reserved slugs are kept; invalid slug, destination and dates are reported", async () => {
    const r = await rep(await owner(body([
      { host: "a.test", slug: "app", destination: "https://e.org/app" },
      { host: "a.test", slug: "bad slug", destination: "https://e.org/" },
      { host: "a.test", slug: "d1", destination: "javascript:alert(1)" },
      { host: "a.test", slug: "d2", destination: "https://a.test/loop" },
      { host: "a.test", slug: "d3", destination: "https://e.org/", startDate: "2026-13-01 00:00:00" },
      { host: "a.test", slug: "d4", destination: "https://e.org/", startDate: "2026-02-01 00:00:00", endDate: "2026-01-01 00:00:00" },
    ])));
    expect(r.created).toBe(1);
    expect(r.conflicts.map((c) => [c.slug, c.reason])).toEqual([
      ["bad slug", "invalid_slug"], ["d1", "invalid_destination"], ["d2", "invalid_destination"], ["d3", "bad_date"], ["d4", "bad_date"],
    ]);
  });
  it("never creates the dashboard host; invalid redirect urls are ignored and reported", async () => {
    const r = await rep(await owner(body([
      { host: "DASH.test.", slug: "x", destination: "https://e.org/" }, { host: "ok.test", slug: "y", destination: "https://e.org/" },
    ], [D("ok.test", "ftp://nope", "https://e.org/nf")])));
    expect(r.conflicts).toEqual([{ host: "dash.test", slug: "x", reason: "dashboard_host" }]);
    expect(r.ignored).toEqual([{ host: "ok.test", field: "customIndexUrl" }]);
    expect((await all<Record<string, unknown>>("SELECT * FROM domains WHERE host='ok.test'"))[0]).toMatchObject({ bare_redirect: null, notfound_redirect: "https://e.org/nf" });
    expect(await count("domains")).toBe(1);
  });
  it("existing domain is reused: type/status kept, only null redirects filled", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,created_at) VALUES ('d1','e.test','shared','pending','uo','https://keep.org/',1)");
    await owner(body([], [D("e.test", "https://e.org/new", "https://e.org/nf")]));
    expect((await all<Record<string, unknown>>("SELECT * FROM domains"))[0]).toMatchObject({
      type: "shared", status: "pending", bare_redirect: "https://keep.org/", notfound_redirect: "https://e.org/nf" });
  });
  it("dryRun reports the same but writes nothing and no audit", async () => {
    const b = body([{ host: "a.test", slug: "x", destination: "https://e.org/" }, { host: "a.test", slug: "g", destination: "https://e.org/", enabled: false }]);
    const dry = await rep(await owner(b, "?dryRun=1"));
    expect(dry.created).toBe(2);
    expect(await count("domains") + await count("links") + await count("slug_locks") + await count("audit_log")).toBe(0);
    expect(await rep(await owner(b))).toMatchObject({ created: 2 });
  });
  it("disabled `abc` beside live `Abc` is a conflict, not a lock", async () => {
    const r = await rep(await owner(body([
      { host: "a.test", slug: "Abc", destination: "https://e.org/" }, { host: "a.test", slug: "abc", destination: "https://e.org/", enabled: false },
    ])));
    expect(r).toMatchObject({ created: 1, conflicts: [{ host: "a.test", slug: "abc", reason: "exists" }] });
    expect(await count("slug_locks")).toBe(0);
  });
  it("multi-request import with twins sorting last still creates the domain case-sensitive", async () => {
    const mk = (slug: string) => ({ host: "big.test", slug, destination: "https://e.org/" + slug, enabled: true, startDate: null, endDate: null });
    const links = [...["a", "b", "c", "d"].map(mk), mk("zz"), mk("ZZ")];
    const chunks = chunkLinks({ mainHost: "big.test", domains: [], links }, 2);
    expect(chunks.length).toBeGreaterThan(1);
    let created = 0;
    for (const ch of chunks) {
      const r = await rep(await owner({ mainHost: "big.test", domains: [], links: ch }));
      expect(r.conflicts).toEqual([]);
      created += r.created;
    }
    expect(created).toBe(6);
    expect((await all<{ case_sensitive: number }>("SELECT case_sensitive FROM domains"))[0]!.case_sensitive).toBe(1);
    expect((await get("big.test", "/zz")).headers.get("location")).toBe("https://e.org/zz");
    expect((await get("big.test", "/ZZ")).headers.get("location")).toBe("https://e.org/ZZ");
  });
  it("writes one import.chunk audit row per D1 batch and a run row with `planned`", async () => {
    const links = Array.from({ length: 250 }, (_, i) => ({ host: "big.test", slug: `s${i}`, destination: "https://e.org/" + i }));
    expect((await rep(await owner(body(links)))).created).toBe(250);
    const chunks = (await all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'import.chunk' ORDER BY id")).map((r) => JSON.parse(r.detail));
    expect(chunks).toEqual([
      { hosts: ["big.test"], domains: 1, links: 97, locks: 0 },
      { hosts: ["big.test"], domains: 0, links: 98, locks: 0 },
      { hosts: ["big.test"], domains: 0, links: 55, locks: 0 },
    ]);
    const run = JSON.parse((await all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'import.run'"))[0]!.detail);
    expect(run).toMatchObject({ planned: 250 });
    expect(run).not.toHaveProperty("created");
  });
  it("reads existing links and locks of reused domains with a bounded number of queries", async () => {
    const stmts: D1PreparedStatement[] = [];
    const links: L[] = [];
    for (let i = 0; i < 120; i++) {
      stmts.push(env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'private','active','uo',1)").bind(`r${i}`, `r${i}.test`));
      stmts.push(env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,'s','s','https://e.org/',?,?,1,1)").bind(`rl${i}`, `r${i}`, "uo", "uo"));
      stmts.push(env.DB.prepare("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES (?,'gone',1,'uo')").bind(`r${i}`));
      links.push({ host: `r${i}.test`, slug: "s", destination: "https://e.org/" }, { host: `r${i}.test`, slug: "gone", destination: "https://e.org/g" });
    }
    await env.DB.batch(stmts);
    const prepare = env.DB.prepare;
    let reads = 0;
    env.DB.prepare = ((sql: string) => { if (/^SELECT .* FROM (links|slug_locks)/.test(sql)) reads++; return prepare.call(env.DB, sql); }) as typeof prepare;
    try {
      const r = await rep(await owner(body(links)));
      expect(r).toMatchObject({ created: 0, skipped: 120 });
      expect(r.conflicts).toHaveLength(120);
      expect(new Set(r.conflicts.map((c) => c.reason))).toEqual(new Set(["locked"]));
    } finally {
      env.DB.prepare = prepare;
    }
    expect(reads).toBeLessThanOrEqual(2);
  });
  it("a domain created by a request takes the case mode of that request's twins only", async () => {
    const r1 = await rep(await owner(body([
      { host: "x.test", slug: "Ab", destination: "https://e.org/1" }, { host: "x.test", slug: "ab", destination: "https://e.org/2" },
    ], [D("x.test"), D("y.test")])));
    expect(r1).toMatchObject({ created: 2, caseSensitiveDomains: ["x.test"], domainsCreated: ["x.test", "y.test"] });
    // y.test was created by a request without its twins, so later twins can no longer make it case-sensitive.
    const r2 = await rep(await owner(body([
      { host: "y.test", slug: "Cd", destination: "https://e.org/3" }, { host: "y.test", slug: "cd", destination: "https://e.org/4" },
    ], [D("y.test")])));
    expect(r2.conflicts.map((c) => c.reason)).toEqual(["case_twin", "case_twin"]);
    expect(await all("SELECT host, case_sensitive FROM domains ORDER BY host")).toEqual([{ host: "x.test", case_sensitive: 1 }, { host: "y.test", case_sensitive: 0 }]);
  });

  it("a link blocked by a lock that landed after planning is reported as locked", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dx','x.test','private','active','uo',1)");
    const restore = beforeBatch(2, () => run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dx','abc',1,'uo')"));
    let r;
    try { r = await rep(await owner(body([{ host: "x.test", slug: "abc", destination: "https://e.org/" }]))); } finally { restore(); }
    expect(r).toMatchObject({ created: 0, conflicts: [{ host: "x.test", slug: "abc", reason: "locked" }] });
  });

  it("a domain whose case mode changed after planning gets no links; they are reported as mode_changed", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dx','x.test','private','active','uo',1)");
    // Batch 1 is the planning read; batch 2 is the first write.
    const restore = beforeBatch(2, () => run("UPDATE domains SET case_sensitive = 1 WHERE id = 'dx'"));
    let r;
    try { r = await rep(await owner(body([{ host: "x.test", slug: "Abc", destination: "https://e.org/" }]))); } finally { restore(); }
    expect(r).toMatchObject({ created: 0, conflicts: [{ host: "x.test", slug: "Abc", reason: "mode_changed" }] });
    expect(await count("links")).toBe(0);
  });

  it("a lock planned for a slug that went live after planning is not written; it is reported as exists", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dx','x.test','private','active','uo',1)");
    const restore = beforeBatch(2, () => run(
      "INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l1','dx','Old','old','https://e.org/','uo','uo',1,1)"));
    let r;
    try { r = await rep(await owner(body([{ host: "x.test", slug: "old", destination: "https://e.org/", enabled: false }]))); } finally { restore(); }
    expect(r).toMatchObject({ created: 0, conflicts: [{ host: "x.test", slug: "old", reason: "exists" }] });
    expect(await count("slug_locks")).toBe(0);
  });

  it("duplicate rows within one export are skipped when identical", async () => {
    const l = { host: "a.test", slug: "x", destination: "https://e.org/" };
    expect(await rep(await owner(body([l, l])))).toMatchObject({ created: 1, skipped: 1 });
  });
});

describe("N2: a file that does not say which links had a password", () => {
  const old = () => body([{ host: "a.test", slug: "s", destination: "https://e.org/x" }]);
  const o = (b: unknown, q = "") => imp("owner@example.com", b, q);
  it("a real run without confirmNoPasswords is 400 protected_unknown and writes nothing", async () => {
    const r = await o(old());
    expect([r.status, await r.json()]).toEqual([400, { error: "protected_unknown" }]);
    expect(await count("links")).toBe(0);
    expect(await count("domains")).toBe(0);
  });
  it("the dry run still answers (the client shows the warning)", async () => {
    expect((await o(old(), "?dryRun=1")).status).toBe(200);
  });
  it("with confirmNoPasswords: true it imports", async () => {
    const r = await o({ ...old(), confirmNoPasswords: true });
    expect(r.status).toBe(200);
    expect(await count("links")).toBe(1);
  });
  it("a file whose rows carry protected (even all false) needs no confirmation", async () => {
    const b = body([{ host: "a.test", slug: "s", destination: "https://e.org/x", protected: false }]);
    expect((await o(b)).status).toBe(200);
  });
  it("one row without protected beside rows that carry it still needs the confirmation", async () => {
    const b = body([{ host: "a.test", slug: "s", destination: "https://e.org/x", protected: false }, { host: "a.test", slug: "t", destination: "https://e.org/y" }]);
    const r = await o(b);
    expect([r.status, await r.json()]).toEqual([400, { error: "protected_unknown" }]);
    expect(await count("links")).toBe(0);
  });
  it("a domains-only request needs no confirmation", async () => {
    expect((await o(body([], [D("only.test")]))).status).toBe(200);
  });
});

// S8 R12: `data` imports; a non-owner's import is refused before any write if it would create a domain without
// domains.manage, or write onto a domain the person cannot use (or change one they cannot manage).
describe("import by permission (S8 R12)", () => {
  const dm = (id: string, host: string, type: string, status = "active", owner = "uo") =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,1)", id, host, type, status, owner);
  const as = (b: unknown, q = "") => imp("d@example.com", { confirmNoPasswords: true, ...(b as object) }, q);
  const L = (host: string | null, slug: string) => ({ host, slug, destination: `https://example.org/${slug}` });
  const nothing = async () => expect([await count("domains"), await count("links"), await count("slug_locks"), await count("audit_log")]).toEqual([4, 0, 0, 0]);
  beforeEach(async () => {
    await run("DELETE FROM roles WHERE builtin = 0");
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('dt','Data','[\"data\"]',0,1,1), ('dd','Data and domains','[\"data\",\"domains.manage\"]',0,1,1)");
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('ud','d@example.com','member','dt','active',1)");
    await dm("dmain", "main.example", "main");
    await dm("dsh", "shared.example", "shared");
    await dm("doff", "off.example", "main", "disabled");
    await dm("dpriv", "mine.example", "private", "active", "ud");
  });

  it("a data role imports links onto the main domain and its own private domain", async () => {
    const r = await as(body([L(null, "a"), L("mine.example", "b")]));
    expect(r.status).toBe(200);
    expect(await rep(r)).toMatchObject({ created: 2, conflicts: [], domainsCreated: [] });
    expect(await all("SELECT slug, created_by FROM links ORDER BY slug")).toEqual([{ slug: "a", created_by: "ud" }, { slug: "b", created_by: "ud" }]);
    expect(await all("SELECT actor_id FROM audit_log WHERE action = 'import.run'")).toEqual([{ actor_id: "ud" }]);
  });

  it("refused 403 with nothing written: a new domain without domains.manage, an unusable or disabled domain, a redirect on a domain it cannot manage", async () => {
    for (const b of [body([L("new.example", "a")]), body([], [D("new.example")]), body([L("shared.example", "a")]), body([L("off.example", "a")]),
      body([L(null, "a")], [D("main.example", "https://example.org/home")]), body([L(null, "a"), L("new.example", "b")])]) {
      for (const q of ["", "?dryRun=1"]) {
        const r = await as(b, q);
        expect([q, r.status, await r.json()]).toEqual([q, 403, { error: "forbidden" }]);
      }
    }
    await nothing();
  });

  it("a member of the shared domain imports onto it; data with domains.manage creates domains", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dsh','ud')");
    expect(await rep(await as(body([L("shared.example", "s")])))).toMatchObject({ created: 1 });
    await run("UPDATE users SET role_id = 'dd' WHERE id = 'ud'");
    const r = await as(body([L("new.example", "n")], [D("main.example", "https://example.org/home")]));
    expect(r.status).toBe(200);
    expect(await rep(r)).toMatchObject({ created: 1, domainsCreated: ["new.example"] });
    expect(await all("SELECT type, status, owner_id FROM domains WHERE host = 'new.example'")).toEqual([{ type: "private", status: "active", owner_id: "ud" }]);
    expect(await all("SELECT bare_redirect FROM domains WHERE id = 'dmain'")).toEqual([{ bare_redirect: "https://example.org/home" }]);
  });

  it("a member without data gets 403 before the body is read", async () => {
    const r = await imp("m@example.com", "not json");
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
  });

  it("data lost between the checks and the write: 403 and nothing written", async () => {
    const restore = beforeBatch(2, () => run("UPDATE roles SET perms = '[]' WHERE id = 'dt'"));
    let r: Response;
    try { r = await as(body([L(null, "a"), L("mine.example", "b")])); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    await nothing();
  });

  it("domains.manage lost before the write: no domain is created", async () => {
    await run("UPDATE users SET role_id = 'dd' WHERE id = 'ud'");
    const restore = beforeBatch(2, () => run("UPDATE roles SET perms = '[\"data\"]' WHERE id = 'dd'"));
    let r: Response;
    try { r = await as(body([L("new.example", "n")])); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    await nothing();
  });

  it("domains.manage lost before a chunk that adds a domain and a link on an existing one: nothing in that chunk lands", async () => {
    await run("UPDATE users SET role_id = 'dd' WHERE id = 'ud'");
    const restore = beforeBatch(2, () => run("UPDATE roles SET perms = '[\"data\"]' WHERE id = 'dd'"));
    let r: Response;
    try { r = await as(body([L("new.example", "n"), L(null, "a")])); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    await nothing();
  });

  it("membership of a shared domain lost before the write: its empty redirect is not filled", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dsh','ud')");
    await run("UPDATE users SET role_id = 'dd' WHERE id = 'ud'");
    const restore = beforeBatch(2, () => run("DELETE FROM domain_members"));
    try { await as(body([], [D("shared.example", "https://example.org/home")])); } finally { restore(); }
    expect(await all("SELECT bare_redirect FROM domains WHERE id = 'dsh'")).toEqual([{ bare_redirect: null }]);
  });

  it("membership lost before the write: no link or lock lands on the shared domain, each reported forbidden", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dsh','ud')");
    const restore = beforeBatch(2, () => run("DELETE FROM domain_members"));
    let r: Response;
    try { r = await as(body([L("shared.example", "s"), { ...L("shared.example", "t"), enabled: false }])); } finally { restore(); }
    expect(r.status).toBe(200);
    expect(await rep(r)).toMatchObject({ created: 0, conflicts: [{ host: "shared.example", slug: "s", reason: "forbidden" }, { host: "shared.example", slug: "t", reason: "forbidden" }] });
    expect([await count("links"), await count("slug_locks")]).toEqual([0, 0]);
  });

  it("domains.manage fills an empty redirect on a usable shared domain it does not own", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dsh','ud')");
    await run("UPDATE users SET role_id = 'dd' WHERE id = 'ud'");
    const r = await as(body([], [D("shared.example", "https://example.org/home")]));
    expect(r.status).toBe(200);
    expect(await all("SELECT bare_redirect FROM domains WHERE id = 'dsh'")).toEqual([{ bare_redirect: "https://example.org/home" }]);
  });
});
