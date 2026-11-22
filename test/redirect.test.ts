import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { harness, IPHONE, seed as seedLink, visit } from "./helpers/redirect";
import { signedIn } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
let n = 0;

async function seed(o: Record<string, unknown> = {}) {
  const i = ++n;
  const host = `s${i}.test`;
  await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
  await run(
    "INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,notfound_redirect,noindex,case_sensitive,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    `d${i}`, host, "main", o.status ?? "active", "u1", o.bare ?? null, o.nf ?? null, o.noindex ?? 1, o.cs ?? 0, 1,
  );
  return { host, id: `d${i}` };
}
const addLink = (d: { id: string }, slug: string, o: Record<string, unknown> = {}) =>
  run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    `l${++n}`, d.id, slug, slug.toLowerCase(), o.url ?? "https://x.com/a?b=1", o.code ?? 302,
    o.starts ?? null, o.expires ?? null, o.pass ?? 1, "u1", "u1", 1, 1,
  );
const get = (host: string, path: string, init?: RequestInit) =>
  exports.default.fetch(`https://${host}${path}`, init);
const now = () => Math.floor(Date.now() / 1000);

describe("redirect", () => {
  it("302 with headers, noindex on by default", async () => {
    const d = await seed();
    await addLink(d, "spring");
    const r = await get(d.host, "/Spring", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://x.com/a?b=1");
    expect(r.headers.get("cache-control")).toBe("private, max-age=0");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("no X-Robots-Tag when noindex=0; 301 when link says so", async () => {
    const d = await seed({ noindex: 0 });
    await addLink(d, "s", { code: 301 });
    const r = await get(d.host, "/s", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("x-robots-tag")).toBeNull();
  });

  it("pass_query appends or drops", async () => {
    const d = await seed();
    await addLink(d, "on");
    await addLink(d, "off", { pass: 0 });
    expect((await get(d.host, "/on?ref=qr", { redirect: "manual" })).headers.get("location")).toBe("https://x.com/a?b=1&ref=qr");
    expect((await get(d.host, "/off?ref=qr", { redirect: "manual" })).headers.get("location")).toBe("https://x.com/a?b=1");
  });

  it("unknown slug: notfound_redirect or built-in 404; bare path likewise", async () => {
    const a = await seed({ nf: "https://nf.test/", bare: "https://bare.test/" });
    const ra = await get(a.host, "/nope", { redirect: "manual" });
    expect([ra.status, ra.headers.get("location")]).toEqual([302, "https://nf.test/"]);
    const rb = await get(a.host, "/", { redirect: "manual" });
    expect([rb.status, rb.headers.get("location")]).toEqual([302, "https://bare.test/"]);
    const b = await seed();
    expect((await get(b.host, "/nope")).status).toBe(404);
    expect((await get(b.host, "/")).status).toBe(404);
    expect((await get(b.host, "/a/b")).status).toBe(404);
    expect((await get(b.host, "/%E0%A4%A")).status).toBe(404);
  });

  it("not-live windows and locked slugs fall to not-found", async () => {
    const d = await seed();
    await addLink(d, "future", { starts: now() + 1000 });
    await addLink(d, "past", { expires: now() - 1000 });
    await addLink(d, "ok", { starts: now() - 10, expires: now() + 1000 });
    await run("INSERT INTO slug_locks (domain_id,slug_key,locked_at,locked_by) VALUES (?,?,?,?)", d.id, "gone", 1, "u1");
    expect((await get(d.host, "/future")).status).toBe(404);
    expect((await get(d.host, "/past")).status).toBe(404);
    expect((await get(d.host, "/gone")).status).toBe(404);
    expect((await get(d.host, "/ok", { redirect: "manual" })).status).toBe(302);
  });

  it("pending shows 200 page; disabled and unknown host 404", async () => {
    const p = await seed({ status: "pending" });
    await addLink(p, "x");
    const r = await get(p.host, "/x", { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("not active yet");
    const d = await seed({ status: "disabled" });
    await addLink(d, "x");
    expect((await get(d.host, "/x")).status).toBe(404);
    expect((await get("unknown.test", "/x")).status).toBe(404);
  });

  it("robots.txt and favicon", async () => {
    const a = await seed();
    const b = await seed({ noindex: 0 });
    expect(await (await get(a.host, "/robots.txt")).text()).toBe("User-agent: *\nDisallow: /");
    const rb = await get(b.host, "/robots.txt");
    expect(await rb.text()).toBe("User-agent: *\nAllow: /");
    expect(rb.headers.get("content-type")).toContain("text/plain");
    expect((await get(a.host, "/favicon.ico")).status).toBe(204);
  });

  it("a stored robots.txt or favicon.ico link redirects; the built-in reply is only the fallback", async () => {
    const d = await seed();
    await addLink(d, "robots.txt", { url: "https://x.com/robots" });
    await addLink(d, "favicon.ico", { url: "https://x.com/fav" });
    for (const [p, to] of [["/robots.txt", "https://x.com/robots"], ["/favicon.ico", "https://x.com/fav"]]) {
      const r = await get(d.host, p!, { redirect: "manual" });
      expect([r.status, r.headers.get("location")]).toEqual([302, to]);
    }
    const e = await seed({ nf: "https://nf.test/" });
    await addLink(e, "robots.txt", { expires: now() - 10 });
    expect(await (await get(e.host, "/robots.txt", { redirect: "manual" })).text()).toBe("User-agent: *\nDisallow: /");
    expect((await get(e.host, "/favicon.ico", { redirect: "manual" })).status).toBe(204);
  });

  it("HEAD matches GET without a body", async () => {
    const d = await seed();
    await addLink(d, "h");
    const r = await get(d.host, "/h", { method: "HEAD", redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://x.com/a?b=1");
    expect(await r.text()).toBe("");
    const nf = await get(d.host, "/zzz", { method: "HEAD" });
    expect(nf.status).toBe(404);
    expect(await nf.text()).toBe("");
  });

  it("second request is served from KV", async () => {
    const d = await seed();
    await addLink(d, "c");
    expect((await get(d.host, "/c", { redirect: "manual" })).status).toBe(302);
    await run("DELETE FROM links WHERE domain_id = ?", d.id);
    expect((await get(d.host, "/c", { redirect: "manual" })).status).toBe(302);
  });

  it("KV put failure does not break the redirect", async () => {
    const d = await seed();
    await addLink(d, "k");
    const orig = env.CACHE.put;
    let calls = 0;
    env.CACHE.put = (() => { calls++; return Promise.reject(new Error("429")); }) as typeof env.CACHE.put;
    try {
      expect((await get(d.host, "/k", { redirect: "manual" })).status).toBe(302);
      expect(calls).toBeGreaterThan(0);
    } finally {
      env.CACHE.put = orig;
    }
  });

  it("junk slug goes to not-found without a link cache key", async () => {
    const d = await seed({ nf: "https://nf.test/" });
    const r = await get(d.host, "/%3Cscript%3E", { redirect: "manual" });
    expect(r.headers.get("location")).toBe("https://nf.test/");
    expect((await env.CACHE.list({ prefix: `l2:${d.id}:` })).keys).toEqual([]);
  });

  it("keeps the destination's existing query bytes", async () => {
    const d = await seed();
    await addLink(d, "q", { url: "https://x.com/a?q=a%20b" });
    expect((await get(d.host, "/q?ref=qr", { redirect: "manual" })).headers.get("location")).toBe("https://x.com/a?q=a%20b&ref=qr");
  });

  it("reserved-word slugs that are stored stay reachable", async () => {
    const d = await seed();
    await addLink(d, "app", { url: "https://x.com/app" });
    await addLink(d, "qr", { url: "https://x.com/qr" });
    for (const s of ["app", "qr"]) {
      const r = await get(d.host, `/${s}`, { redirect: "manual" });
      expect([r.status, r.headers.get("location")]).toEqual([302, `https://x.com/${s}`]);
    }
  });

  it("short hosts never emit Set-Cookie, even for a request carrying a valid session cookie (app mode)", async () => {
    const e = env as { AUTH_MODE?: string };
    const orig = e.AUTH_MODE;
    e.AUTH_MODE = "app";
    try {
      const { cookie } = await signedIn("sc@example.com");
      const d = await seed();
      await addLink(d, "c1");
      const b = await seed({ bare: "https://bare.test/" });
      for (const [host, path] of [[d.host, "/c1"], [d.host, "/nope"], [d.host, "/"], [b.host, "/"]] as const) {
        const r = await get(host, path, { redirect: "manual", headers: { cookie } });
        expect(r.status).not.toBe(500);
        expect(r.headers.get("set-cookie")).toBeNull();
      }
    } finally {
      e.AUTH_MODE = orig;
    }
  });
});

describe("redirect rules (S5)", () => {
  const routes = [
    { countries: ["CA"], devices: [], url: "https://ca.test/" },
    { countries: [], devices: ["mobile"], url: "https://m.test/" },
  ];
  const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const loc = (r: Response) => r.headers.get("location");

  it("country route by cf.country (lower case too), device route by UA, else the main URL", async () => {
    const d = await seedLink({ routes });
    const h = harness();
    expect(loc(await h.go(d.host, "/spring", { cf: { country: "CA" }, headers: { "user-agent": DESKTOP } }))).toBe("https://ca.test/");
    expect(loc(await h.go(d.host, "/spring", { cf: { country: "ca" }, headers: { "user-agent": DESKTOP } }))).toBe("https://ca.test/");
    expect(loc(await h.go(d.host, "/spring", { cf: { country: "DE" }, headers: { "user-agent": IPHONE } }))).toBe("https://m.test/");
    expect(loc(await h.go(d.host, "/spring", { headers: { "user-agent": DESKTOP } }))).toBe("https://dest.test/x");
  });

  it("qr marker stripped before pass-through; pass-through off drops the query", async () => {
    const on = await seedLink({ routes });
    const off = await seedLink({ routes, pass: 0 });
    const h = harness();
    expect(loc(await h.go(on.host, "/spring?lw=qr&ref=1", visit()))).toBe("https://ca.test/?ref=1");
    expect(loc(await h.go(off.host, "/spring?lw=qr&ref=1", visit()))).toBe("https://ca.test/");
    expect(h.points.map((p) => p.blobs?.[6])).toEqual(["qr", "qr"]);
    await h.go(on.host, "/spring?ref=1", visit());
    expect(h.points[2].blobs?.[6]).toBe("typed");
    // The routed destination is never stored in the click.
    expect(JSON.stringify(h.points)).not.toMatch(/ca\.test/);
  });

  it("method gate: PUT is 405 Allow GET, HEAD; POST on an unprotected link is 405; HEAD redirects", async () => {
    const d = await seedLink({ routes });
    const h = harness();
    const put = await h.go(d.host, "/spring", { ...visit(), method: "PUT" });
    expect([put.status, put.headers.get("allow"), loc(put)]).toEqual([405, "GET, HEAD", null]);
    expect(put.headers.get("content-type")).toMatch(/^text\/plain/);
    const post = await h.go(d.host, "/spring", { ...visit(), method: "POST" });
    expect([post.status, post.headers.get("allow"), loc(post)]).toEqual([405, "GET, HEAD", null]);
    const head = await h.go(d.host, "/spring", { ...visit(), method: "HEAD" });
    expect([head.status, loc(head)]).toEqual([302, "https://ca.test/"]);
    expect(h.points).toHaveLength(0);
  });

  it("bare domain and not-found paths accept only GET and HEAD", async () => {
    const d = await seedLink();
    const h = harness();
    for (const path of ["/", "/nope", "/robots.txt"]) {
      const r = await h.go(d.host, path, { ...visit(), method: "POST" });
      expect([path, r.status, r.headers.get("allow")]).toEqual([path, 405, "GET, HEAD"]);
    }
    expect((await h.go(d.host, "/", { ...visit(), method: "HEAD" })).status).toBe(302);
  });

  it("a password-protected link never redirects, sets no cookie and records nothing", async () => {
    const d = await seedLink({ routes, password: "pbkdf2-sha256$1000$c2FsdA$aGFzaA" });
    const h = harness();
    for (const method of ["GET", "HEAD", "POST"]) {
      const r = await h.go(d.host, "/spring?lw=qr", { ...visit(), method });
      expect(r.status).not.toBeLessThan(400);
      expect(loc(r)).toBeNull();
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(await r.text()).not.toMatch(/dest\.test|ca\.test|m\.test/);
    }
    expect(h.points).toHaveLength(0);
  });
});
