import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashKey } from "../src/keys";
import { MEMBER_DEFAULT } from "../src/roles";
import { dash, setupAccess, tokenFor } from "./helpers/access";

// The upgrade path: data written under 0001..0010, then 0011 applied. Every answer below must stay byte-identical to the
// one captured before 0011 existed (the snapshot file was written by this test against the pre-roles code).
const NOW = Date.parse("2026-11-20T12:00:00Z");
const KEY = `lw_${"k".repeat(43)}`;
const realDb = env.DB;
const up = env.DB_UPGRADE;
const run = (sql: string, ...a: unknown[]) => up.prepare(sql).bind(...a).run();
const as = async (email: string) => ({ "Cf-Access-Jwt-Assertion": await tokenFor(email) });
const OWNER = "owner@example.com", MEMBER = "a@example.com";

/** Ids, secrets and key prefixes are random per run; everything else must match exactly. */
const norm = (s: string) => s
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
  .replace(/lw_[A-Za-z0-9_-]+/g, "lw_<x>");
const answer = async (r: Response) => ({ status: r.status, body: norm(await r.text()) });

async function requests() {
  const out: Record<string, unknown> = {};
  const me = await (await dash("/api/me", { headers: await as(MEMBER) })).json<Record<string, unknown>>();
  for (const k of ["roleId", "roleName", "perms"]) delete me[k]; // new in 0011 by design
  out.me = me;
  for (const who of [OWNER, MEMBER]) {
    out[`links ${who}`] = await answer(await dash("/api/links", { headers: await as(who) }));
    out[`domains ${who}`] = await answer(await dash("/api/domains", { headers: await as(who) }));
    out[`analytics ${who}`] = await answer(await dash("/api/analytics?range=7", { headers: await as(who) }));
  }
  const json = { "content-type": "application/json" };
  out.createLink = await answer(await dash("/api/links", {
    method: "POST", headers: { ...(await as(MEMBER)), ...json }, body: JSON.stringify({ domainId: "dM", slug: "fresh", url: "https://example.com/new" }),
  }));
  out.createKey = await answer(await dash("/api/keys", {
    method: "POST", headers: { ...(await as(MEMBER)), ...json },
    body: JSON.stringify({ name: "ci2", write: false, del: false, domainIds: [], expiresInDays: 90 }),
  }));
  out.v1 = await answer(await exports.default.fetch("https://dash.test/api/v1/links", { headers: { authorization: `Bearer ${KEY}` } }));
  return out;
}

beforeAll(async () => {
  await setupAccess();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await applyD1Migrations(up, env.TEST_MIGRATIONS.filter((m) => m.name < "0011"));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo',?,'owner','active',1),('ua',?,'member','active',2),('ui','i@example.com','member','invited',3)", OWNER, MEMBER);
  const dom = (id: string, host: string, type: string, owner: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active',?,1)", id, host, type, owner);
  await dom("dM", "main.test", "main", "uo");
  await dom("dS", "shared.test", "shared", "uo");
  await dom("dP", "mine.test", "private", "ua");
  await dom("dX", "theirs.test", "shared", "uo");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dS','ua'),('dS','ui')");
  for (const [id, d, by] of [["lM", "dM", "uo"], ["lS", "dS", "ua"], ["lP", "dP", "ua"], ["lX", "dX", "uo"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", id, d, id, id.toLowerCase(), by, by);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through', '2026-11-18')");
  for (const [l, d] of [["lM", "dM"], ["lS", "dS"], ["lX", "dX"]])
    await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES ('2026-11-17',?,?,?,1,2)", l, d, l);
  await run("INSERT INTO api_keys (id,user_id,name,prefix,hash,expires_at,created_at) VALUES ('k1','ua','ci',?,?,?,1)", KEY.slice(0, 10), await hashKey(KEY), NOW / 1000 + 86400);
  await run("INSERT INTO agent_connections (id,user_id,client_id,client_name,redirect_host,created_at) VALUES ('c1','ua','cl','Claude','claude.ai',1)");
  await applyD1Migrations(up, env.TEST_MIGRATIONS); // only what is left: 0011 and later
  (env as { DB: D1Database }).DB = up;
});
afterAll(() => {
  (env as { DB: D1Database }).DB = realDb;
  vi.useRealTimers();
});

describe("upgrade to 0011", () => {
  it("every route answers as it did before the migration", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected fetch"); });
    try {
      expect(await requests()).toMatchSnapshot();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves role_id NULL for everyone and gives members exactly the Member defaults", async () => {
    expect((await up.prepare("SELECT id, role_id FROM users ORDER BY id").all()).results)
      .toEqual([{ id: "ua", role_id: null }, { id: "ui", role_id: null }, { id: "uo", role_id: null }]);
    const me = await (await dash("/api/me", { headers: await as(MEMBER) })).json<Record<string, unknown>>();
    expect(me).toMatchObject({ role: "member", roleId: "member", roleName: "Member", perms: [...MEMBER_DEFAULT] });
  });
});
