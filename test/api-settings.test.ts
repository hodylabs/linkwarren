import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare, type FakePerm } from "./helpers/cf";
import { signedIn, withCookie } from "./helpers/session";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const S = "/api/settings/cloudflare";
const ALL: FakePerm[] = ["zone_read", "dns_edit", "routes_edit", "ssl_edit"];
const STORED = "storedTOKEN_abc123";
const CAND = "candidateTOKEN_xyz789";
const zones = [{ id: "zsaas", name: "test", accountName: "Acme" }, { id: "z1", name: "example.com", accountName: "Acme" }];
const CF = { CF_API_TOKEN: STORED, CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw", CF_SAAS_ZONE_ID: "zsaas" };
const e = env as unknown as Record<string, string | undefined>;
const configure = (on = true) => { for (const [k, v] of Object.entries(CF)) e[k] = on ? v : undefined; };

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["settings", "audit_log", "links", "api_keys", "sessions", "domain_cf", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  configure();
});
afterEach(() => {
  configure(false);
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

async function dom(host: string, kind: string, cols: Record<string, string> = {}) {
  const id = `d-${host}`;
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'main','active','uo',1)", id, host);
  const k = Object.keys(cols);
  await run(`INSERT INTO domain_cf (domain_id,kind,updated_at${k.map((c) => "," + c).join("")}) VALUES (?,?,1${k.map(() => ",?").join("")})`, id, kind, ...Object.values(cols));
}

describe("access", () => {
  it("a member gets 403 forbidden on every route", async () => {
    const fake = installFakeCloudflare({ zones });
    for (const [m, p, b] of [["GET", S], ["POST", `${S}/check`, {}], ["POST", `${S}/check`, { token: CAND }], ["PATCH", S, { controlsEnabled: true }], ["POST", `${S}/setup`], ["POST", `${S}/resync`]] as const) {
      const r = await call("a", m, p, b);
      expect([m, p, r.status, await r.json()]).toEqual([m, p, 403, { error: "forbidden" }]);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("GET /api/settings/cloudflare", () => {
  it("not configured: no Cloudflare calls, everything off", async () => {
    configure(false);
    const fake = installFakeCloudflare({ zones });
    const r = await call("owner", "GET", S);
    expect(await r.json()).toEqual({ configured: false, outsideReady: false, accountName: null, cnameTarget: "edge.test", fallbackOrigin: null, hostnames: null, attachedCount: 0, controlsEnabled: false });
    expect(fake.calls).toEqual([]);
  });
  it("configured: account name, missing fallback origin, hostname usage, attached count, controls", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.hostnames.push({ id: "h1", hostname: "x.out.test", status: "active", ssl: { status: "active" } });
    await dom("a.example.com", "account", { route_id: "r1" });
    await dom("b.example.com", "account");
    await dom("x.out.test", "outside", { route_id: "r2" });
    await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('cf.controls','1',1,'uo')");
    const r = await call("owner", "GET", S);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({ configured: true, outsideReady: false, accountName: "Acme", cnameTarget: "edge.test", fallbackOrigin: "missing", hostnames: { used: 1, limit: 100 }, attachedCount: 1, controlsEnabled: true });
    expect(JSON.stringify(j)).not.toContain(STORED);
  });
  it("fallback origin pending, then active makes outside ready", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.fallbackOrigin = "edge.test";
    fake.state.fallbackStatus = "pending_deployment";
    expect(await (await call("owner", "GET", S)).json()).toMatchObject({ fallbackOrigin: "pending", outsideReady: false });
    fake.state.fallbackStatus = "active";
    expect(await (await call("owner", "GET", S)).json()).toMatchObject({ fallbackOrigin: "active", outsideReady: true });
    fake.state.fallbackOrigin = "origin.other.example"; // active, but someone else's: setup would refuse it
    expect(await (await call("owner", "GET", S)).json()).toMatchObject({ fallbackOrigin: "in_use", outsideReady: false });
  });
  it("Cloudflare failures leave those fields null instead of a 500", async () => {
    const fake = installFakeCloudflare({ zones });
    for (const re of [/^\/zones\/zsaas$/, /fallback_origin/, /custom_hostnames\?per_page/]) fake.failNext(re, 500);
    const r = await call("owner", "GET", S);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ configured: true, accountName: null, fallbackOrigin: null, hostnames: null });
  });
});

describe("POST /api/settings/cloudflare/check", () => {
  it("checks the stored token", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { [STORED]: { perms: ALL } } });
    const r = await call("owner", "POST", `${S}/check`);
    expect(r.status).toBe(200);
    const j = await r.json() as { token: string; permissions: { key: string; state: string }[] };
    expect(j.token).toBe("active");
    expect(j.permissions).toHaveLength(6);
    expect(fake.calls.every((c) => c.auth === `Bearer ${STORED}`)).toBe(true);
    expect(JSON.stringify(j)).not.toContain(STORED);
  });
  it("not configured: 409 cloudflare_not_configured", async () => {
    configure(false);
    installFakeCloudflare({ zones });
    const r = await call("owner", "POST", `${S}/check`, {});
    expect([r.status, await r.json()]).toEqual([409, { error: "cloudflare_not_configured" }]);
  });
  it("rejects a malformed candidate token with 400 invalid_token_format", async () => {
    const fake = installFakeCloudflare({ zones });
    for (const token of ["", "a b", "a\nb", "x".repeat(201), "tok;en", 5]) {
      const r = await call("owner", "POST", `${S}/check`, { token });
      expect([token, r.status, await r.json()]).toEqual([token, 400, { error: "invalid_token_format" }]);
    }
    expect((await call("owner", "POST", `${S}/check`, { token: CAND, extra: 1 })).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
  it("a candidate token is used for every call and stored nowhere", async () => {
    e.CF_API_TOKEN = undefined; // first-run: no stored secret yet
    const fake = installFakeCloudflare({ zones, tokens: { [CAND]: { perms: ["zone_read"] } } });
    const kvBefore = (await env.CACHE.list()).keys;
    const r = await call("owner", "POST", `${S}/check`, { token: CAND });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ token: "active", permissions: expect.arrayContaining([{ key: "dns_edit", state: "missing" }]) });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => c.auth === `Bearer ${CAND}`)).toBe(true);
    expect(await all("SELECT * FROM settings")).toEqual([]);
    expect(await all("SELECT * FROM audit_log")).toEqual([]);
    expect((await env.CACHE.list()).keys).toEqual(kvBefore);
  });
  it("Review Focus 4: a Cloudflare error echoing the candidate token never reaches the response, audit or console", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const fake = installFakeCloudflare({ zones, tokens: { [CAND]: { perms: ALL } } });
    const echo = { success: false, errors: [{ code: 10000, message: `bad token ${CAND}` }], messages: [{ message: CAND }], result: { token: CAND } };
    fake.failNext(/dns_records$/, 403, echo);
    fake.failNext(/workers\/routes$/, 500, echo);
    const r = await call("owner", "POST", `${S}/check`, { token: CAND });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain(CAND);
    expect(JSON.stringify(await all("SELECT * FROM audit_log"))).not.toContain(CAND);
    expect(JSON.stringify(await all("SELECT * FROM settings"))).not.toContain(CAND);
    for (const s of spies) expect(JSON.stringify(s.mock.calls.map((c) => c.map(String)))).not.toContain(CAND);
    // Verify itself failing with an echo: still no token anywhere.
    fake.failNext(/tokens\/verify/, 502, echo);
    const r2 = await call("owner", "POST", `${S}/check`, { token: CAND });
    expect(r2.status).toBe(502);
    expect(await r2.text()).not.toContain(CAND);
    for (const s of spies) expect(JSON.stringify(s.mock.calls.map((c) => c.map(String)))).not.toContain(CAND);
  });
});

describe("PATCH /api/settings/cloudflare", () => {
  it("writes one row and one audit per change", async () => {
    installFakeCloudflare({ zones });
    const r = await call("owner", "PATCH", S, { controlsEnabled: true });
    expect([r.status, await r.json()]).toEqual([200, { controlsEnabled: true }]);
    expect(await all("SELECT key, value, updated_by FROM settings")).toEqual([{ key: "cf.controls", value: "1", updated_by: "uo" }]);
    await call("owner", "PATCH", S, { controlsEnabled: false });
    expect(await all("SELECT key, value FROM settings")).toEqual([{ key: "cf.controls", value: "0" }]);
    const a = await all("SELECT action, target_type, target_id, detail FROM audit_log ORDER BY id");
    expect(a).toEqual([
      { action: "settings.update", target_type: "settings", target_id: "cf.controls", detail: JSON.stringify({ key: "cf.controls", value: "1" }) },
      { action: "settings.update", target_type: "settings", target_id: "cf.controls", detail: JSON.stringify({ key: "cf.controls", value: "0" }) },
    ]);
  });
  it("rejects bad bodies", async () => {
    installFakeCloudflare({ zones });
    for (const b of [{}, { controlsEnabled: "yes" }, { controlsEnabled: true, x: 1 }])
      expect((await call("owner", "PATCH", S, b)).status).toBe(400);
    expect(await all("SELECT * FROM audit_log")).toEqual([]);
  });
});

describe("POST /api/settings/cloudflare/setup", () => {
  const stored = async () => (await all("SELECT value FROM settings WHERE key = 'cf.target_record_id'"))[0]?.value ?? null;
  const writes = (fake: ReturnType<typeof installFakeCloudflare>) => fake.calls.filter((c) => c.method !== "GET");
  it("creates the placeholder record and the fallback origin, stores the record id with one audit", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.fallbackStatus = "pending_deployment";
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([200, { target: "edge.test", fallbackOrigin: "pending" }]);
    expect(fake.state.dns).toEqual([expect.objectContaining({ zoneId: "zsaas", type: "AAAA", name: "edge.test", content: "100::", proxied: true, comment: expect.stringMatching(/^linkwarren setup [0-9a-f-]{36}$/) })]);
    expect(fake.state.fallbackOrigin).toBe("edge.test");
    const id = fake.state.dns[0]!.id;
    expect(await stored()).toBe(id);
    expect(await all("SELECT action, detail FROM audit_log")).toEqual([{ action: "cloudflare.setup", detail: JSON.stringify({ target: "edge.test", recordId: id }) }]);
  });
  it("again: our record (by stored id) and our fallback origin are reused, no Cloudflare write", async () => {
    const fake = installFakeCloudflare({ zones });
    await call("owner", "POST", `${S}/setup`);
    fake.calls.length = 0;
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([200, { target: "edge.test", fallbackOrigin: "active" }]);
    expect(writes(fake)).toEqual([]);
    expect(fake.state.dns).toHaveLength(1);
  });
  it("a fallback origin that is not ours: 409 fallback_in_use, zero writes", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.fallbackOrigin = "origin.other.example";
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([409, { error: "fallback_in_use" }]);
    expect(writes(fake)).toEqual([]);
    expect(fake.state.fallbackOrigin).toBe("origin.other.example");
    expect(await all("SELECT * FROM audit_log")).toEqual([]);
    expect(await all("SELECT * FROM settings")).toEqual([]);
  });
  it("the fallback origin already equal to the target: no PUT, the record is still ensured", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.fallbackOrigin = "EDGE.test.";
    expect((await call("owner", "POST", `${S}/setup`)).status).toBe(200);
    expect(writes(fake).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /zones/zsaas/dns_records"]);
  });
  it("a record at the target with no stored id (even one commented linkwarren): 409 target_in_use, zero writes", async () => {
    for (const rec of [
      { id: "x1", zoneId: "zsaas", type: "CNAME", name: "edge.test", content: "elsewhere.example", proxied: true, comment: null },
      { id: "x2", zoneId: "zsaas", type: "AAAA", name: "edge.test", content: "100::", proxied: true, comment: "linkwarren" },
    ]) {
      const fake = installFakeCloudflare({ zones });
      fake.state.dns.push(rec);
      const r = await call("owner", "POST", `${S}/setup`);
      expect([r.status, await r.json()]).toEqual([409, { error: "target_in_use" }]);
      expect(writes(fake)).toEqual([]);
      expect(await all("SELECT * FROM audit_log")).toEqual([]);
      expect(await all("SELECT * FROM settings")).toEqual([]);
      vi.restoreAllMocks();
    }
  });
  it("a D1 failure after the record was created: the retry recognises it by its setup mark and records it", async () => {
    const fake = installFakeCloudflare({ zones });
    const restore = beforeBatch(1, async () => { throw new Error("D1 unavailable"); });
    try {
      expect((await call("owner", "POST", `${S}/setup`)).status).toBe(500);
    } finally { restore(); }
    expect([fake.state.dns.length, await stored()]).toEqual([1, null]);
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([200, { target: "edge.test", fallbackOrigin: "active" }]);
    expect(fake.state.dns).toHaveLength(1);
    expect(await stored()).toBe(fake.state.dns[0]!.id);
    // A record with another setup's mark is still foreign.
    fake.state.dns.push({ id: "x9", zoneId: "zsaas", type: "CNAME", name: "edge.test", content: "x.example", proxied: true, comment: "linkwarren setup 00000000-0000-0000-0000-000000000000" });
    expect(await (await call("owner", "POST", `${S}/setup`)).json()).toEqual({ error: "target_in_use" });
  });
  it("the fallback PUT failing after the record was created keeps the id, so a retry finishes", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.failNext(/fallback_origin/, 404, { success: false, errors: [{ code: 1551 }], result: null }); // the first GET: unset
    fake.failNext(/fallback_origin/, 500); // the PUT
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([502, { error: "cloudflare_error" }]);
    const id = fake.state.dns[0]!.id;
    expect(await stored()).toBe(id);
    expect(await all("SELECT detail FROM audit_log")).toEqual([{ detail: JSON.stringify({ target: "edge.test", recordId: id, error: "cloudflare_error" }) }]);
    expect((await call("owner", "POST", `${S}/setup`)).status).toBe(200);
    expect(fake.state.dns).toHaveLength(1);
    expect(fake.state.fallbackOrigin).toBe("edge.test");
  });
  it("without the SaaS zone: 409 outside_not_configured; Cloudflare 403: 409 cloudflare_forbidden", async () => {
    const fake = installFakeCloudflare({ zones });
    e.CF_SAAS_ZONE_ID = undefined;
    expect(await (await call("owner", "POST", `${S}/setup`)).json()).toEqual({ error: "outside_not_configured" });
    e.CF_SAAS_ZONE_ID = "zsaas";
    fake.failNext(/fallback_origin/, 403);
    const r = await call("owner", "POST", `${S}/setup`);
    expect([r.status, await r.json()]).toEqual([409, { error: "cloudflare_forbidden" }]);
    expect(writes(fake)).toEqual([]);
    expect(await all("SELECT * FROM audit_log")).toEqual([]);
  });
});

describe("POST /api/settings/cloudflare/resync", () => {
  it("repairs outside and attached account domains, reports failures without stopping, one audit", async () => {
    const fake = installFakeCloudflare({ zones });
    await dom("a.out.test", "outside");
    await dom("b.example.com", "account", { zone_id: "z1", route_id: "gone", dns_record_id: "gone2" });
    await dom("c.example.com", "account"); // never attached: skipped
    await dom("d.manual.test", "manual");
    await dom("e.out.test", "outside");
    fake.failNext(/custom_hostnames\?hostname=a\.out\.test/, 500); // first host fails, the rest still run
    const r = await call("owner", "POST", `${S}/resync`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: 2, failed: [{ host: "a.out.test", error: "cloudflare_error" }], next: null });
    expect(fake.state.hostnames.map((h) => h.hostname)).toEqual(["e.out.test"]);
    expect(fake.state.routes.map((x) => x.pattern).sort()).toEqual(["b.example.com/*", "e.out.test/*"]);
    expect(fake.state.dns.map((d) => d.name)).toEqual(["b.example.com"]);
    expect(fake.calls.some((c) => c.path.includes("c.example.com") || c.path.includes("d.manual.test"))).toBe(false);
    expect(await all("SELECT action, detail FROM audit_log")).toEqual([{ action: "cloudflare.resync", detail: JSON.stringify({ ok: 2, failed: 1, next: null }) }]);
  });
  it("7 domains take 3 calls of at most 3, in domain id order", async () => {
    const fake = installFakeCloudflare({ zones });
    for (let i = 1; i <= 7; i++) await dom(`h${i}.out.test`, "outside");
    const got: unknown[] = [];
    let after: string | null | undefined;
    do {
      const r = await call("owner", "POST", `${S}/resync`, after ? { after } : undefined);
      const j = await r.json() as { ok: number; failed: unknown[]; next: string | null };
      got.push(j);
      after = j.next;
    } while (after && got.length < 10);
    expect(got).toEqual([
      { ok: 3, failed: [], next: "d-h4.out.test" },
      { ok: 3, failed: [], next: "d-h7.out.test" },
      { ok: 1, failed: [], next: null },
    ]);
    expect(fake.state.hostnames.map((h) => h.hostname)).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `h${i}.out.test`));
    expect((await all("SELECT detail FROM audit_log ORDER BY id")).map((a) => JSON.parse(a.detail as string).next)).toEqual(["d-h4.out.test", "d-h7.out.test", null]);
  });
  it("a status-0 failure on domain 2 stops the run with next = domain 2, and the retry resumes there", async () => {
    const fake = installFakeCloudflare({ zones });
    for (let i = 1; i <= 3; i++) await dom(`h${i}.out.test`, "outside");
    fake.failNext(/custom_hostnames\?hostname=h2\.out\.test/, 0);
    const r = await call("owner", "POST", `${S}/resync`);
    expect(await r.json()).toEqual({ ok: 1, failed: [{ host: "h2.out.test", error: "cloudflare_unreachable" }], next: "d-h2.out.test" });
    expect(fake.calls.some((c) => c.path.includes("h3.out.test"))).toBe(false);
    const r2 = await call("owner", "POST", `${S}/resync`, { after: "d-h2.out.test" });
    expect(await r2.json()).toEqual({ ok: 2, failed: [], next: null });
  });
  it("disabled domains are skipped: no Cloudflare calls for them", async () => {
    const fake = installFakeCloudflare({ zones });
    await dom("h1.out.test", "outside");
    await run("UPDATE domains SET status = 'disabled' WHERE id = 'd-h1.out.test'");
    expect(await (await call("owner", "POST", `${S}/resync`)).json()).toEqual({ ok: 0, failed: [], next: null });
    expect(fake.calls.some((c) => c.path.includes("h1.out.test"))).toBe(false);
    expect(fake.state.hostnames).toEqual([]);
  });
  it("outside_not_configured (status 0, code -1) does not stop the run", async () => {
    installFakeCloudflare({ zones });
    e.CF_SAAS_ZONE_ID = undefined;
    for (let i = 1; i <= 2; i++) await dom(`h${i}.out.test`, "outside");
    expect(await (await call("owner", "POST", `${S}/resync`)).json()).toEqual({ ok: 0, failed: [1, 2].map((i) => ({ host: `h${i}.out.test`, error: "outside_not_configured" })), next: null });
  });
  it("bad body 400; not configured 409 cloudflare_not_configured", async () => {
    installFakeCloudflare({ zones });
    expect((await call("owner", "POST", `${S}/resync`, { after: 5 })).status).toBe(400);
    configure(false);
    expect(await (await call("owner", "POST", `${S}/resync`)).json()).toEqual({ error: "cloudflare_not_configured" });
  });
});

describe("POST /api/settings/email/test", () => {
  const T = "/api/settings/email/test";
  const ok = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "1" }));
  const audits = async () => (await all("SELECT detail FROM audit_log WHERE action = 'email.test'")).length;
  beforeEach(async () => {
    e.EMAIL_FROM = "links@example.com";
    e.RESEND_API_KEY = "re_testkey12345";
    await run("DELETE FROM auth_limits");
  });
  afterEach(() => { e.EMAIL_FROM = undefined; e.RESEND_API_KEY = undefined; });

  it("a member gets 403", async () => {
    expect((await call("a", "POST", T)).status).toBe(403);
  });
  it("without email config answers 409 email_not_configured", async () => {
    e.RESEND_API_KEY = undefined;
    const r = await call("owner", "POST", T);
    expect([r.status, await r.json()]).toEqual([409, { error: "email_not_configured" }]);
  });
  it("sends to the caller only, audits once, and a second call within 60 s is too_soon", async () => {
    const f = ok();
    const r = await call("owner", "POST", T);
    expect(r.status).toBe(200);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).to).toEqual([EMAIL.owner]);
    const r2 = await call("owner", "POST", T);
    expect([r2.status, await r2.json()]).toEqual([429, { error: "too_soon" }]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await audits()).toBe(1);
  });
  it("the instance limiter at its cap refuses with too_many", async () => {
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('inst', ?, 50)", Math.floor(Date.now() / 1000));
    const f = ok();
    const r = await call("owner", "POST", T);
    expect([r.status, await r.json()]).toEqual([429, { error: "too_many" }]);
    expect(f).not.toHaveBeenCalled();
    expect(await audits()).toBe(0);
  });
  it("ignores a body and refuses a foreign Origin", async () => {
    const f = ok();
    expect((await call("owner", "POST", T, { to: "x@evil.example", email: "x@evil.example" })).status).toBe(200);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).to).toEqual([EMAIL.owner]);
    await run("DELETE FROM auth_limits");
    const r = await dash(T, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL.owner!), origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("a send failure is 502 email_failed with a reason and no audit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 422 }));
    const r = await call("owner", "POST", T);
    expect([r.status, await r.json()]).toEqual([502, { error: "email_failed", reason: "rejected" }]);
    expect(await audits()).toBe(0);
  });
});

// Task 6: instance, settings, logo, link defaults and setup.
const pngBytes = (w: number, h: number) => {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const actions = async () => (await all("SELECT action, detail FROM audit_log ORDER BY id")).map((r) => [r.action, JSON.parse(String(r.detail))]);
const mainDom = (id: string, host: string, type = "main", status = "active") =>
  run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,'uo',1)", id, host, type, status);

describe("instance and settings", () => {
  beforeEach(async () => {
    e.EMAIL_FROM = "links@example.com";
    e.RESEND_API_KEY = "re_test";
    await env.CACHE.delete("instance:logo");
  });
  afterEach(() => { e.EMAIL_FROM = undefined; e.RESEND_API_KEY = undefined; });

  it("GET /api/instance works for a member with defaults", async () => {
    const r = await call("a", "GET", "/api/instance");
    expect([r.status, await r.json()]).toEqual([200, { name: null, logoVersion: null, configured: false, dashboardHost: "dash.test", mainDomainId: null, linkDefaults: { redirectCode: 302, passQuery: true } }]);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await dash("/api/instance")).status).toBe(401);
  });

  it("members get 403 on GET and PATCH /api/settings, logo and setup", async () => {
    for (const [m, p, b] of [["GET", "/api/settings"], ["PATCH", "/api/settings", { name: "X" }], ["PUT", "/api/settings/logo", { type: "image/png", data: b64(pngBytes(1, 1)) }], ["DELETE", "/api/settings/logo"], ["GET", "/api/setup"], ["POST", "/api/setup/complete"]] as const) {
      const r = await call("a", m, p, b);
      expect([m, p, r.status, await r.json()]).toEqual([m, p, 403, { error: "forbidden" }]);
    }
    expect(await all("SELECT * FROM settings")).toEqual([]);
  });

  it("GET /api/settings: no secret values; teamDomain only in access mode", async () => {
    const r = await call("owner", "GET", "/api/settings");
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toEqual({
      name: null, mainDomainId: null, dashboardHost: "dash.test", authMode: "access", teamDomain: "team.example.cloudflareaccess.com",
      emailFrom: "links@example.com", emailConfigured: true, secrets: { pasteAvailable: false, cf: "secret", resend: "secret" },
      linkRedirectCode: 302, linkPassQuery: true, retention: { auditDays: 1096, clickDetailDays: 90 },
    });
    expect(JSON.stringify(j)).not.toContain(STORED);
    expect(JSON.stringify(j)).not.toContain("re_test");
    const m = env as { AUTH_MODE?: string };
    m.AUTH_MODE = "app";
    try {
      const s = await signedIn("owner2@example.com", { role: "owner" });
      const a = (await (await dash("/api/settings", withCookie(s.cookie))).json()) as Record<string, unknown>;
      expect(a.authMode).toBe("app");
      expect("teamDomain" in a).toBe(false);
      // A Bearer credential is not a dashboard session.
      expect((await dash("/api/settings", { headers: { authorization: "Bearer lw_x" } })).status).toBe(401);
    } finally {
      m.AUTH_MODE = "access";
    }
  });

  it("PATCH validates every field and writes audits", async () => {
    await mainDom("dm", "m.test");
    await mainDom("dp", "p.test", "private");
    await mainDom("dx", "x.test", "main", "disabled");
    const bad: [unknown, string][] = [
      [{}, "no_changes"], [{ name: "" }, "bad_name"], [{ name: "   " }, "bad_name"], [{ name: "a".repeat(61) }, "bad_name"], [{ name: "\u200b\u202e\n" }, "bad_name"],
      [{ mainDomainId: "dp" }, "bad_main_domain"], [{ mainDomainId: "dx" }, "bad_main_domain"], [{ mainDomainId: "nope" }, "bad_main_domain"],
      [{ linkRedirectCode: 307 }, "invalid_body"], [{ linkPassQuery: "yes" }, "invalid_body"], [{ other: 1 }, "invalid_body"], [{ mainDomainId: "x".repeat(65) }, "invalid_body"],
    ];
    for (const [b, err] of bad) {
      const r = await call("owner", "PATCH", "/api/settings", b);
      expect([b, r.status, await r.json()]).toEqual([b, 400, { error: err }]);
    }
    expect(await actions()).toEqual([]);
    const r = await call("owner", "PATCH", "/api/settings", { name: "  Acme links  ", mainDomainId: "dm", linkRedirectCode: 301, linkPassQuery: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "Acme links", mainDomainId: "dm", linkRedirectCode: 301, linkPassQuery: false });
    expect((await actions()).map((a) => a[1].key).sort()).toEqual(["instance.mainDomainId", "instance.name", "links.defaultPassQuery", "links.defaultRedirectCode"]);
    // Control, bidi and zero-width characters are stripped on write, the same set the email path strips.
    const clean = await call("owner", "PATCH", "/api/settings", { name: "Ac\u202eme\u200b\r\n links\u2066" });
    expect(await clean.json()).toMatchObject({ name: "Acme links" });
    expect((await (await call("a", "GET", "/api/instance")).json())).toMatchObject({ name: "Acme links", mainDomainId: "dm", linkDefaults: { redirectCode: 301, passQuery: false } });
  });

  it("logo: PUT, GET with the safe headers, DELETE then 404", async () => {
    expect([(await call("a", "GET", "/api/instance/logo")).status]).toEqual([404]);
    const bytes = pngBytes(16, 16);
    const bad = await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: b64(pngBytes(16, 8)) });
    expect([bad.status, await bad.json()]).toEqual([400, { error: "not_square" }]);
    expect((await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: "%%%" })).status).toBe(400);
    expect((await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: b64(bytes), name: "../x.png" })).status).toBe(400);
    const put = await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: b64(bytes) });
    expect(put.status).toBe(200);
    const { logoVersion } = (await put.json()) as { logoVersion: number };
    expect(Number.isInteger(logoVersion)).toBe(true);
    const g = await call("a", "GET", "/api/instance/logo");
    expect(g.status).toBe(200);
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(bytes);
    expect(g.headers.get("content-type")).toBe("image/png");
    expect(g.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(g.headers.get("x-content-type-options")).toBe("nosniff");
    expect(g.headers.get("cache-control")).toBe("private, max-age=300");
    expect(g.headers.get("content-disposition")).toBe("inline");
    expect(((await (await call("a", "GET", "/api/instance")).json()) as { logoVersion: number }).logoVersion).toBe(logoVersion);
    const del = await call("owner", "DELETE", "/api/settings/logo");
    expect(del.status).toBe(200);
    const g2 = await call("a", "GET", "/api/instance/logo");
    expect([g2.status, await g2.json()]).toEqual([404, { error: "no_logo" }]);
    expect(((await (await call("a", "GET", "/api/instance")).json()) as { logoVersion: unknown }).logoVersion).toBe(null);
    const acts = (await actions()).filter((a) => a[0].startsWith("logo."));
    expect(acts).toEqual([["logo.update", { type: "image/png", bytes: bytes.length }], ["logo.remove", {}]]);
  });

  it("logo: SVG refused, the bytes decide the type, 413 over the limit, Bearer and foreign Origin refused", async () => {
    const svg = b64(new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`));
    const r = await call("owner", "PUT", "/api/settings/logo", { type: "image/svg+xml", data: svg });
    expect([r.status, await r.json()]).toEqual([400, { error: "logo_type" }]);
    const r2 = await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: svg });
    expect([r2.status, await r2.json()]).toEqual([400, { error: "logo_type" }]);
    const big = await call("owner", "PUT", "/api/settings/logo", { type: "image/png", data: "A".repeat(200_000) });
    expect([big.status, await big.json()]).toEqual([413, { error: "too_large" }]);
    const bearer = { authorization: "Bearer lw_x", "content-type": "application/json" };
    expect((await dash("/api/settings/logo", { method: "PUT", headers: bearer, body: JSON.stringify({ data: b64(pngBytes(1, 1)) }) })).status).toBe(401);
    expect((await dash("/api/settings/logo", { method: "DELETE", headers: bearer })).status).toBe(401);
    expect((await dash("/api/instance", { headers: bearer })).status).toBe(401);
    expect((await dash("/api/instance/logo", { headers: bearer })).status).toBe(401);
    const o = await dash("/api/settings/logo", { method: "PUT", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL.owner!), "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ data: b64(pngBytes(1, 1)) }) });
    expect(o.status).toBe(403);
    expect(await env.CACHE.get("instance:logo")).toBe(null);
    // A PNG declared as JPEG is stored and served as PNG.
    const ok = await call("owner", "PUT", "/api/settings/logo", { type: "image/jpeg", data: b64(pngBytes(4, 4)) });
    expect(ok.status).toBe(200);
    expect((await call("a", "GET", "/api/instance/logo")).headers.get("content-type")).toBe("image/png");
  });

  it("link defaults apply when the request leaves them out, an explicit value wins, /api/v1 follows", async () => {
    await mainDom("dm", "m.test");
    await call("owner", "PATCH", "/api/settings", { linkRedirectCode: 301, linkPassQuery: false });
    const mk = async (body: Record<string, unknown>) => {
      const r = await call("a", "POST", "/api/links", { domainId: "dm", url: "https://example.org/", ...body });
      expect(r.status).toBe(201);
      return (await r.json()) as { redirectCode: number; passQuery: boolean };
    };
    expect(await mk({ slug: "one" })).toMatchObject({ redirectCode: 301, passQuery: false });
    expect(await mk({ slug: "two", redirectCode: 302, passQuery: true })).toMatchObject({ redirectCode: 302, passQuery: true });
    // A password link cannot be 301: the default yields to 302 instead of refusing.
    expect(await mk({ slug: "pw", password: "correct horse battery" })).toMatchObject({ redirectCode: 302 });
    const k = await dash("/api/keys", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL.a!), "content-type": "application/json" }, body: JSON.stringify({ name: "ci", write: true, del: false, domainIds: [], expiresInDays: 90 }) });
    const { secret } = (await k.json()) as { secret: string };
    const v = await dash("/api/v1/links", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ domainId: "dm", slug: "three", url: "https://example.org/" }) });
    expect(v.status).toBe(201);
    expect(await v.json()).toMatchObject({ redirectCode: 301, passQuery: false });
  });

  it("setup steps flip, complete needs name and main domain, runs once", async () => {
    configure(false);
    const steps = async () => ((await (await call("owner", "GET", "/api/setup")).json()) as { configured: boolean; steps: Record<string, boolean> });
    expect(await steps()).toEqual({ configured: false, steps: { name: false, signIn: true, cloudflare: false, mainDomain: false, email: true } });
    configure();
    await call("owner", "PATCH", "/api/settings", { name: "Acme" });
    expect((await steps()).steps).toMatchObject({ name: true, cloudflare: true, mainDomain: false });
    const inc = await call("owner", "POST", "/api/setup/complete");
    expect([inc.status, await inc.json()]).toEqual([400, { error: "incomplete", missing: ["mainDomain"] }]);
    await mainDom("dm", "m.test");
    await call("owner", "PATCH", "/api/settings", { mainDomainId: "dm" });
    expect((await steps()).steps.mainDomain).toBe(true);
    const done = await call("owner", "POST", "/api/setup/complete");
    expect(done.status).toBe(200);
    const again = await call("owner", "POST", "/api/setup/complete");
    expect([again.status, await again.json()]).toEqual([409, { error: "already_configured" }]);
    expect((await actions()).filter((a) => a[0] === "setup.complete")).toHaveLength(1);
    expect((await steps()).configured).toBe(true);
    expect(((await (await call("a", "GET", "/api/instance")).json()) as { configured: boolean }).configured).toBe(true);
  });
});
