import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
});
