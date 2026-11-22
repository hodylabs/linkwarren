import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { harness, visit } from "./helpers/redirect";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const link = (id: string, domain: string, slug: string, url: string, o: { forwardTo?: string; hash?: string } = {}) =>
  run(
    `INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,pass_query,password_hash,routes,forward_to,created_by,updated_by,created_at,updated_at)
     VALUES (?,?,?,?,?,302,1,?,'[]',?,'u1','u1',1,1)`,
    id, domain, slug, slug.toLowerCase(), url, o.hash ?? null, o.forwardTo ?? null,
  );

beforeEach(async () => {
  await env.DB.batch(["links", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
  for (const [id, host] of [["fg", "fwd-go.test"], ["fa", "fwd-a.test"]])
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'main','active','u1',1)", id, host);
  await link("new", "fa", "spring", "https://dest.test/x");
  await link("pwl", "fa", "locked", "https://dest.test/p", { hash: "pbkdf2-sha256$10000$c2FsdA$aGFzaA" });
  await link("f1", "fg", "spring", "https://fwd-a.test/spring", { forwardTo: "new" });
  await link("f2", "fg", "locked", "https://fwd-a.test/locked", { forwardTo: "pwl" });
});

describe("forwarder redirect", () => {
  it("302 to the new short link, query byte for byte (lw=qr and + kept), no click; the new link then counts one QR click", async () => {
    const h = harness();
    const q = "?a=1+2&lw=qr&b=%20x";
    const r = await h.go("fwd-go.test", `/spring${q}`, visit());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://fwd-a.test/spring${q}`);
    expect(r.headers.get("cache-control")).toBe("private, max-age=0");
    expect(r.headers.get("strict-transport-security")).toBeNull();
    expect(h.points).toHaveLength(0);
    const n = await h.go("fwd-a.test", `/spring${q}`, visit());
    expect(n.status).toBe(302);
    expect(h.points).toHaveLength(1);
    expect(h.points[0]!.blobs![1]).toBe("new");
    expect(h.points[0]!.blobs![6]).toBe("qr");
  });

  it("without the marker the click on the new link is typed", async () => {
    const h = harness();
    const r = await h.go("fwd-go.test", "/spring", visit());
    expect(r.headers.get("location")).toBe("https://fwd-a.test/spring");
    await h.go("fwd-a.test", "/spring", visit());
    expect(h.points.map((p) => p.blobs![6])).toEqual(["typed"]);
  });

  it("HEAD works, POST is 405", async () => {
    const h = harness();
    const r = await h.go("fwd-go.test", "/spring?x=1", { method: "HEAD" });
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://fwd-a.test/spring?x=1"]);
    const p = await h.go("fwd-go.test", "/spring", { method: "POST", body: "password=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(p.status).toBe(405);
    expect(h.points).toHaveLength(0);
  });

  it("never shows the password form, even when the target has a password", async () => {
    const h = harness();
    const r = await h.go("fwd-go.test", "/locked", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://fwd-a.test/locked"]);
    const t = await h.go("fwd-a.test", "/locked", visit());
    expect(t.status).toBe(200);
    expect(await t.text()).toContain("password");
  });

  it("an old cached l2: entry without forwardTo still redirects normally (D10)", async () => {
    const old = {
      id: "old", domainId: "fg", slug: "legacy", slugKey: "legacy", url: "https://dest.test/old", redirectCode: 302,
      startsAt: null, expiresAt: null, passQuery: true, passwordHash: null, routes: [], createdBy: "u1", updatedBy: "u1", createdAt: 1, updatedAt: 1,
    };
    await env.CACHE.put("l2:fg:legacy", JSON.stringify(old));
    const h = harness();
    const r = await h.go("fwd-go.test", "/legacy", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/old"]);
    expect(h.points).toHaveLength(1);
  });
});
