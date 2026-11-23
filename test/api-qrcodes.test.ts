import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";

// S9 QR codes: CRUD, the Wi-Fi password kept encrypted and out of lists, exports, audit and logs, and the permission rule.
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const e = env as unknown as Record<string, string | undefined>;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const PW = "s3cretWIFIpass";

async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(`${who}@example.com`), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const answer = async (r: Response) => [r.status, r.status === 204 ? null : await r.json()];
type Item = { id: string; name: string; kind: string; data: Record<string, unknown>; hasPassword: boolean; password?: string | null; link?: { host: string; slug: string } | null; style: Record<string, string> };
const wifi = (o: Record<string, unknown> = {}) => ({ name: "Office", kind: "wifi", data: { ssid: "Office", security: "WPA", hidden: false }, password: PW, ...o });
const make = async (who: string, body: unknown) => {
  const r = await call(who, "POST", "/api/qr-codes", body);
  expect(r.status).toBe(201);
  return (await r.json()) as Item;
};

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["qr_codes", "links", "audit_log", "domain_members", "domains", "users", "locks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('ed','Editor','[\"links.create\",\"links.editAny\"]',0,1,1)");
  await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('ro','Reader','[]',0,1,1)");
  for (const [id, who, role, roleId] of [["uo", "owner", "owner", null], ["ua", "a", "member", null], ["ub", "b", "member", null], ["ue", "e", "member", "ed"], ["ur", "r", "member", "ro"]])
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,'active',1)", id, `${who}@example.com`, role, roleId);
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.test','main','active','uo',1), ('dp','priv.test','private','active','uo',1)");
  await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES ('l1','dm','menu','menu','https://example.com/','ua','ua',1,1), ('l2','dp','secret','secret','https://example.com/','uo','uo',1,1)");
  e.SECRETS_KEY = KEY;
});
afterEach(() => {
  e.SECRETS_KEY = undefined;
  vi.restoreAllMocks();
});

describe("Wi-Fi password", () => {
  it("is stored encrypted with AAD qr.<id>, a fresh IV each write, and read back only from the single read", async () => {
    const q = await make("a", wifi());
    expect(q).toMatchObject({ name: "Office", kind: "wifi", hasPassword: true, data: { ssid: "Office", security: "WPA", hidden: false } });
    expect(JSON.stringify(q)).not.toContain(PW);
    const row = await one<{ secret: string }>("SELECT secret FROM qr_codes WHERE id = ?", q.id);
    expect(row!.secret).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(row!.secret).not.toContain(PW);
    // Moving the ciphertext to another code fails the AAD check: it reads as unreadable, never as the password.
    const other = await make("a", wifi({ name: "Other" }));
    const otherRow = await one<{ secret: string }>("SELECT secret FROM qr_codes WHERE id = ?", other.id);
    expect(otherRow!.secret).not.toBe(row!.secret);
    await run("UPDATE qr_codes SET secret = ? WHERE id = ?", row!.secret, other.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(((await (await call("a", "GET", `/api/qr-codes/${other.id}`)).json()) as Item).password).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PW);
    const read = (await (await call("a", "GET", `/api/qr-codes/${q.id}`)).json()) as Item;
    expect(read.password).toBe(PW);
  });

  it("never appears in the list, the audit detail or an export", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const q = await make("a", wifi());
    await call("a", "PATCH", `/api/qr-codes/${q.id}`, { password: `${PW}2` });
    const list = await (await call("a", "GET", "/api/qr-codes")).text();
    expect(list).toContain(q.id);
    expect(list).not.toContain(PW);
    const audit = (await env.DB.prepare("SELECT action, detail FROM audit_log ORDER BY id").all<{ action: string; detail: string }>()).results;
    expect(audit.map((a) => a.action)).toEqual(["qr.create", "qr.update"]);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ name: "Office", kind: "wifi", password: "set" });
    expect(JSON.stringify(audit)).not.toContain(PW);
    // The owner exports everything: the row is there, its password is not.
    const s = (await (await call("owner", "POST", "/api/export/start", {})).json()) as { run: string; tables: { name: string; columns: string[] }[] };
    const t = s.tables.find((x) => x.name === "qr_codes")!;
    expect(t.columns).not.toContain("secret");
    const page = await (await call("owner", "POST", "/api/export/page", { run: s.run, table: "qr_codes", after: null })).text();
    expect(JSON.parse(page).rows).toEqual([expect.objectContaining({ id: q.id, hasPassword: true })]);
    expect(page).not.toContain(PW);
    expect(page).not.toContain("v1.");
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(PW);
  });

  it("omitted on edit keeps the stored one; an empty string clears it", async () => {
    const q = await make("a", wifi());
    expect(await answer(await call("a", "PATCH", `/api/qr-codes/${q.id}`, { name: "Front desk" }))).toEqual([200, expect.objectContaining({ name: "Front desk", hasPassword: true })]);
    expect(((await (await call("a", "GET", `/api/qr-codes/${q.id}`)).json()) as Item).password).toBe(PW);
    expect(await answer(await call("a", "PATCH", `/api/qr-codes/${q.id}`, { password: "" }))).toEqual([200, expect.objectContaining({ hasPassword: false })]);
    expect(await one("SELECT secret FROM qr_codes WHERE id = ?", q.id)).toEqual({ secret: null });
  });

  it("an open network or another kind stores no password", async () => {
    const q = await make("a", wifi({ data: { ssid: "Guest", security: "nopass", hidden: true } }));
    expect(q.hasPassword).toBe(false);
    const w = await make("a", wifi());
    const r = (await (await call("a", "PATCH", `/api/qr-codes/${w.id}`, { kind: "text", data: { text: "hi" } })).json()) as Item;
    expect(r).toMatchObject({ kind: "text", hasPassword: false });
  });

  it("without SECRETS_KEY a code with a password is refused with a clear error; one without saves", async () => {
    e.SECRETS_KEY = undefined;
    expect(await answer(await call("a", "POST", "/api/qr-codes", wifi()))).toEqual([409, { error: "secrets_key_missing" }]);
    expect(await one("SELECT COUNT(*) n FROM qr_codes")).toEqual({ n: 0 });
    expect((await call("a", "POST", "/api/qr-codes", wifi({ password: undefined, data: { ssid: "Guest", security: "nopass", hidden: false } }))).status).toBe(201);
  });
});

describe("kinds", () => {
  it("validates each kind's data", async () => {
    const bad = (body: unknown) => call("a", "POST", "/api/qr-codes", body).then(answer);
    expect(await bad({ name: "x", kind: "url", data: { url: "javascript:alert(1)" } })).toEqual([400, { error: "qr_url" }]);
    expect(await bad({ name: "x", kind: "text", data: { text: "a".repeat(301) } })).toEqual([400, { error: "qr_text_long" }]);
    expect(await bad({ name: "x", kind: "email", data: { to: "nope" } })).toEqual([400, { error: "qr_email" }]);
    expect(await bad({ name: "x", kind: "phone", data: { number: "abc" } })).toEqual([400, { error: "qr_phone" }]);
    expect(await bad({ name: "", kind: "text", data: { text: "x" } })).toEqual([400, { error: "qr_name" }]);
    expect(await bad({ name: "x", kind: "text", data: { text: "x" }, style: { fg: "#FFFFFF", bg: "#000000", ecc: "M" } })).toEqual([400, { error: "inverted_colors" }]);
    expect(await bad({ name: "x", kind: "text", data: { text: "x" }, style: { fg: "#777777", bg: "#888888", ecc: "M" } })).toEqual([400, { error: "low_contrast" }]);
    expect(await bad({ name: "x", kind: "text", data: { text: "x", extra: 1 } })).toEqual([400, { error: "invalid_body" }]);
    expect(await bad({ name: "x", kind: "nope", data: {} })).toEqual([400, { error: "invalid_body" }]);
    expect(await bad({ name: "x".repeat(10_000), kind: "text", data: { text: "x" } })).toEqual([400, { error: "invalid_body" }]);
    const ok = await make("a", { name: "Mail", kind: "email", data: { to: "info@example.com", subject: "Hi" }, style: { fg: "#1D4ED8", bg: "#FFFFFF", ecc: "H" } });
    expect(ok).toMatchObject({ data: { to: "info@example.com", subject: "Hi", body: "" }, style: { fg: "#1D4ED8", bg: "#FFFFFF", ecc: "H" } });
  });

  it("link: stores the id, follows a slug change, and reads as broken once the link is deleted", async () => {
    const q = await make("a", { name: "Menu", kind: "link", data: { linkId: "l1" } });
    expect(q).toMatchObject({ data: { linkId: "l1" }, link: { host: "go.test", slug: "menu" } });
    await run("UPDATE links SET slug = 'menu2', slug_key = 'menu2' WHERE id = 'l1'");
    expect(((await (await call("a", "GET", "/api/qr-codes")).json()) as { items: Item[] }).items[0]!.link).toEqual({ host: "go.test", slug: "menu2" });
    await run("DELETE FROM links WHERE id = 'l1'");
    const r = await call("a", "GET", "/api/qr-codes");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: Item[] }).items[0]!.link).toBeNull();
  });

  it("link: refuses a link on a domain the person cannot use, or an unknown one", async () => {
    expect(await answer(await call("a", "POST", "/api/qr-codes", { name: "x", kind: "link", data: { linkId: "l2" } }))).toEqual([400, { error: "qr_link" }]);
    expect(await answer(await call("a", "POST", "/api/qr-codes", { name: "x", kind: "link", data: { linkId: "nope" } }))).toEqual([400, { error: "qr_link" }]);
    expect((await call("owner", "POST", "/api/qr-codes", { name: "x", kind: "link", data: { linkId: "l2" } })).status).toBe(201);
  });
});

describe("permissions", () => {
  it("a member cannot read, edit or delete another member's code, and lists only their own", async () => {
    const q = await make("a", wifi());
    await make("b", { name: "B text", kind: "text", data: { text: "b" } });
    expect(await answer(await call("b", "GET", `/api/qr-codes/${q.id}`))).toEqual([403, { error: "forbidden" }]);
    expect(await answer(await call("b", "PATCH", `/api/qr-codes/${q.id}`, { name: "mine" }))).toEqual([403, { error: "forbidden" }]);
    expect(await answer(await call("b", "DELETE", `/api/qr-codes/${q.id}`))).toEqual([403, { error: "forbidden" }]);
    const list = (await (await call("b", "GET", "/api/qr-codes")).json()) as { items: Item[] };
    expect(list.items.map((i) => i.name)).toEqual(["B text"]);
  });

  it("links.editAny manages everyone's codes, password included; the owner too", async () => {
    const q = await make("a", wifi());
    expect(((await (await call("e", "GET", `/api/qr-codes/${q.id}`)).json()) as Item).password).toBe(PW);
    expect(((await (await call("e", "GET", "/api/qr-codes")).json()) as { items: Item[] }).items).toHaveLength(1);
    expect((await call("owner", "PATCH", `/api/qr-codes/${q.id}`, { name: "Renamed" })).status).toBe(200);
    expect((await call("e", "DELETE", `/api/qr-codes/${q.id}`)).status).toBe(204);
    expect((await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'qr.%' ORDER BY id").all()).results.map((r) => r.action)).toEqual(["qr.create", "qr.update", "qr.delete"]);
  });

  it("a role without links.create cannot list or create, and loses its own codes' edit right", async () => {
    expect(await answer(await call("r", "GET", "/api/qr-codes"))).toEqual([403, { error: "forbidden" }]);
    expect(await answer(await call("r", "POST", "/api/qr-codes", { name: "x", kind: "text", data: { text: "x" } }))).toEqual([403, { error: "forbidden" }]);
    const q = await make("a", { name: "x", kind: "text", data: { text: "x" } });
    await run("UPDATE users SET role_id = 'ro' WHERE id = 'ua'");
    expect(await answer(await call("a", "PATCH", `/api/qr-codes/${q.id}`, { name: "y" }))).toEqual([403, { error: "forbidden" }]);
  });

  it("an unknown code is 404", async () => {
    expect(await answer(await call("a", "GET", "/api/qr-codes/nope"))).toEqual([404, { error: "not_found" }]);
    expect(await answer(await call("a", "DELETE", "/api/qr-codes/nope"))).toEqual([404, { error: "not_found" }]);
  });
});
