import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cfConfigFor } from "../src/cf/api";
import { decryptValue, deleteSecretStmts, encryptValue, getSecret, putSecretStmts, secretStatus, secretsReady, SecretsError } from "../src/secrets";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;
const e = env as unknown as Record<string, string | undefined>;
const b64 = (n: number, fill = 7) => btoa(String.fromCharCode(...new Uint8Array(n).fill(fill)));
const KEY = b64(32);
const CF_TOKEN = "dashboardTOKEN_abcdefghij123";
const RE_KEY = "re_dashboardKEY_12345";
const saved = { CF_API_TOKEN: e.CF_API_TOKEN, RESEND_API_KEY: e.RESEND_API_KEY };
const EMAIL: Record<string, string> = { owner: "owner@example.com", a: "a@example.com" };
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const stored = async (name: string) => (await all("SELECT value FROM settings WHERE key = ?", `secret.${name}`))[0]?.value as string | undefined;
const put = async (name: "CF_API_TOKEN" | "RESEND_API_KEY", v: string) => env.DB.batch(await putSecretStmts(env, "uo", name, v));

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["settings", "audit_log", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", EMAIL.owner, "owner"], ["ua", EMAIL.a, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,1)", id, email, role, "active");
  e.SECRETS_KEY = KEY;
  e.CF_API_TOKEN = undefined;
  e.RESEND_API_KEY = undefined;
});
afterEach(() => {
  Object.assign(e, saved, { SECRETS_KEY: undefined, CF_ACCOUNT_ID: undefined, CF_WORKER_NAME: undefined });
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("secretsReady", () => {
  it.each([[KEY, true], [undefined, false], ["", false], [b64(31), false], [b64(33), false], ["not base64!!", false]])("%j -> %j", (k, want) => {
    e.SECRETS_KEY = k;
    expect(secretsReady(env)).toBe(want);
  });
});

describe("encrypted storage", () => {
  it("encryptValue round-trips any plaintext, a leading U+FEFF included, and binds the AAD", async () => {
    for (const p of ["pass1234", "\uFEFFpass1234", "\uFEFF", "x\uFEFFy"]) expect(await decryptValue(env, "qr.a", await encryptValue(env, "qr.a", p))).toBe(p);
    expect(await decryptValue(env, "qr.b", await encryptValue(env, "qr.a", "pass1234"))).toBeNull();
  });
  it("round trip: only ciphertext at rest, audit detail is exactly { name }", async () => {
    await put("CF_API_TOKEN", CF_TOKEN);
    const v = (await stored("CF_API_TOKEN"))!;
    expect(v).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(v).not.toContain(CF_TOKEN);
    expect(await getSecret(env, "CF_API_TOKEN")).toEqual({ value: CF_TOKEN, source: "dashboard" });
    const audits = await all("SELECT action, target_id, detail FROM audit_log");
    expect(audits).toEqual([{ action: "secret.update", target_id: "secret.CF_API_TOKEN", detail: '{"name":"CF_API_TOKEN"}' }]);
    expect(JSON.stringify(audits)).not.toContain(CF_TOKEN);
  });
  it("the same plaintext twice gives different stored values (fresh IV)", async () => {
    await put("RESEND_API_KEY", RE_KEY);
    const a = await stored("RESEND_API_KEY");
    await put("RESEND_API_KEY", RE_KEY);
    const b = await stored("RESEND_API_KEY");
    expect(a).not.toBe(b);
    expect(a!.split(".")[1]).not.toBe(b!.split(".")[1]);
    expect((await getSecret(env, "RESEND_API_KEY"))?.value).toBe(RE_KEY);
  });
  it("a value copied from CF_API_TOKEN to RESEND_API_KEY fails to decrypt (AAD) and reads as null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("CF_API_TOKEN", CF_TOKEN);
    await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('secret.RESEND_API_KEY',?,1,'uo')", await stored("CF_API_TOKEN"));
    expect(await getSecret(env, "RESEND_API_KEY")).toBeNull();
    expect(warn).toHaveBeenCalledWith("secrets_unreadable", "RESEND_API_KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CF_TOKEN);
  });
  it("a tampered ciphertext reads as null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("CF_API_TOKEN", CF_TOKEN);
    const v = (await stored("CF_API_TOKEN"))!;
    const flipped = v.slice(0, -2) + (v.at(-2) === "A" ? "B" : "A") + v.at(-1);
    for (const bad of [flipped, "v1.garbage", "v2." + v.slice(3), ""]) {
      await run("UPDATE settings SET value = ? WHERE key = 'secret.CF_API_TOKEN'", bad);
      expect(await getSecret(env, "CF_API_TOKEN")).toBeNull();
    }
  });
  it("the Worker secret wins over a D1 value", async () => {
    await put("CF_API_TOKEN", CF_TOKEN);
    e.CF_API_TOKEN = "  workerTOKEN_1234567890  ";
    expect(await getSecret(env, "CF_API_TOKEN")).toEqual({ value: "workerTOKEN_1234567890", source: "secret" });
  });
  it("missing or 31-byte SECRETS_KEY: putSecretStmts throws secrets_key_missing", async () => {
    for (const k of [undefined, b64(31)]) {
      e.SECRETS_KEY = k;
      const err = await putSecretStmts(env, "uo", "CF_API_TOKEN", CF_TOKEN).catch((x) => x);
      expect(err).toBeInstanceOf(SecretsError);
      expect(err.message).toBe("secrets_key_missing");
      expect(err.message).not.toContain(CF_TOKEN);
    }
  });
  it("wrong key or no key at read: null and secrets_unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("CF_API_TOKEN", CF_TOKEN);
    e.SECRETS_KEY = b64(32, 9);
    expect(await getSecret(env, "CF_API_TOKEN")).toBeNull();
    e.SECRETS_KEY = undefined;
    expect(await getSecret(env, "CF_API_TOKEN")).toBeNull();
    expect(warn.mock.calls).toEqual([["secrets_unreadable", "CF_API_TOKEN"], ["secrets_unreadable", "CF_API_TOKEN"]]);
  });
  it("nothing stored and no Worker secret: null without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getSecret(env, "CF_API_TOKEN")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("deleteSecretStmts removes the row and audits secret.delete { name }", async () => {
    await put("RESEND_API_KEY", RE_KEY);
    await env.DB.batch(deleteSecretStmts(env, "uo", "RESEND_API_KEY"));
    expect(await stored("RESEND_API_KEY")).toBeUndefined();
    expect((await all("SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1"))[0]).toEqual({ action: "secret.delete", detail: '{"name":"RESEND_API_KEY"}' });
  });
  it("secretStatus reports sources only", async () => {
    expect(await secretStatus(env)).toEqual({ pasteAvailable: true, cf: "missing", resend: "missing" });
    await put("CF_API_TOKEN", CF_TOKEN);
    e.RESEND_API_KEY = "re_worker_1234567890";
    expect(await secretStatus(env)).toEqual({ pasteAvailable: true, cf: "dashboard", resend: "secret" });
    e.SECRETS_KEY = undefined;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await secretStatus(env)).toEqual({ pasteAvailable: false, cf: "missing", resend: "secret" });
  });
  it("cfConfigFor: the stored dashboard token when CF_API_TOKEN is unset, the Worker secret when set", async () => {
    Object.assign(e, { CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw" });
    expect(await cfConfigFor(env)).toBeNull();
    await put("CF_API_TOKEN", CF_TOKEN);
    expect((await cfConfigFor(env))?.token).toBe(CF_TOKEN);
    e.CF_API_TOKEN = "workerTOKEN_1234567890";
    expect((await cfConfigFor(env))?.token).toBe("workerTOKEN_1234567890");
  });
});

describe("secret routes", () => {
  const S = "/api/settings/secrets";
  it("a member gets 403 on every route", async () => {
    for (const [m, p, b] of [["GET", S], ["PUT", `${S}/cf`, { value: CF_TOKEN }], ["PUT", `${S}/resend`, { value: RE_KEY }], ["DELETE", `${S}/resend`]] as const) {
      const r = await call("a", m, p, b);
      expect([m, p, r.status, await r.json()]).toEqual([m, p, 403, { error: "forbidden" }]);
    }
    expect(await all("SELECT key FROM settings")).toEqual([]);
  });
  it("GET never contains a value", async () => {
    await put("CF_API_TOKEN", CF_TOKEN);
    e.RESEND_API_KEY = "re_worker_1234567890";
    const r = await call("owner", "GET", S);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ pasteAvailable: true, cf: "dashboard", resend: "secret" });
    expect(text).not.toContain(CF_TOKEN);
    expect(text).not.toContain("re_worker");
    expect(text).not.toContain((await stored("CF_API_TOKEN"))!);
  });
  it("PUT cf with an inactive token: 400 token_invalid and no row", async () => {
    Object.assign(e, { CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw" });
    installFakeCloudflare({ zones: [{ id: "z1", name: "example.com" }], tokens: {} });
    const r = await call("owner", "PUT", `${S}/cf`, { value: CF_TOKEN });
    expect([r.status, await r.json()]).toEqual([400, { error: "token_invalid" }]);
    expect(await all("SELECT key FROM settings")).toEqual([]);
  });
  it("PUT cf with an active token stores it encrypted and returns status only", async () => {
    Object.assign(e, { CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw" });
    installFakeCloudflare({ zones: [{ id: "z1", name: "example.com" }], tokens: { [CF_TOKEN]: { perms: ["zone_read", "dns_edit", "routes_edit"] } } });
    const r = await call("owner", "PUT", `${S}/cf`, { value: ` ${CF_TOKEN} ` });
    const text = await r.text();
    expect([r.status, JSON.parse(text)]).toEqual([200, { pasteAvailable: true, cf: "dashboard", resend: "missing" }]);
    expect(text).not.toContain(CF_TOKEN);
    expect((await cfConfigFor(env))?.token).toBe(CF_TOKEN);
  });
  it("PUT cf with a bad format: 400 token_invalid without calling Cloudflare", async () => {
    Object.assign(e, { CF_ACCOUNT_ID: "acc1", CF_WORKER_NAME: "lw" });
    const fake = installFakeCloudflare({});
    for (const v of ["short", "has space in it 1234567890", "x".repeat(201)]) {
      const r = await call("owner", "PUT", `${S}/cf`, { value: v });
      expect([r.status, await r.json()]).toEqual([400, { error: "token_invalid" }]);
    }
    expect(fake.calls).toEqual([]);
  });
  it("PUT resend: format check, then stored", async () => {
    for (const v of ["sk_live_12345678901", "re_short", "re_has space 12345"]) {
      const r = await call("owner", "PUT", `${S}/resend`, { value: v });
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_key" }]);
    }
    const r = await call("owner", "PUT", `${S}/resend`, { value: RE_KEY });
    expect([r.status, await r.json()]).toEqual([200, { pasteAvailable: true, cf: "missing", resend: "dashboard" }]);
    expect((await getSecret(env, "RESEND_API_KEY"))?.value).toBe(RE_KEY);
  });
  it("PUT resend with the Worker secret set: 409 set_by_secret", async () => {
    e.RESEND_API_KEY = "re_worker_1234567890";
    const r = await call("owner", "PUT", `${S}/resend`, { value: RE_KEY });
    expect([r.status, await r.json()]).toEqual([409, { error: "set_by_secret" }]);
    expect(await all("SELECT key FROM settings")).toEqual([]);
  });
  it("PUT without a usable SECRETS_KEY: 409 secrets_key_missing", async () => {
    e.SECRETS_KEY = b64(31);
    const r = await call("owner", "PUT", `${S}/resend`, { value: RE_KEY });
    expect([r.status, await r.json()]).toEqual([409, { error: "secrets_key_missing" }]);
  });
  it("unknown name 404, bad body 400 without echoing the value", async () => {
    expect((await call("owner", "PUT", `${S}/__proto__`, { value: RE_KEY })).status).toBe(404);
    const r = await call("owner", "PUT", `${S}/resend`, { value: RE_KEY, extra: 1 });
    const text = await r.text();
    expect([r.status, JSON.parse(text)]).toEqual([400, { error: "invalid_body" }]);
    expect(text).not.toContain(RE_KEY);
  });
  it("DELETE removes the stored value and audits secret.delete", async () => {
    await put("RESEND_API_KEY", RE_KEY);
    const r = await call("owner", "DELETE", `${S}/resend`);
    expect([r.status, await r.json()]).toEqual([200, { pasteAvailable: true, cf: "missing", resend: "missing" }]);
    expect(await stored("RESEND_API_KEY")).toBeUndefined();
    expect((await all("SELECT action, actor_id FROM audit_log ORDER BY id DESC LIMIT 1"))[0]).toEqual({ action: "secret.delete", actor_id: "uo" });
  });
});
