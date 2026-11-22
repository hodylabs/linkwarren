import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { auditManyStmt } from "../src/audit";

const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();
const base = { actorId: "uo", via: "API key ci", action: "link.update", targetType: "link" };
// Each row is written only when its link still has the revision read.
const revGuard = { sql: "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND updated_at = json_extract(j.value,'$.r'))", binds: [] };
const audits = async () =>
  (await env.DB.prepare("SELECT actor_id, via, action, target_type, target_id, detail FROM audit_log ORDER BY target_id").all<Record<string, string>>()).results;

beforeEach(async () => {
  await env.DB.batch(["audit_log", "links", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)");
  await run("INSERT INTO domains (id,host,type,status,owner_id,case_sensitive,created_at) VALUES ('d1','s.example.com','main','active','uo',0,1)");
  for (const id of ["l1", "l2", "l3"])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'d1',?,?,'https://x.com/','uo','uo',1,5)", id, id, id);
});

describe("auditManyStmt", () => {
  it("writes one row per entry whose guard holds", async () => {
    const res = await auditManyStmt(env, base, [
      { targetId: "l1", r: 5, detail: { bulk: "redirect", n: 1 } },
      { targetId: "l2", r: 4, detail: { bulk: "redirect", n: 2 } }, // stale revision
      { targetId: "l3", r: 5, detail: { bulk: "redirect", n: 3 } },
    ], revGuard).run();
    expect(res.meta.changes).toBe(2);
    const got = await audits();
    expect(got.map((a) => a.target_id)).toEqual(["l1", "l3"]);
    for (const a of got) expect([a.actor_id, a.via, a.action, a.target_type]).toEqual(["uo", "API key ci", "link.update", "link"]);
    expect(got.map((a) => JSON.parse(a.detail!))).toEqual([{ bulk: "redirect", n: 1 }, { bulk: "redirect", n: 3 }]);
  });

  it("binds the guard's own parameters", async () => {
    const g = { sql: "EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value,'$.t') AND domain_id = ?)", binds: ["d1"] };
    await auditManyStmt(env, base, [{ targetId: "l1", detail: {} }, { targetId: "nope", detail: {} }], g).run();
    expect((await audits()).map((a) => [a.target_id, a.detail])).toEqual([["l1", "{}"]]);
    // An existing link on another domain fails the bound guard too.
    await auditManyStmt(env, base, [{ targetId: "l1", detail: {} }], { ...g, binds: ["d2"] }).run();
    expect(await audits()).toHaveLength(1);
  });

  it("writes nothing for an empty rows array", async () => {
    const res = await auditManyStmt(env, base, [], revGuard).run();
    expect(res.meta.changes).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it("round-trips a detail with quotes and unicode, stored as auditStmt stores it", async () => {
    const detail = { slug: `it's "quoted"`, note: "café \u{1F600} ☃", path: "a\\b" };
    await auditManyStmt(env, { ...base, via: null }, [{ targetId: "l1", r: 5, detail }], revGuard).run();
    const [a] = await audits();
    expect(a!.via).toBeNull();
    expect(JSON.parse(a!.detail!)).toEqual(detail);
    expect(a!.detail).toBe(JSON.stringify(detail));
  });
});
