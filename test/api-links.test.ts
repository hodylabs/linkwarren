import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const audits = async (action: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = ?", action))!.n;

const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const post = (who: string, body: Record<string, unknown>) => call(who, "POST", "/api/links", body);

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  const dom = (id: string, host: string, type: string, status: string, owner: string, cs = 0) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES (?,?,?,?,?,?,1)", id, host, type, status, owner, cs);
  await dom("dm", "go.test", "main", "active", "uo");
  await dom("ds", "shared.test", "shared", "active", "uo");
  await dom("dp", "priv.test", "private", "pending", "ua");
  await dom("dc", "case.test", "main", "active", "uo", 1);
});

const mk = async (who: string, slug: string, extra: Record<string, unknown> = {}, domainId = "dm") => {
  const r = await post(who, { domainId, slug, url: "https://x.com/a", ...extra });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string };
};

describe("create", () => {
  it("member creates on the main domain: 201, camelCase row, one link.create audit", async () => {
    const r = await post("a", { domainId: "dm", slug: "Spring", url: "https://x.com/a?b=1" });
    expect(r.status).toBe(201);
    const l = (await r.json()) as Record<string, unknown>;
    expect(l).toMatchObject({ domainId: "dm", slug: "Spring", slugKey: "spring", url: "https://x.com/a?b=1", redirectCode: 302, passQuery: true, createdBy: "ua" });
    expect(await audits("link.create")).toBe(1);
  });

  it("stores the normalized href, not the raw input", async () => {
    const l = (await (await post("a", { domainId: "dm", slug: "n", url: "HTTPS://Example.COM" })).json()) as { url: string };
    expect(l.url).toBe("https://example.com/");
  });

  it("403 on an unshared shared domain, 201 once a member", async () => {
    const r = await post("a", { domainId: "ds", slug: "s", url: "https://x.com" });
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds','ua')");
    expect((await post("a", { domainId: "ds", slug: "s", url: "https://x.com" })).status).toBe(201);
  });

  it("201 on own pending private domain and the redirect says not active yet", async () => {
    expect((await post("a", { domainId: "dp", slug: "p", url: "https://x.com" })).status).toBe(201);
    const r = await exports.default.fetch("https://priv.test/p", { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/not active yet/i);
    expect((await post("b", { domainId: "dp", slug: "q", url: "https://x.com" })).status).toBe(403);
  });

  it("404 for an unknown domain", async () => {
    expect((await post("a", { domainId: "nope", slug: "s", url: "https://x.com" })).status).toBe(404);
  });

  it("409 taken for a duplicate in any case on a case-insensitive domain; case-sensitive allows both", async () => {
    await mk("a", "spring");
    const r = await post("b", { domainId: "dm", slug: "SPRING", url: "https://y.com" });
    expect([r.status, await r.json()]).toEqual([409, { error: "taken" }]);
    await mk("a", "Fall", {}, "dc");
    await mk("a", "fall", {}, "dc");
  });

  it("400 reserved, including domain-specific reserved words", async () => {
    const r = await post("a", { domainId: "dm", slug: "Admin", url: "https://x.com" });
    expect([r.status, await r.json()]).toEqual([400, { error: "reserved" }]);
    await run("UPDATE domains SET reserved_extra = '[\"promo\"]' WHERE id = 'dm'");
    expect((await post("a", { domainId: "dm", slug: "promo", url: "https://x.com" })).status).toBe(400);
  });

  for (const [slug, reason] of [["", "empty"], ["a b", "charset"], [".hid", "leading_dot"], ["x".repeat(65), "slug_too_long"]] as const)
    it(`400 ${reason} for slug ${JSON.stringify(slug).slice(0, 12)}`, async () => {
      const r = await post("a", { domainId: "dm", slug, url: "https://x.com" });
      expect([r.status, await r.json()]).toEqual([400, { error: reason }]);
    });

  const hostile: [string, string][] = [
    ["javascript:alert(1)", "scheme"], ["data:text/html,hi", "scheme"], ["https://user:pw@x.com", "userinfo"],
    ["/relative/path", "not_url"], ["https://go.test/other", "loop"], ["https://GO.test:443/x", "loop"],
    ["https://shared.test/x", "loop"], [`https://x.com/${"a".repeat(2100)}`, "url_too_long"],
  ];
  for (const [url, reason] of hostile)
    it(`400 ${reason} for destination ${url.slice(0, 30)}`, async () => {
      const r = await post("a", { domainId: "dm", slug: "h", url });
      expect([r.status, await r.json()]).toEqual([400, { error: reason }]);
      expect(await one("SELECT 1 FROM links")).toBeNull();
    });

  it("rejects an href that grows past 2048 after normalization", async () => {
    const r = await post("a", { domainId: "dm", slug: "g", url: `https://x.com/${"é".repeat(1100)}` });
    expect([r.status, await r.json()]).toEqual([400, { error: "url_too_long" }]);
  });

  it("strict body: unknown keys, bad redirectCode, bad times, expiresAt <= startsAt all 400", async () => {
    const base = { domainId: "dm", slug: "v", url: "https://x.com" };
    for (const extra of [{ evil: 1 }, { redirectCode: 307 }, { startsAt: 1.5 }, { startsAt: "1" }, { startsAt: 100, expiresAt: 100 }, { startsAt: 100, expiresAt: 50 }])
      expect((await post("a", { ...base, ...extra })).status).toBe(400);
    expect((await post("a", { ...base, startsAt: 100, expiresAt: 200, redirectCode: 301, passQuery: false })).status).toBe(201);
  });

  it("401 without a token", async () => {
    expect((await dash("/api/links", { method: "POST" })).status).toBe(401);
  });
});

describe("delete, locks and takeover", () => {
  it("delete by A, re-create by B is 409 locked, owner releases, re-create 201; audits recorded", async () => {
    const l = await mk("a", "gone");
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(204);
    expect(await one("SELECT 1 FROM slug_locks WHERE domain_id='dm' AND slug_key='gone'")).not.toBeNull();
    for (const who of ["b", "a", "owner"]) {
      const r = await post(who, { domainId: "dm", slug: "GONE", url: "https://y.com" });
      expect([r.status, await r.json()]).toEqual([409, { error: "locked" }]);
    }
    expect((await call("a", "DELETE", "/api/locks/dm/gone")).status).toBe(403);
    expect((await call("owner", "DELETE", "/api/locks/dm/gone")).status).toBe(204);
    expect((await call("owner", "DELETE", "/api/locks/dm/gone")).status).toBe(404);
    expect((await post("b", { domainId: "dm", slug: "gone", url: "https://y.com" })).status).toBe(201);
    expect([await audits("link.delete"), await audits("lock.release")]).toEqual([1, 1]);
  });

  it("lock release audits every deleted key once", async () => {
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dm','Dup',1,'uo'),('dm','dup',1,'uo')");
    const [a, b] = await Promise.all([call("owner", "DELETE", "/api/locks/dm/dup"), call("owner", "DELETE", "/api/locks/dm/dup")]);
    expect([a.status, b.status].sort()).toEqual([204, 404]);
    expect(await audits("lock.release")).toBe(1);
    const d = JSON.parse((await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'lock.release'"))!.detail);
    expect(d.slugKeys.sort()).toEqual(["Dup", "dup"]);
  });

  it("lock release audits the keys it really deleted, including one added after the handler read them", async () => {
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dm','dup',1,'uo')");
    const restore = beforeBatch(1, () => run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES ('dm','DUP',1,'uo')"));
    try { expect((await call("owner", "DELETE", "/api/locks/dm/dup")).status).toBe(204); } finally { restore(); }
    expect(await one("SELECT 1 FROM slug_locks")).toBeNull();
    const d = JSON.parse((await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'lock.release'"))!.detail);
    expect([d.domainId, d.slugKeys.sort()]).toEqual(["dm", ["DUP", "dup"]]);
  });

  it("rejects a destination on the dashboard host", async () => {
    const r = await post("a", { domainId: "dm", slug: "dh", url: "https://dash.test/x" });
    expect([r.status, await r.json()]).toEqual([400, { error: "loop" }]);
  });

  it("a pending or disabled domain host is not a loop; once active it is", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dd','off.test','shared','disabled','uo',1)");
    expect((await post("a", { domainId: "dm", slug: "p1", url: "https://priv.test/x" })).status).toBe(201);
    expect((await post("a", { domainId: "dm", slug: "p2", url: "https://off.test/x" })).status).toBe(201);
    await run("UPDATE domains SET status = 'active' WHERE id = 'dp'");
    const r = await post("a", { domainId: "dm", slug: "p3", url: "https://priv.test/x" });
    expect([r.status, await r.json()]).toEqual([400, { error: "loop" }]);
  });

  it("the CNAME target is a loop", async () => {
    const r = await post("a", { domainId: "dm", slug: "e1", url: "https://edge.test/x" });
    expect([r.status, await r.json()]).toEqual([400, { error: "loop" }]);
  });

  it("a second delete of the same link is 404 and writes one audit row", async () => {
    const l = await mk("a", "twice");
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(204);
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(404);
    expect(await audits("link.delete")).toBe(1);
  });

  it("lock release normalizes case on a case-insensitive domain", async () => {
    const l = await mk("a", "gone2");
    await call("a", "DELETE", `/api/links/${l.id}`);
    expect((await call("owner", "DELETE", "/api/locks/dm/GONE2")).status).toBe(204);
    expect(await one("SELECT 1 FROM slug_locks")).toBeNull();
  });

  it("a member cannot edit or delete another member's link; the owner can", async () => {
    const l = await mk("a", "mine");
    expect((await call("b", "PATCH", `/api/links/${l.id}`, { url: "https://evil.com" })).status).toBe(403);
    expect((await call("b", "DELETE", `/api/links/${l.id}`)).status).toBe(403);
    expect((await call("owner", "PATCH", `/api/links/${l.id}`, { url: "https://ok.com" })).status).toBe(200);
    expect((await call("owner", "DELETE", `/api/links/${l.id}`)).status).toBe(204);
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(404);
  });

  it("a private-domain owner who is not instance owner can manage others' links there", async () => {
    await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dp','ub')");
    const l = await mk("b", "bl", {}, "dp");
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(204);
  });
});

describe("patch", () => {
  it("changes the url, audits, and the next redirect uses it despite a warm cache", async () => {
    const l = await mk("a", "sw");
    const first = await exports.default.fetch("https://go.test/sw", { redirect: "manual" });
    expect(first.headers.get("location")).toBe("https://x.com/a");
    const r = await call("a", "PATCH", `/api/links/${l.id}`, { url: "https://new.com/z", redirectCode: 301 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ url: "https://new.com/z", redirectCode: 301, slug: "sw" });
    const next = await exports.default.fetch("https://go.test/sw", { redirect: "manual" });
    expect([next.status, next.headers.get("location")]).toEqual([301, "https://new.com/z"]);
    expect(await audits("link.update")).toBe(1);
  });

  it("create invalidates a cached negative lookup", async () => {
    expect((await exports.default.fetch("https://go.test/fresh", { redirect: "manual" })).status).toBe(404);
    await mk("a", "fresh");
    expect((await exports.default.fetch("https://go.test/fresh", { redirect: "manual" })).status).toBe(302);
  });

  it("hostile destinations are rejected on PATCH too (loop, userinfo)", async () => {
    const l = await mk("a", "hp");
    for (const url of ["https://go.test/x", "https://shared.test/x", "https://u:p@x.com/"])
      expect((await call("a", "PATCH", `/api/links/${l.id}`, { url })).status).toBe(400);
  });

  it("domainId and slug are immutable (400); hostile url 400; window re-checked against stored values", async () => {
    const l = await mk("a", "im", { startsAt: 100, expiresAt: 200 });
    for (const bad of [{ slug: "other" }, { domainId: "ds" }, { url: "javascript:1" }, { expiresAt: 50 }, { startsAt: 300 }])
      expect((await call("a", "PATCH", `/api/links/${l.id}`, bad)).status).toBe(400);
    expect((await call("a", "PATCH", `/api/links/${l.id}`, { expiresAt: null })).status).toBe(200);
    expect((await call("a", "PATCH", "/api/links/nope", { url: "https://x.com" })).status).toBe(404);
  });
});

describe("patch concurrency", () => {
  it("two PATCHes from the same snapshot: the second gets 409 conflict and the first's change survives", async () => {
    const l = await mk("a", "pc");
    let first: Response | undefined;
    // The second PATCH has read the row; the first runs to completion before the second writes.
    const restore = beforeBatch(1, async () => { first = await call("a", "PATCH", `/api/links/${l.id}`, { url: "https://first.com/" }); });
    let second: Response;
    try { second = await call("a", "PATCH", `/api/links/${l.id}`, { passQuery: false }); } finally { restore(); }
    expect(first!.status).toBe(200);
    expect([second.status, await second.json()]).toEqual([409, { error: "conflict" }]);
    expect(await one("SELECT url, pass_query FROM links WHERE id = ?", l.id)).toEqual({ url: "https://first.com/", pass_query: 1 });
    expect(await audits("link.update")).toBe(1);
  });

  it("a PATCH of only passQuery leaves the url unchanged", async () => {
    const l = await mk("a", "pq");
    await run("UPDATE links SET url = 'https://elsewhere.com/' WHERE id = ?", l.id);
    // The handler reads the row it writes, so a field it was not asked to change is never rewritten from the request.
    const r = await call("a", "PATCH", `/api/links/${l.id}`, { passQuery: false });
    expect(r.status).toBe(200);
    expect(await one("SELECT url, pass_query FROM links WHERE id = ?", l.id)).toEqual({ url: "https://elsewhere.com/", pass_query: 0 });
  });

  it("a PATCH on a link deleted after the read is 404, not 409", async () => {
    const l = await mk("a", "pd");
    const restore = beforeBatch(1, () => run("DELETE FROM links WHERE id = ?", l.id));
    try { expect((await call("a", "PATCH", `/api/links/${l.id}`, { passQuery: false })).status).toBe(404); } finally { restore(); }
    expect(await audits("link.update")).toBe(0);
  });
});

describe("check", () => {
  it("returns each status", async () => {
    await mk("a", "taken1");
    const gone = await mk("a", "locked1");
    await call("a", "DELETE", `/api/links/${gone.id}`);
    const st = async (slug: string, dom = "dm") =>
      (await (await call("a", "GET", `/api/links/check?domain=${dom}&slug=${encodeURIComponent(slug)}`)).json()) as { status: string; reason?: string };
    expect(await st("free1")).toEqual({ status: "available" });
    expect(await st("TAKEN1")).toEqual({ status: "taken" });
    expect(await st("locked1")).toEqual({ status: "locked" });
    expect(await st("api")).toEqual({ status: "reserved" });
    expect(await st("a b")).toEqual({ status: "invalid", reason: "charset" });
    expect(await st("x".repeat(65))).toEqual({ status: "invalid", reason: "slug_too_long" });
    expect((await call("a", "GET", "/api/links/check?domain=ds&slug=x")).status).toBe(403);
  });
});

describe("me", () => {
  it("returns id, email, name and role", async () => {
    await run("UPDATE users SET name = 'Ann' WHERE id = 'ua'");
    expect(await (await call("a", "GET", "/api/me")).json()).toEqual({ id: "ua", email: EMAIL.a, name: "Ann", role: "member" });
  });
});

describe("list filters", () => {
  const ins = (id: string, by: string, at: number, s: number | null, x: number | null) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,starts_at,expires_at,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
      id, "dm", id, id, "https://x.com", s, x, by, by, at);
  const ids = async (who: string, q: string) =>
    ((await (await call(who, "GET", `/api/links?${q}`)).json()) as { items: { id: string }[] }).items.map((i) => i.id).sort();
  it("status filters by window; bogus is 400", async () => {
    const now = Math.floor(Date.now() / 1000);
    await ins("A", "ua", 10, null, null); await ins("B", "ua", 11, now + 3600, null);
    await ins("C", "ua", 12, null, now - 1); await ins("D", "ua", 13, null, now + 3600);
    expect(await ids("a", "status=active")).toEqual(["A", "D"]);
    expect(await ids("a", "status=scheduled")).toEqual(["B"]);
    expect(await ids("a", "status=expired")).toEqual(["C"]);
    const r = await call("a", "GET", "/api/links?status=bogus");
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_status" }]);
  });
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("status=%s is 400 bad_status, not a 500", async (s) => {
    const r = await call("a", "GET", `/api/links?status=${s}`);
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_status" }]);
  });
  it("mine=1 returns own links only and pages with the cursor", async () => {
    await ins("b1", "ub", 5, null, null);
    for (let i = 0; i < 51; i++) await ins(`m${String(i).padStart(2, "0")}`, "ua", 100 + i, null, null);
    expect(await ids("a", "mine=1&status=active")).toHaveLength(50);
    const p1 = (await (await call("a", "GET", "/api/links?mine=1")).json()) as { items: { id: string; createdBy: string }[]; next: string };
    expect(p1.items).toHaveLength(50);
    expect(p1.items.every((i) => i.createdBy === "ua")).toBe(true);
    const p2 = (await (await call("a", "GET", `/api/links?mine=1&cursor=${p1.next}`)).json()) as { items: { id: string }[]; next: string | null };
    expect(p2.items.map((i) => i.id)).toEqual(["m00"]);
    expect(p2.next).toBeNull();
  });
});

describe("list", () => {
  it("never returns links from domains the user cannot use; domain filter is gated", async () => {
    await mk("owner", "m1");
    await mk("owner", "s1", {}, "ds");
    await mk("a", "p1", {}, "dp");
    const list = async (who: string, q = "") => (await (await call(who, "GET", `/api/links${q}`)).json()) as { items: { slug: string }[]; next: string | null };
    expect((await list("b")).items.map((i) => i.slug)).toEqual(["m1"]);
    expect((await list("a")).items.map((i) => i.slug).sort()).toEqual(["m1", "p1"]);
    expect((await list("owner")).items).toHaveLength(3);
    expect((await call("b", "GET", "/api/links?domain=ds")).status).toBe(403);
    expect((await call("b", "GET", "/api/links?domain=zzz")).status).toBe(404);
  });

  it("paginates 50 per page by created_at desc, id desc", async () => {
    const stmts = Array.from({ length: 55 }, (_, i) =>
      env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(`id${String(i).padStart(3, "0")}`, "dm", `s${i}`, `s${i}`, "https://x.com", "ua", "ua", 1000 + Math.floor(i / 2), 1));
    await env.DB.batch(stmts);
    const p1 = (await (await call("a", "GET", "/api/links")).json()) as { items: { id: string }[]; next: string };
    expect(p1.items).toHaveLength(50);
    expect(p1.next).toMatch(/^\d+\.id\d+$/);
    const p2 = (await (await call("a", "GET", `/api/links?cursor=${p1.next}`)).json()) as { items: { id: string }[]; next: string | null };
    expect(p2.items).toHaveLength(5);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(55);
  });

  it("cursor survives deletion of the row it points at", async () => {
    await env.DB.batch(Array.from({ length: 55 }, (_, i) =>
      env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(`id${String(i).padStart(3, "0")}`, "dm", `s${i}`, `s${i}`, "https://x.com", "ua", "ua", 1000 + Math.floor(i / 2), 1)));
    const p1 = (await (await call("a", "GET", "/api/links")).json()) as { items: { id: string }[]; next: string };
    expect((await call("owner", "DELETE", `/api/links/${p1.items[49]!.id}`)).status).toBe(204);
    const p2 = (await (await call("a", "GET", `/api/links?cursor=${p1.next}`)).json()) as { items: unknown[]; next: string | null };
    expect(p2.items).toHaveLength(5);
  });

  it("bad cursor and over-long q are 400; owner lists everything without a domain filter", async () => {
    for (const cur of ["x", "abc.def", ".id", "5."])
      expect(((await call("a", "GET", `/api/links?cursor=${cur}`)).status)).toBe(400);
    const r = await call("a", "GET", `/api/links?q=${"a".repeat(201)}`);
    expect([r.status, await r.json()]).toEqual([400, { error: "q_too_long" }]);
    await mk("a", "own1", {}, "dp");
    await mk("owner", "own2");
    expect(((await (await call("owner", "GET", "/api/links")).json()) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("a member who can use 120 domains lists links across all of them (no bind cap)", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 120; i++) {
      stmts.push(env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'shared','active','uo',1)").bind(`x${i}`, `x${i}.test`));
      stmts.push(env.DB.prepare("INSERT INTO domain_members (domain_id,user_id) VALUES (?, 'ua')").bind(`x${i}`));
      stmts.push(env.DB.prepare("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,'s','s','https://x.com/','uo','uo',?,1)").bind(`lx${i}`, `x${i}`, 2000 + i));
    }
    await env.DB.batch(stmts);
    const seen = new Set<string>();
    let next: string | null = "";
    while (next !== null) {
      const r: Response = await call("a", "GET", `/api/links${next ? `?cursor=${next}` : ""}`);
      expect(r.status).toBe(200);
      const j = (await r.json()) as { items: { id: string }[]; next: string | null };
      j.items.forEach((i) => seen.add(i.id));
      next = j.next;
    }
    expect(seen.size).toBe(120);
    expect((await call("b", "GET", "/api/links")).status).toBe(200);
  });

  it("q is capped by D1's 50-byte LIKE pattern (with the % wrappers, after escaping, in UTF-8)", async () => {
    const st = async (q: string) => (await call("a", "GET", `/api/links?q=${encodeURIComponent(q)}`)).status;
    expect(await st("a".repeat(48))).toBe(200);
    const r = await call("a", "GET", `/api/links?q=${"a".repeat(49)}`);
    expect([r.status, await r.json()]).toEqual([400, { error: "q_too_long" }]);
    expect(await st("\u00e9".repeat(24))).toBe(200); // 48 bytes
    expect(await st("\u00e9".repeat(25))).toBe(400); // 25 chars, 50 bytes before wrappers
    expect(await st("%".repeat(24))).toBe(200); // escapes to 48 bytes
    expect(await st("%".repeat(25))).toBe(400);
  });

  it("q matches slug or url and treats % _ and backslash literally", async () => {
    await mk("a", "alpha", { url: "https://x.com/promo" });
    await mk("a", "be_ta", { url: "https://x.com/b" });
    await mk("a", "bexta", { url: "https://x.com/100%25" });
    const q = async (t: string) =>
      ((await (await call("a", "GET", `/api/links?q=${encodeURIComponent(t)}`)).json()) as { items: { slug: string }[] }).items.map((i) => i.slug).sort();
    expect(await q("alph")).toEqual(["alpha"]);
    expect(await q("promo")).toEqual(["alpha"]);
    expect(await q("e_t")).toEqual(["be_ta"]);
    expect(await q("%")).toEqual(["bexta"]);
    expect(await q("\\")).toEqual([]);
  });
});
