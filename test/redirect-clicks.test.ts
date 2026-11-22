import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleRedirect } from "../src/redirect";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
let n = 0;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const now = () => Math.floor(Date.now() / 1000);

async function seed(o: Record<string, unknown> = {}) {
  const i = ++n;
  const d = { host: `go${i}.test`, id: `cd${i}`, link: `cl${i}` };
  await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
  await run(
    "INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,noindex,case_sensitive,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    d.id, d.host, "main", o.status ?? "active", "u1", "https://bare.test/", 1, 0, 1,
  );
  await run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    d.link, d.id, "spring", "spring", "https://dest.test/x", 302, null, o.expires ?? null, o.pass ?? 1, "u1", "u1", 1, 1,
  );
  return d;
}

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
function harness(o: { clicks?: boolean; ctx?: boolean; salt?: string | null; throws?: boolean } = {}) {
  const points: Point[] = [];
  const pending: Promise<unknown>[] = [];
  const fake = {
    writeDataPoint(p: Point) {
      if (o.throws) throw new Error("boom");
      points.push(p);
    },
  };
  const e: Env = { ...env, VISITOR_SALT: o.salt === null ? undefined : (o.salt ?? "test-salt") };
  if (o.clicks !== false) e.CLICKS = fake as unknown as AnalyticsEngineDataset;
  const ctx = o.ctx === false ? undefined : { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const go = async (host: string, path: string, init: RequestInit & { cf?: unknown } = {}) => {
    const r = await handleRedirect(new Request(`https://${host}${path}`, init as RequestInit), e, now(), ctx);
    await Promise.all(pending);
    return r;
  };
  return { points, go };
}
const visit = (headers: Record<string, string> = {}) => ({
  cf: { country: "ca" },
  headers: { "user-agent": IPHONE, referer: "https://www.instagram.com/p/1", "cf-connecting-ip": "203.0.113.7", ...headers },
});

describe("click recording", () => {
  it("one point with the fixed layout per live GET", async () => {
    const d = await seed();
    const h = harness();
    const r = await h.go(d.host, "/spring", visit());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://dest.test/x");
    expect(h.points).toHaveLength(1);
    const p = h.points[0];
    expect(p.indexes).toEqual([d.id]);
    expect(p.doubles).toEqual([1]);
    expect(p.blobs?.slice(0, 8)).toEqual([d.id, d.link, "spring", "CA", "mobile", "instagram.com", "typed", "human"]);
    expect(p.blobs?.[8]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(p)).not.toMatch(/203\.0\.113\.7|iPhone|\/p\/1/);
  });

  it("qr marker is stripped byte for byte and recorded", async () => {
    const d = await seed();
    const h = harness();
    expect((await h.go(d.host, "/spring?a=%20&lw=qr&b=1", visit())).headers.get("location")).toBe("https://dest.test/x?a=%20&b=1");
    expect(h.points[0].blobs?.[6]).toBe("qr");
    expect((await h.go(d.host, "/spring?lw=qrx", visit())).headers.get("location")).toBe("https://dest.test/x?lw=qrx");
    expect(h.points[1].blobs?.[6]).toBe("typed");
    expect((await h.go(d.host, "/spring?lw=qr", visit())).headers.get("location")).toBe("https://dest.test/x");
    expect(h.points[2].blobs?.[6]).toBe("qr");
  });

  it("pass_query off: Location is the stored URL, source still qr", async () => {
    const d = await seed({ pass: 0 });
    const h = harness();
    expect((await h.go(d.host, "/spring?lw=qr", visit())).headers.get("location")).toBe("https://dest.test/x");
    expect(h.points[0].blobs?.[6]).toBe("qr");
  });

  it("chat previews are kind preview; no salt leaves the visitor empty", async () => {
    const d = await seed();
    const h = harness({ salt: null });
    await h.go(d.host, "/spring", visit({ "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" }));
    expect(h.points[0].blobs?.[7]).toBe("preview");
    expect(h.points[0].blobs?.[8]).toBe("");
  });

  it("no point for HEAD, bare domain, unknown slug, expired link, pending domain, robots, favicon", async () => {
    const d = await seed();
    const old = await seed({ expires: now() - 10 });
    const pend = await seed({ status: "pending" });
    const h = harness();
    expect((await h.go(d.host, "/spring", { ...visit(), method: "HEAD" })).status).toBe(302);
    expect((await h.go(d.host, "/", visit())).status).toBe(302);
    expect((await h.go(d.host, "/nope", visit())).status).toBe(404);
    expect((await h.go(d.host, "/robots.txt", visit())).status).toBe(200);
    expect((await h.go(d.host, "/favicon.ico", visit())).status).toBe(204);
    expect((await h.go(old.host, "/spring", visit())).status).toBe(404);
    expect((await h.go(pend.host, "/spring", visit())).status).toBe(200);
    expect(h.points).toHaveLength(0);
  });

  it("writeDataPoint throwing still answers the same redirect, nothing escapes", async () => {
    const d = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ throws: true });
    const r = await h.go(d.host, "/spring?lw=qr&z=1", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x?z=1"]);
    expect(warn).toHaveBeenCalledWith("click not recorded", "Error");
    warn.mockRestore();
  });

  it("HMAC failing still answers the same redirect", async () => {
    const d = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sign = vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new TypeError("no"));
    const h = harness();
    const r = await h.go(d.host, "/spring", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x"]);
    expect(h.points).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("click not recorded", "TypeError");
    sign.mockRestore();
    warn.mockRestore();
  });

  it("no CLICKS or no ctx: same redirect, no point", async () => {
    const d = await seed();
    const a = harness({ clicks: false });
    expect((await a.go(d.host, "/spring", visit())).headers.get("location")).toBe("https://dest.test/x");
    const b = harness({ ctx: false });
    const r = await b.go(d.host, "/spring", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x"]);
    expect(b.points).toHaveLength(0);
  });
});
