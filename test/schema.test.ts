import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const db = env.DB;
const run = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();
const msg = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
};

const user = (id: string, email: string) =>
  run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,?,?)", id, email, "member", "active", 1);
const domain = (id: string, host: string, owner: string) =>
  run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,?,?,?)", id, host, "main", "active", owner, 1);
const link = (id: string, dom: string, key: string, code = 302) =>
  run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, dom, key, key, "https://x.test", code, "u1", "u1", 1, 1,
  );

describe("schema", () => {
  it("enforces per-domain slug_key uniqueness", async () => {
    await user("u1", "o@x.com");
    await domain("d1", "a.test", "u1");
    await domain("d2", "b.test", "u1");
    await link("l1", "d1", "spring");
    expect(await msg(link("l2", "d1", "spring"))).toContain("UNIQUE");
    await link("l3", "d2", "spring");
  });

  it("makes user email unique case-insensitively", async () => {
    await user("u2", "A@x.com");
    expect(await msg(user("u3", "a@x.com"))).toContain("UNIQUE");
  });

  it("rejects redirect_code 307", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','member','active',1)");
    await domain("d3", "c.test", "u1");
    expect(await msg(link("l4", "d3", "k", 307))).toContain("CHECK");
  });

  it("domain_cf: rejects a bogus kind and cascades with its domain", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','member','active',1)");
    await domain("d4", "e.test", "u1");
    const cf = (kind: string) => run("INSERT INTO domain_cf (domain_id,kind,updated_at) VALUES ('d4',?,1)", kind);
    expect(await msg(cf("bogus"))).toContain("CHECK");
    await cf("account");
    await run("DELETE FROM domains WHERE id = 'd4'");
    expect(await db.prepare("SELECT 1 FROM domain_cf WHERE domain_id = 'd4'").first()).toBeNull();
  });

  it("the 0002 backfill gives every pre-existing domain a manual row", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','member','active',1)");
    await domain("d5", "f.test", "u1");
    await db.exec("DROP INDEX domains_owner_status; DROP TABLE domain_cf; DROP TABLE settings;");
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0002"))!;
    for (const q of m.queries) await db.prepare(q).run();
    expect(await db.prepare("SELECT kind FROM domain_cf WHERE domain_id = 'd5'").first()).toEqual({ kind: "manual" });
  });
});

describe("sign-in schema", () => {
  const session = (id: string, hash: string, uid: string, method = "email") =>
    run("INSERT INTO sessions (id,token_hash,user_id,method,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,1,1,61)", id, hash, uid, method);
  const passkey = (id: string, cred: string, uid: string) =>
    run("INSERT INTO passkeys (id,credential_id,user_id,public_key,name,created_at) VALUES (?,?,?,'pk','Key',1)", id, cred, uid);
  const n = async (t: string, uid: string) =>
    (await db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).bind(uid).first<{ n: number }>())!.n;

  it("deleting a user cascades its sessions and passkeys", async () => {
    await user("su1", "s1@x.com");
    await session("ss1", "h1", "su1");
    await passkey("sp1", "c1", "su1");
    await run("DELETE FROM users WHERE id = 'su1'");
    expect(await n("sessions", "su1")).toBe(0);
    expect(await n("passkeys", "su1")).toBe(0);
  });

  it("rejects method 'sms' and purpose 'x'", async () => {
    await user("su2", "s2@x.com");
    expect(await msg(session("ss2", "h2", "su2", "sms"))).toContain("CHECK");
    expect(await msg(run("INSERT INTO auth_challenges (challenge,purpose,expires_at) VALUES ('c','x',1)"))).toContain("CHECK");
  });

  it("rejects a duplicate token_hash and credential_id", async () => {
    await user("su3", "s3@x.com");
    await session("ss3", "h3", "su3");
    expect(await msg(session("ss4", "h3", "su3"))).toContain("UNIQUE");
    await passkey("sp3", "c3", "su3");
    expect(await msg(passkey("sp4", "c3", "su3"))).toContain("UNIQUE");
  });
});

describe("analytics schema", () => {
  it("has the three rollup tables", async () => {
    const r = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('clicks_daily','clicks_daily_dim','analytics_state') ORDER BY name")
      .all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(["analytics_state", "clicks_daily", "clicks_daily_dim"]);
  });

  it("rejects dim 'os'", async () => {
    const dim = (d: string) =>
      run("INSERT INTO clicks_daily_dim (day,link_id,domain_id,dim,value,clicks) VALUES ('2026-11-19','l1','d1',?,'x',1)", d);
    expect(await msg(dim("os"))).toContain("CHECK");
    await dim("country");
  });
});

describe("link rules schema", () => {
  it("a fresh link has password_hash NULL and routes '[]'", async () => {
    await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','member','active',1)");
    await domain("d6", "g.test", "u1");
    await link("l6", "d6", "rules");
    expect(await db.prepare("SELECT password_hash, routes FROM links WHERE id = 'l6'").first()).toEqual({ password_hash: null, routes: "[]" });
  });
});
