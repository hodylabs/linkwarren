import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SHARES } from "../src/api/shares";
import { sha256Hex } from "../src/session";
import { dash } from "./helpers/access";
import { call, pathEnv } from "./helpers/path";
import { signedIn, withCookie } from "./helpers/session";

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();

beforeEach(async () => {
  e.AUTH_MODE = "app";
  await env.DB.batch(
    ["share_links", "audit_log", "auth_limits", "clicks_daily", "clicks_daily_dim", "analytics_state", "links", "slug_locks", "domain_members", "domains", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});
afterEach(() => { e.AUTH_MODE = origMode; });

/** Owner o; member m (creator of lM on the main domain); member x (no rights on lM); private domain dP owned by x. */
async function fixture() {
  const o = await signedIn("o@example.com", { role: "owner" }), m = await signedIn("m@example.com"), x = await signedIn("x@example.com");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dM','main.example.com','main','active',?,1),('dP','p.example.com','private','active',?,1),('dO','other.example.com','main','active',?,1)", o.user.id, x.user.id, o.user.id);
  await run("INSERT INTO links (id,domain_id,slug,slug_key,url,name,created_by,updated_by,created_at,updated_at) VALUES ('lM','dM','spring','spring','https://example.com/','<script>x</script>',?,?,1,1),('lP','dP','priv','priv','https://example.com/',NULL,?,?,1,1)", m.user.id, m.user.id, x.user.id, x.user.id);
  const today = new Date().toISOString().slice(0, 10);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through', ?)", today);
  await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,'lM','dM','spring',3,4)", today);
  await run("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES (?,'lM','dM','referrer','<img src=x>',4)", today);
  return { o, m, x };
}
const json = (cookie: string, method: string, body?: unknown) =>
  withCookie(cookie, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const create = (cookie: string, scope: string, id: string) => dash("/api/shares", json(cookie, "POST", { scope, id }));
const urlOf = async (r: Response) => ((await r.json()) as { url: string }).url;
const page = (url: string, ip = "198.51.100.7") => dash(new URL(url).pathname, { headers: { "cf-connecting-ip": ip } });

describe("share API", () => {
  it("the link's creator makes a share: the URL once, only the hash stored, audited without the token", async () => {
    const { m } = await fixture();
    const r = await create(m.cookie, "link", "lM");
    expect(r.status).toBe(201);
    const url = await urlOf(r);
    const token = /^https:\/\/dash\.test\/share\/([A-Za-z0-9_-]{43})$/.exec(url)![1]!;
    const row = (await env.DB.prepare("SELECT token_hash, domain_id FROM share_links").first<{ token_hash: string; domain_id: string }>())!;
    expect(row).toEqual({ token_hash: await sha256Hex(token), domain_id: "dM" });
    const list = await (await dash("/api/shares?link=lM", withCookie(m.cookie))).text();
    expect(list).not.toContain(token);
    expect(list).not.toContain(row.token_hash);
    expect(JSON.parse(list).items).toHaveLength(1);
    const audit = (await env.DB.prepare("SELECT action, target_type, target_id, detail FROM audit_log WHERE action LIKE 'share.%'").all()).results;
    expect(audit).toMatchObject([{ action: "share.create", target_type: "link", target_id: "lM" }]);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("someone who cannot edit the link is refused; a link on a domain they cannot use is not found", async () => {
    const { x, m, o } = await fixture();
    expect((await create(x.cookie, "link", "lM")).status).toBe(403);
    expect((await dash("/api/shares?link=lM", withCookie(x.cookie))).status).toBe(403);
    expect((await create(m.cookie, "link", "lP")).status).toBe(404);
    expect((await create(m.cookie, "link", "nope")).status).toBe(404);
    expect((await create(o.cookie, "link", "lM")).status).toBe(201); // the owner edits any link
    const prev = (await env.DB.prepare("SELECT perms FROM roles WHERE id = 'member'").first<{ perms: string }>())!.perms;
    await run("UPDATE roles SET perms = json_insert(perms, '$[#]', 'links.editAny') WHERE id = 'member'");
    try {
      expect((await create(x.cookie, "link", "lM")).status).toBe(201);
    } finally {
      await run("UPDATE roles SET perms = ? WHERE id = 'member'", prev);
    }
  });

  it("domain shares need domain management: the domain's owner or domains.manage", async () => {
    const { x, m, o } = await fixture();
    expect((await create(m.cookie, "domain", "dM")).status).toBe(403);
    expect((await create(m.cookie, "domain", "dP")).status).toBe(404);
    expect((await create(x.cookie, "domain", "dP")).status).toBe(201);
    expect((await create(o.cookie, "domain", "dM")).status).toBe(201);
  });

  it("revoke needs the same right; afterwards the page is 404 and the revoke is audited", async () => {
    const { m, x } = await fixture();
    const r = await create(m.cookie, "link", "lM");
    const { id, url } = (await r.json()) as { id: string; url: string };
    expect((await page(url)).status).toBe(200);
    expect((await dash(`/api/shares/${id}`, json(x.cookie, "DELETE"))).status).toBe(403);
    expect((await dash(`/api/shares/${id}`, json(m.cookie, "DELETE"))).status).toBe(204);
    expect((await dash(`/api/shares/${id}`, json(m.cookie, "DELETE"))).status).toBe(404);
    expect((await page(url)).status).toBe(404);
    expect((await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'share.%' ORDER BY id").all()).results.map((a) => a.action)).toEqual(["share.create", "share.revoke"]);
  });

  it(`at most ${MAX_SHARES} active shares per link; strict bodies`, async () => {
    const { m } = await fixture();
    for (let i = 0; i < MAX_SHARES; i++) expect((await create(m.cookie, "link", "lM")).status).toBe(201);
    const r = await create(m.cookie, "link", "lM");
    expect([r.status, await r.json()]).toEqual([409, { error: "share_limit" }]);
    expect((await dash("/api/shares", json(m.cookie, "POST", { scope: "link", id: "lM", token: "x" }))).status).toBe(400);
    expect((await dash("/api/shares", withCookie(m.cookie))).status).toBe(400);
  });
});

describe("share page", () => {
  it("shows aggregates only, escaped, with noindex, a short private cache and no referrer", async () => {
    const { m } = await fixture();
    const r = await page(await urlOf(await create(m.cookie, "link", "lM")));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(r.headers.get("cache-control")).toBe("private, max-age=60");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("main.example.com/spring");
    expect(html).toMatch(/<b>7<\/b><small>clicks/);
    expect(html).toContain("Top referrers");
    expect(html).toContain('<svg class="chart"'); // the daily line, as markup (no script, no image)
  });

  it("lineChart draws a line and a closed fill, and nothing for fewer than two days", async () => {
    const { lineChart } = await import("../src/share");
    expect(lineChart([3])).toBe("");
    const svg = lineChart([0, 2, 4]);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain(" Z\"");
    expect(svg).toContain('aria-label="Clicks per day, highest 4"');
  });

  it("every failure is the same 404: bad shape, unknown, creator disabled, link deleted, link moved", async () => {
    const { m } = await fixture();
    const url = await urlOf(await create(m.cookie, "link", "lM"));
    const body404 = async (p: string) => { const r = await dash(p); return [r.status, r.headers.get("cache-control"), await r.text()]; };
    const unknown = await body404(`/share/${"A".repeat(43)}`);
    expect(unknown[0]).toBe(404);
    expect(await body404("/share/short")).toEqual(unknown);
    await run("UPDATE users SET status = 'disabled' WHERE id = ?", m.user.id);
    expect((await page(url)).status).toBe(404);
    await run("UPDATE users SET status = 'active' WHERE id = ?", m.user.id);
    expect((await page(url)).status).toBe(200);
    await run("UPDATE links SET domain_id = 'dO' WHERE id = 'lM'");
    expect((await page(url)).status).toBe(404);
    await run("UPDATE links SET domain_id = 'dM' WHERE id = 'lM'");
    await run("DELETE FROM links WHERE id = 'lM'");
    expect((await page(url)).status).toBe(404);
  });

  it("a move revokes the link's share pages for good: moving it back does not wake them; a refused move revokes nothing", async () => {
    const { o } = await fixture();
    const url = await urlOf(await create(o.cookie, "link", "lM"));
    const move = (domainId: string) => dash("/api/links/bulk", json(o.cookie, "POST", { action: "move", ids: ["lM"], domainId, oldAddress: "forward" }));
    // Refused: the slug is taken on the target, so nothing moves and the share stays.
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('lT','dO','spring','spring','https://example.com/',?,?,1,1)", o.user.id, o.user.id);
    const refused = (await (await move("dO")).json()) as { results: { ok: boolean }[] };
    expect(refused.results[0]!.ok).toBe(false);
    expect((await page(url)).status).toBe(200);
    await run("DELETE FROM links WHERE id = 'lT'");
    const moved = (await (await move("dO")).json()) as { results: { ok: boolean }[] };
    expect(moved.results[0]!.ok).toBe(true);
    expect((await page(url)).status).toBe(404);
    expect((await (await move("dM")).json() as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true);
    expect((await env.DB.prepare("SELECT domain_id FROM links WHERE id = 'lM'").first<{ domain_id: string }>())!.domain_id).toBe("dM");
    expect((await page(url)).status).toBe(404);
    expect((await env.DB.prepare("SELECT revoked_at FROM share_links").first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();
  });

  it("a domain share covers the domain; a deleted domain is 404", async () => {
    const { o } = await fixture();
    const url = await urlOf(await create(o.cookie, "domain", "dM"));
    const r = await page(url);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("main.example.com");
    await run("DELETE FROM links WHERE domain_id = 'dM'");
    await run("DELETE FROM domains WHERE id = 'dM'");
    expect((await page(url)).status).toBe(404);
  });

  it("is rate-limited per IP range", async () => {
    await fixture();
    for (let i = 0; i < 60; i++) expect((await page(`https://dash.test/share/${"B".repeat(43)}`, "203.0.113.9")).status).toBe(404);
    expect((await page(`https://dash.test/share/${"B".repeat(43)}`, "203.0.113.10")).status).toBe(429);
    expect((await page(`https://dash.test/share/${"B".repeat(43)}`, "198.51.100.1")).status).toBe(404);
  });

  it("path mode: served under the dashboard prefix, never as a short link at the root", async () => {
    const { m } = await fixture();
    const token = new URL(await urlOf(await create(m.cookie, "link", "lM"))).pathname.split("/").pop()!;
    const r = await call(`/dashboard/share/${token}`, undefined, pathEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("main.example.com/spring");
  });
});
