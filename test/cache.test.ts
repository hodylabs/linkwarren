import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();

describe("link cache key", () => {
  it("ignores an entry at the old l: key and fills l2:", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dk','ck.test','main','active','u1',1)");
    await run(
      "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES ('lk','dk','v','v','https://d1.test/',302,'u1','u1',1,1)",
    );
    await env.CACHE.put("l:dk:v", JSON.stringify({ id: "lk", domainId: "dk", slug: "v", slugKey: "v", url: "https://old.test/", redirectCode: 302, startsAt: null, expiresAt: null, passQuery: false }));
    const r = await exports.default.fetch("https://ck.test/v", { redirect: "manual" });
    expect(r.headers.get("location")).toBe("https://d1.test/");
    let hit: string | null = null;
    for (let i = 0; i < 20 && hit === null; i++) {
      hit = await env.CACHE.get("l2:dk:v");
      if (hit === null) await new Promise((res) => setTimeout(res, 10));
    }
    expect(JSON.parse(hit!)).toMatchObject({ id: "lk", url: "https://d1.test/", routes: [], passwordHash: null });
  });
});
