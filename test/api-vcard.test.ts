// S9 vCard links through the dashboard API, /api/v1, bulk, import and MCP.
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { connectAgent, mcpCall } from "./helpers/oauth";
import { PHOTO_B64_MAX, VCARD_URL } from "../src/vcard";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com", b: "b@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5));
const CARD = { firstName: "Ada", lastName: "Lovelace", phones: [{ type: "work", number: "+1 555 0100" }], emails: ["ada@example.com"], photo: JPEG };
type L = { id: string; kind: string; url: string; redirectCode: number; vcard?: Record<string, unknown> };
const mkCard = async (who = "a", extra: Record<string, unknown> = {}) => {
  const r = await call(who, "POST", "/api/links", { domainId: "dm", slug: "ada", kind: "vcard", vcard: CARD, ...extra });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as L;
};
const fetchCard = (path = "/ada") => exports.default.fetch(`https://go.test${path}`, { redirect: "manual" });

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "tool_calls", "agent_connections", "links", "vcards", "slug_locks", "audit_log", "domain_members", "domains", "users"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"], ["ub", EMAIL.b, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, email, role);
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.test','main','active','uo',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('d2','two.test','main','active','uo',1)");
});

describe("create and read", () => {
  it("201 with kind vcard, the placeholder url and the checked card; read, list and the short link agree", async () => {
    const l = await mkCard("a", { redirectCode: 301, passQuery: false });
    expect(l).toMatchObject({ kind: "vcard", url: VCARD_URL, redirectCode: 302, vcard: { firstName: "Ada", org: "", photo: JPEG } });
    const got = (await (await call("a", "GET", `/api/links/${l.id}`)).json()) as L;
    expect(got.vcard).toEqual(l.vcard);
    const list = (await (await call("a", "GET", "/api/links")).json()) as { items: L[] };
    // Lists carry hasPhoto, never the photo; the single read above has it.
    expect(list.items[0]).toMatchObject({ kind: "vcard", vcard: { lastName: "Lovelace", hasPhoto: true } });
    expect(list.items[0]!.vcard).not.toHaveProperty("photo");
    await call("a", "PATCH", `/api/links/${l.id}`, { vcard: { ...CARD, photo: null } });
    const after = (await (await call("a", "GET", "/api/links")).json()) as { items: L[] };
    expect(after.items[0]!.vcard).toMatchObject({ hasPhoto: false });
    const r = await fetchCard();
    expect([r.status, r.headers.get("content-type")]).toEqual([200, "text/vcard; charset=utf-8"]);
    expect(await r.text()).toContain("FN:Ada Lovelace\r\n");
    // The audit names the kind, never the card's contents.
    const detail = (await one<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'link.create'"))!.detail;
    expect(JSON.parse(detail)).toMatchObject({ kind: "vcard", url: VCARD_URL });
    expect(detail).not.toContain("Lovelace");
  });

  it.each([
    [{ kind: "vcard" }, "invalid_body"],
    [{ vcard: CARD, url: "https://x.com" }, "invalid_body"],
    [{ kind: "vcard", vcard: CARD, url: "https://x.com" }, "vcard_url"],
    [{ kind: "vcard", vcard: CARD, password: "long enough pw" }, "vcard_rule"],
    [{ kind: "vcard", vcard: CARD, routes: [{ countries: ["CA"], url: "https://x.com" }] }, "vcard_rule"],
  ])("refuses %j with %s", async (extra, error) => {
    const r = await call("a", "POST", "/api/links", { domainId: "dm", slug: "x", ...extra });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, error]);
    expect(await one("SELECT 1 FROM links")).toBeNull();
  });

  it.each([
    [{ ...CARD, phones: new Array(11).fill({ type: "cell", number: "1" }) }, "phones"],
    [{ ...CARD, firstName: "x".repeat(101) }, "firstName"],
    [{ ...CARD, phones: [{ type: "fax", number: "1" }] }, "phones.0"],
    [{ ...CARD, extra: 1 }, "vcard"],
    [{ ...CARD, photo: "A".repeat(PHOTO_B64_MAX + 4) }, "photo"],
    [{ ...CARD, photo: btoa("<svg/>") }, "photo"],
    [{ ...CARD, websites: ["javascript:alert(1)"] }, "websites.0"],
    [{ photo: null }, "name"],
  ])("bad_vcard names the field (%#: %s)", async (vcard, field) => {
    const r = await call("a", "POST", "/api/links", { domainId: "dm", slug: "x", kind: "vcard", vcard });
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_vcard", field }]);
  });
});

describe("update", () => {
  it("a new card replaces the served file at once (cache purged)", async () => {
    const l = await mkCard();
    expect(await (await fetchCard()).text()).toContain("N:Lovelace;Ada;;;");
    const r = await call("a", "PATCH", `/api/links/${l.id}`, { vcard: { ...CARD, lastName: "Byron" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as L).vcard).toMatchObject({ lastName: "Byron" });
    expect(await (await fetchCard()).text()).toContain("N:Byron;Ada;;;");
  });

  it("refuses a url change, a password, routes, a kind change; a url link refuses a card", async () => {
    const l = await mkCard();
    for (const [body, error] of [[{ url: "https://x.com" }, "vcard_url"], [{ password: "long enough pw" }, "vcard_rule"],
      [{ routes: [{ devices: ["ios"], url: "https://x.com" }] }, "vcard_rule"], [{ kind: "url" }, "kind_change"]] as const) {
      const r = await call("a", "PATCH", `/api/links/${l.id}`, body);
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, error]);
    }
    // Harmless no-ops are fine: clearing nothing, the schedule.
    expect((await call("a", "PATCH", `/api/links/${l.id}`, { password: null, routes: [], startsAt: 1 })).status).toBe(200);
    const u = (await (await call("a", "POST", "/api/links", { domainId: "dm", slug: "u", url: "https://x.com" })).json()) as L;
    const r = await call("a", "PATCH", `/api/links/${u.id}`, { vcard: CARD });
    expect([r.status, await r.json()]).toEqual([400, { error: "not_vcard" }]);
  });

  it("permissions are the link rules: another member cannot edit it, the owner can", async () => {
    const l = await mkCard("a");
    expect((await call("b", "PATCH", `/api/links/${l.id}`, { vcard: CARD })).status).toBe(403);
    expect((await call("owner", "PATCH", `/api/links/${l.id}`, { vcard: CARD })).status).toBe(200);
  });

  it("delete removes the card and locks the slug", async () => {
    const l = await mkCard();
    expect((await call("a", "DELETE", `/api/links/${l.id}`)).status).toBe(204);
    expect(await one("SELECT 1 FROM vcards")).toBeNull();
    expect((await fetchCard()).status).toBe(404);
  });
});

describe("bulk", () => {
  it("copy carries the card to the new link; forward keeps it on the moved link", async () => {
    const l = await mkCard("owner");
    const c = await call("owner", "POST", "/api/links/bulk", { action: "move", ids: [l.id], domainId: "d2", oldAddress: "copy" });
    const copy = ((await c.json()) as { results: { link: L }[] }).results[0]!.link;
    // Bulk results are list-shaped: hasPhoto, never the photo.
    expect(copy).toMatchObject({ kind: "vcard", vcard: { firstName: "Ada", hasPhoto: true } });
    expect(copy.vcard).not.toHaveProperty("photo");
    expect((await one<{ n: number }>("SELECT COUNT(*) n FROM vcards"))!.n).toBe(2);
    const r = await exports.default.fetch("https://two.test/ada", { redirect: "manual" });
    expect([r.status, r.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="ada.vcf"']);
    // Forward: the old address forwards one hop to the new short link, which serves the card.
    await call("owner", "DELETE", `/api/links/${copy.id}`);
    await run("DELETE FROM slug_locks");
    const f = await call("owner", "POST", "/api/links/bulk", { action: "move", ids: [l.id], domainId: "d2", oldAddress: "forward" });
    expect(f.status).toBe(200);
    const old = await fetchCard();
    expect([old.status, old.headers.get("location")]).toEqual([302, "https://two.test/ada"]);
    expect((await exports.default.fetch("https://two.test/ada")).status).toBe(200);
  });

  it("a password is refused per link (vcard_rule); delete removes the card", async () => {
    const l = await mkCard("owner");
    const p = await call("owner", "POST", "/api/links/bulk", { action: "password", ids: [l.id], password: "long enough pw" });
    expect(((await p.json()) as { results: unknown[] }).results).toEqual([{ id: l.id, ok: false, error: "vcard_rule" }]);
    await call("owner", "POST", "/api/links/bulk", { action: "delete", ids: [l.id] });
    expect(await one("SELECT 1 FROM vcards")).toBeNull();
  });
});

describe("/api/v1, import and MCP", () => {
  it("/api/v1 creates and reads a card with a write key", async () => {
    const k = await call("a", "POST", "/api/keys", { name: "ci", write: true, del: false, domainIds: [], expiresInDays: 90 });
    const { secret } = (await k.json()) as { secret: string };
    const v1 = (method: string, path: string, body?: unknown) => exports.default.fetch(`https://dash.test/api/v1${path}`, {
      method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const r = await v1("POST", "/links", { domainId: "dm", slug: "ada", kind: "vcard", vcard: CARD });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as L;
    expect(await (await v1("GET", `/links/${id}`)).json()).toMatchObject({ kind: "vcard", vcard: { emails: ["ada@example.com"], photo: JPEG } });
    const found = ((await (await v1("GET", "/links?q=ada")).json()) as { items: L[] }).items[0]!;
    expect(found.vcard).toMatchObject({ hasPhoto: true });
    expect(found.vcard).not.toHaveProperty("photo");
    expect((await v1("PATCH", `/links/${id}`, { url: "https://x.com" })).status).toBe(400);
  });

  it("search matches a card by its name or organization, never by the placeholder url", async () => {
    const l = await mkCard("a");
    await call("a", "POST", "/api/links", { domainId: "dm", slug: "plain", url: "https://example.com/vcard" });
    const found = async (q: string) => ((await (await call("a", "GET", `/api/links?q=${q}`)).json()) as { items: L[] }).items.map((x) => x.id);
    expect(await found("lovelace")).toEqual([l.id]);
    expect(await found("invalid")).toEqual([]);
    expect((await found("vcard")).length).toBe(1); // only the url link whose destination has it
    expect(await found("vcard")).not.toContain(l.id);
  });

  it("import refuses the card placeholder as a live destination", async () => {
    const links = [{ host: null, slug: "ada", destination: VCARD_URL, enabled: true, startDate: null, endDate: null, protected: false }];
    const r = await call("owner", "POST", "/api/import", { mainHost: "go.test", domains: [], links });
    expect(await r.json()).toMatchObject({ created: 0, conflicts: [{ slug: "ada", reason: "invalid_destination" }] });
  });

  it("import creates a card link from a vcard row; a bad card is a conflict", async () => {
    const links = [
      { host: null, slug: "ada", destination: "ignored", enabled: true, startDate: null, endDate: null, protected: false, vcard: CARD },
      { host: null, slug: "bad", destination: "ignored", enabled: true, startDate: null, endDate: null, protected: false, vcard: { photo: btoa("<svg/>"), firstName: "x" } },
    ];
    const r = await call("owner", "POST", "/api/import", { mainHost: "go.test", domains: [], links });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ created: 1, conflicts: [{ slug: "bad", reason: "invalid_vcard" }] });
    expect(await one("SELECT kind, url FROM links WHERE slug = 'ada'")).toEqual({ kind: "vcard", url: VCARD_URL });
    expect(await (await fetchCard()).text()).toContain("EMAIL;TYPE=INTERNET:ada@example.com\r\n");
  });

  it("import: the same card again is skipped, a different card on the slug is a conflict", async () => {
    const row = (vcard: unknown) => ({ host: null, slug: "ada", destination: "x", enabled: true, startDate: null, endDate: null, protected: false, vcard });
    const imp = (vcard: unknown) => call("owner", "POST", "/api/import", { mainHost: "go.test", domains: [], links: [row(vcard)] });
    expect(await (await imp(CARD)).json()).toMatchObject({ created: 1 });
    expect(await (await imp(CARD)).json()).toMatchObject({ created: 0, skipped: 1, conflicts: [] });
    expect(await (await imp({ ...CARD, lastName: "Byron" })).json()).toMatchObject({ created: 0, skipped: 0, conflicts: [{ slug: "ada", reason: "exists" }] });
  });

  it("import reads only the requested cards' data and photos, never every card of the domain", async () => {
    const other = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 9, 9));
    await mkCard("owner");
    expect((await call("owner", "POST", "/api/links", { domainId: "dm", slug: "bob", kind: "vcard", vcard: { firstName: "Bob", photo: other } })).status).toBe(201);
    const real = env.DB.batch.bind(env.DB);
    let seen = "";
    vi.spyOn(env.DB, "batch").mockImplementation(async (s) => {
      const r = await real(s);
      seen += JSON.stringify(r);
      return r;
    });
    const row = { host: null, slug: "ada", destination: "x", enabled: true, startDate: null, endDate: null, protected: false, vcard: CARD };
    let r;
    try { r = await call("owner", "POST", "/api/import", { mainHost: "go.test", domains: [], links: [row] }); } finally { vi.restoreAllMocks(); }
    expect(await r.json()).toMatchObject({ created: 0, skipped: 1 });
    expect(seen).toContain(JPEG); // the requested card was compared by its photo
    expect(seen).not.toContain(other); // bob's photo was never read
  });

  it("import keeps every card in its link's batch across a batch boundary", async () => {
    // 97 plain links then cards: the 98-item batch would otherwise end on a card's link.
    const links = [
      ...Array.from({ length: 97 }, (_, i) => ({ host: null, slug: `p${i}`, destination: "https://example.com/", enabled: true, startDate: null, endDate: null, protected: false })),
      ...["c1", "c2"].map((slug) => ({ host: null, slug, destination: "x", enabled: true, startDate: null, endDate: null, protected: false, vcard: CARD })),
    ];
    const r = await call("owner", "POST", "/api/import", { mainHost: "go.test", domains: [], links });
    expect(await r.json()).toMatchObject({ created: 99 });
    expect((await one<{ n: number }>("SELECT COUNT(*) n FROM vcards"))!.n).toBe(2);
  });

  it("MCP get_link shows the kind and no photo; update_link cannot change a card's url", async () => {
    const l = await mkCard("a");
    const t = await connectAgent(EMAIL.a!, { write: true });
    const res = async (name: string, args: Record<string, unknown>) =>
      ((await mcpCall(t.accessToken, "tools/call", { name, arguments: args })).body as { result: { isError?: boolean; structuredContent: Record<string, any> } }).result;
    const g = await res("get_link", { id: l.id });
    expect(g.structuredContent).toMatchObject({ kind: "vcard", vcard: { firstName: "Ada", hasPhoto: true } });
    expect(g.structuredContent.vcard).not.toHaveProperty("photo");
    const s = await res("search_links", {});
    expect(s.structuredContent.items[0]).toMatchObject({ kind: "vcard", vcard: { hasPhoto: true } });
    const u = await res("update_link", { id: l.id, url: "https://x.com" });
    expect([u.isError, u.structuredContent]).toEqual([true, { error: "vcard_url", status: 400 }]);
    expect(await one("SELECT url FROM links WHERE id = ?", l.id)).toEqual({ url: VCARD_URL });
  });
});
