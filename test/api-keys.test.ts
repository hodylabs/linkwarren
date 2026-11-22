import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KEY_SHAPE } from "../src/keys";
import { MEMBER_DEFAULT } from "../src/roles";
import { beforeBatch } from "./helpers/race";
import { sha256Hex } from "../src/session";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const as = async (email: string, path: string, init: RequestInit = {}) =>
  dash(path, { ...init, headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), ...(init.body ? { "content-type": "application/json" } : {}) } });
const create = (email: string, body: Record<string, unknown>) =>
  as(email, "/api/keys", { method: "POST", body: JSON.stringify({ name: "ci", write: false, del: false, domainIds: [], expiresInDays: 90, ...body }) });
type KeyItem = { id: string; userId: string; userEmail: string | null; name: string; prefix: string; write: boolean; del: boolean; domainIds: string[]; createdAt: number; lastUsedAt: number | null; expiresAt: number };

const A = "a@example.com", B = "b@example.com", O = "owner@example.com";

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["api_keys", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, email, role] of [["uo", O, "owner"], ["ua", A, "member"], ["ub", B, "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, email, role);
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.test','main','active','uo',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('ds','team.test','shared','active','uo',1)");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('ds','ub')");
});

describe("POST /api/keys", () => {
  it("returns the secret once: key shape, SHA-256 equals the stored hash, prefix is its first 10 chars", async () => {
    const r = await create(A, { name: "ci-bot", write: true, del: true, domainIds: ["dm"], expiresInDays: 30 });
    expect(r.status).toBe(201);
    const { key, secret } = (await r.json()) as { key: KeyItem; secret: string };
    expect(secret).toMatch(KEY_SHAPE);
    expect(secret).toHaveLength(46);
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(key.id).first<Record<string, unknown>>();
    expect(row!.hash).toBe(await sha256Hex(secret));
    expect(row!.prefix).toBe(secret.slice(0, 10));
    expect(key).toMatchObject({ userId: "ua", userEmail: null, name: "ci-bot", prefix: secret.slice(0, 10), write: true, del: true, domainIds: ["dm"], lastUsedAt: null });
    expect(key.expiresAt - key.createdAt).toBe(30 * 86400);
    expect(JSON.stringify(key)).not.toContain(secret);
  });

  it("audits key.create in the same write, never with the secret or hash", async () => {
    const r = await create(A, { name: "ci" });
    const { key, secret } = (await r.json()) as { key: KeyItem; secret: string };
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'key.create'").first<Record<string, unknown>>();
    expect(a).toMatchObject({ actor_id: "ua", target_type: "api_key", target_id: key.id, via: null });
    const detail = JSON.parse(a!.detail as string) as Record<string, unknown>;
    expect(detail).toEqual({ name: "ci", prefix: key.prefix, write: false, del: false, domainIds: [] });
    const strings = JSON.stringify(detail).match(/"[^"]*"/g) ?? [];
    // The prefix is a 10-char display stub (lw_ + 7); nothing longer that starts with lw_ may appear.
    expect(strings.filter((s) => s.startsWith('"lw_') && s !== `"${key.prefix}"`)).toEqual([]);
    expect(a!.detail as string).not.toContain(secret);
    expect(a!.detail as string).not.toContain(await sha256Hex(secret));
  });

  it("validates the body", async () => {
    expect(await (await create(A, { del: true, write: false })).json()).toEqual({ error: "del_needs_write" });
    for (const expiresInDays of [0, 366, 1.5]) {
      const r = await create(A, { expiresInDays });
      expect([expiresInDays, r.status, await r.json()]).toEqual([expiresInDays, 400, { error: "invalid_body" }]);
    }
    for (const name of ["", "Bad", "a b", "x".repeat(41)]) expect((await create(A, { name })).status).toBe(400);
    expect((await create(A, { domainIds: Array.from({ length: 51 }, (_, i) => `d${i}`) })).status).toBe(400);
    expect((await create(A, { extra: 1 })).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM api_keys").first()).toEqual({ n: 0 });
  });

  it("refuses a domain the person cannot use (403), unknown ones too", async () => {
    expect([(await create(A, { domainIds: ["ds"] })).status]).toEqual([403]);
    expect(await (await create(A, { domainIds: ["nope"] })).json()).toEqual({ error: "forbidden" });
    expect((await create(B, { domainIds: ["ds", "dm"] })).status).toBe(201);
  });

  it("caps active keys at 20 and refuses a duplicate active name", async () => {
    for (let i = 0; i < 20; i++) expect((await create(A, { name: `k${i}` })).status).toBe(201);
    const r = await create(A, { name: "k20" });
    expect([r.status, await r.json()]).toEqual([409, { error: "too_many_keys" }]);
    expect((await create(B, { name: "k0" })).status).toBe(201); // per person
    const dup = await create(B, { name: "k0" });
    expect([dup.status, await dup.json()]).toEqual([409, { error: "name_taken" }]);
  });
});

describe("GET /api/keys", () => {
  it("lists own unrevoked keys and never the secret or hash", async () => {
    const { secret } = (await (await create(A, { name: "one" })).json()) as { secret: string };
    await create(B, { name: "two" });
    const r = await as(A, "/api/keys");
    const text = await r.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(await sha256Hex(secret));
    expect(text).not.toMatch(/"(secret|hash)"/);
    const { items } = JSON.parse(text) as { items: KeyItem[] };
    expect(items.map((k) => [k.name, k.userEmail])).toEqual([["one", null]]);
  });

  it("member ?all=1 is ignored; owner ?all=1 sees everyone with userEmail", async () => {
    await create(A, { name: "one" });
    await create(B, { name: "two" });
    await create(O, { name: "mine" });
    const m = (await (await as(A, "/api/keys?all=1")).json()) as { items: KeyItem[] };
    expect(m.items.map((k) => k.name)).toEqual(["one"]);
    const own = (await (await as(O, "/api/keys")).json()) as { items: KeyItem[] };
    expect(own.items.map((k) => [k.name, k.userEmail])).toEqual([["mine", null]]);
    const all = (await (await as(O, "/api/keys?all=1")).json()) as { items: KeyItem[] };
    expect(all.items.map((k) => [k.name, k.userEmail]).sort()).toEqual([["mine", O], ["one", A], ["two", B]]);
  });
});

describe("DELETE /api/keys/:id", () => {
  it("another member gets 404 (no existence oracle); the owner revokes anyone's; a second revoke is 404", async () => {
    const { key } = (await (await create(A, { name: "one" })).json()) as { key: KeyItem };
    const r = await as(B, `/api/keys/${key.id}`, { method: "DELETE" });
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
    expect((await as(B, "/api/keys/unknown", { method: "DELETE" })).status).toBe(404);
    expect((await as(O, `/api/keys/${key.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await as(A, `/api/keys/${key.id}`, { method: "DELETE" })).status).toBe(404);
    const row = await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").bind(key.id).first<{ revoked_at: number | null }>();
    expect(row!.revoked_at).toBeGreaterThan(0);
    const audits = (await env.DB.prepare("SELECT actor_id, target_id FROM audit_log WHERE action = 'key.revoke'").all()).results;
    expect(audits).toEqual([{ actor_id: "uo", target_id: key.id }]);
    expect((await (await as(A, "/api/keys")).json())).toEqual({ items: [] });
    expect((await create(A, { name: "one" })).status).toBe(201); // a revoked name is free again
  });

  it("a member revokes their own key", async () => {
    const { key } = (await (await create(A, { name: "one" })).json()) as { key: KeyItem };
    expect((await as(A, `/api/keys/${key.id}`, { method: "DELETE" })).status).toBe(204);
  });
});

describe("a people manager and other people's keys (S8 R4)", () => {
  const M = "manager@example.com", X = "x@example.com";
  const revoked = async (id: string) => (await env.DB.prepare("SELECT revoked_at r FROM api_keys WHERE id = ?").bind(id).first<{ r: number | null }>())!.r !== null;
  const key = async (email: string, name: string) => ((await (await create(email, { name })).json()) as { key: KeyItem }).key.id;
  beforeEach(async () => {
    await run("DELETE FROM roles WHERE builtin = 0");
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('mg','Manager',?,0,1,1), ('au','Auditors','[\"audit\"]',0,1,1)", JSON.stringify([...MEMBER_DEFAULT, "people.manage"]));
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('um',?,'member','mg','active',1), ('ux',?,'member','au','active',1)", M, X);
  });

  it("?all=1 lists own and within; revoking within is 204; an owner's or a stronger person's is 403; a member still gets 404", async () => {
    const ko = await key(O, "own"), ka = await key(A, "ak"), kx = await key(X, "xk"), km = await key(M, "mk");
    const l = (await (await as(M, "/api/keys?all=1")).json()) as { items: KeyItem[] };
    expect(l.items.map((k) => [k.id, k.userEmail]).sort()).toEqual([[ka, A], [km, M]].sort());
    for (const id of [ko, kx]) {
      const r = await as(M, `/api/keys/${id}`, { method: "DELETE" });
      expect([r.status, await r.json()]).toEqual([403, { error: "role_above_you" }]);
      expect(await revoked(id)).toBe(false);
    }
    expect((await as(M, `/api/keys/${ka}`, { method: "DELETE" })).status).toBe(204);
    expect(await revoked(ka)).toBe(true);
    const r = await as(B, `/api/keys/${ko}`, { method: "DELETE" });
    expect([r.status, await r.json()]).toEqual([404, { error: "not_found" }]);
  });

  it("people.manage removed between read and batch: 403 and nothing revoked or audited", async () => {
    const ka = await key(A, "ak");
    const restore = beforeBatch(1, () => run("UPDATE roles SET perms = ? WHERE id = 'mg'", JSON.stringify(MEMBER_DEFAULT)));
    let r: Response;
    try { r = await as(M, `/api/keys/${ka}`, { method: "DELETE" }); } finally { restore(); }
    expect([r.status, await r.json()]).toEqual([403, { error: "forbidden" }]);
    expect(await revoked(ka)).toBe(false);
    expect((await env.DB.prepare("SELECT 1 FROM audit_log WHERE action = 'key.revoke'").all()).results).toEqual([]);
  });
});
