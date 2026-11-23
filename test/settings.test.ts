import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getSettings, settingStmts } from "../src/settings";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;

beforeEach(async () => {
  await env.DB.batch(["settings", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // settingStmts re-checks the actor's settings permission (S8 R5): the actor is an active owner.
  await run("INSERT OR REPLACE INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)");
});

const DEFAULTS = { name: null, mainDomainId: null, logoVersion: null, linkRedirectCode: 302, linkPassQuery: true, setupCompletedAt: null };

describe("getSettings", () => {
  it("defaults on an empty table", async () => {
    expect(await getSettings(env)).toEqual(DEFAULTS);
  });
  it("a value failing its schema reads as the default", async () => {
    for (const [k, v] of [["links.defaultRedirectCode", "307"], ["links.defaultPassQuery", '"yes"'], ["instance.name", "{not json"], ["instance.logoVersion", '"2"']])
      await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES (?,?,1,'u')", k, v);
    expect(await getSettings(env)).toEqual(DEFAULTS);
    await run("UPDATE settings SET value = ? WHERE key = 'links.defaultRedirectCode'", '"307"');
    expect((await getSettings(env)).linkRedirectCode).toBe(302);
  });
  it("never reads secret.* rows", async () => {
    await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('secret.CF_API_TOKEN','v1.x.y',1,'u')");
    expect(await getSettings(env)).toEqual(DEFAULTS);
  });
});

describe("settingStmts", () => {
  it("a patch of two keys writes two rows and two settings.update audits { key, value }", async () => {
    await env.DB.batch(settingStmts(env, "uo", { name: "Acme links", linkRedirectCode: 301 }));
    expect(await all("SELECT key, value, updated_by FROM settings ORDER BY key")).toEqual([
      { key: "instance.name", value: '"Acme links"', updated_by: "uo" },
      { key: "links.defaultRedirectCode", value: "301", updated_by: "uo" },
    ]);
    const audits = await all("SELECT actor_id, action, target_type, target_id, detail FROM audit_log ORDER BY id");
    expect(audits.map((a) => ({ ...a, detail: JSON.parse(a.detail as string) }))).toEqual([
      { actor_id: "uo", action: "settings.update", target_type: "settings", target_id: "instance.name", detail: { key: "instance.name", value: "Acme links" } },
      { actor_id: "uo", action: "settings.update", target_type: "settings", target_id: "links.defaultRedirectCode", detail: { key: "links.defaultRedirectCode", value: 301 } },
    ]);
    expect(await getSettings(env)).toEqual({ ...DEFAULTS, name: "Acme links", linkRedirectCode: 301 });
  });
  it("null deletes the row (and is audited)", async () => {
    await env.DB.batch(settingStmts(env, "uo", { name: "A", linkPassQuery: false, setupCompletedAt: 1700000000 }));
    await env.DB.batch(settingStmts(env, "uo", { name: null }));
    expect(await all("SELECT key FROM settings ORDER BY key")).toEqual([{ key: "links.defaultPassQuery" }, { key: "setup.completedAt" }]);
    expect(await getSettings(env)).toEqual({ ...DEFAULTS, linkPassQuery: false, setupCompletedAt: 1700000000 });
    const last = (await all("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1"))[0]!;
    expect(JSON.parse(last.detail as string)).toEqual({ key: "instance.name", value: null });
  });
  it("leaves the existing cf.controls and mcp.enabled rows untouched", async () => {
    await run("INSERT INTO settings (key,value,updated_at,updated_by) VALUES ('cf.controls','1',5,'x'),('mcp.enabled','0',6,'y')");
    await env.DB.batch(settingStmts(env, "uo", { name: "A", mainDomainId: "d1", logoVersion: 3 }));
    expect(await all("SELECT key, value, updated_at, updated_by FROM settings WHERE key IN ('cf.controls','mcp.enabled') ORDER BY key")).toEqual([
      { key: "cf.controls", value: "1", updated_at: 5, updated_by: "x" },
      { key: "mcp.enabled", value: "0", updated_at: 6, updated_by: "y" },
    ]);
    expect(await getSettings(env)).toEqual({ ...DEFAULTS, name: "A", mainDomainId: "d1", logoVersion: 3 });
  });
  it("an empty patch writes nothing", () => {
    expect(settingStmts(env, "uo", {})).toEqual([]);
  });
  it("an actor without the settings permission writes and audits nothing", async () => {
    await run("INSERT OR REPLACE INTO users (id,email,role,status,created_at) VALUES ('um','m@example.com','member','active',1)");
    await env.DB.batch(settingStmts(env, "um", { name: "A" }));
    await run("UPDATE users SET status = 'disabled' WHERE id = 'uo'");
    await env.DB.batch(settingStmts(env, "uo", { name: "B" }));
    expect([await all("SELECT key FROM settings"), await all("SELECT id FROM audit_log")]).toEqual([[], []]);
  });
});
