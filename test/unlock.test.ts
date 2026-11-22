import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDomainByHost, getLink } from "../src/cache";
import type { Env } from "../src/env";
import { hashPassword, verifyPassword as verify } from "../src/password";
import { handleProtected, INTERSTITIAL_HEADERS } from "../src/unlock";
import { harness, IPHONE, now, seed } from "./helpers/redirect";

// PBKDF2 is crypto.subtle.deriveBits: a global spy proves the limiter and the checks answer before any of that work.
const verifyPassword = vi.spyOn(crypto.subtle, "deriveBits");

const PW = "spring-27x";
let HASH = "";
beforeAll(async () => {
  HASH = await hashPassword(PW, 1000);
});
afterEach(() => verifyPassword.mockClear());

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const routes = [{ countries: ["CA"], devices: [], url: "https://ca.test/" }, { countries: [], devices: ["mobile"], url: "https://m.test/" }];
let ipN = 0;
const freshIp = () => `198.51.${++ipN}.9`;
const form = (password: string | null) => (password === null ? "other=1" : new URLSearchParams({ password }).toString());

/** A form POST as a browser sends it from the interstitial on `host`. */
function post(host: string, body: string, o: { ip?: string; origin?: string | null; type?: string; length?: string | null; cf?: { country: string }; ua?: string } = {}): RequestInit {
  const headers: Record<string, string> = {
    "content-type": o.type ?? "application/x-www-form-urlencoded",
    "cf-connecting-ip": o.ip ?? "203.0.113.7",
    "user-agent": o.ua ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/130",
  };
  if (o.origin !== null) headers.origin = o.origin ?? `https://${host}`;
  if (o.length !== null) headers["content-length"] = o.length ?? String(new TextEncoder().encode(body).length);
  return { method: "POST", headers, body, cf: o.cf ?? { country: "us" } } as RequestInit;
}
const limitRows = async () => (await env.DB.prepare("SELECT key FROM auth_limits").all<{ key: string }>()).results.map((r) => r.key);

describe("password interstitial", () => {
  it("GET shows the form: 200, exact headers, nothing about the destination, no cookie, no click", async () => {
    const d = await seed({ password: HASH, routes });
    const h = harness();
    const r = await h.go(d.host, "/spring?ref=x&lw=qr", { cf: { country: "ca" }, headers: { "user-agent": IPHONE } });
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("content-security-policy")).not.toContain("form-action");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // Not no-referrer: browsers send `Origin: null` on a POST from a no-referrer page, and R9 refuses null.
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    const html = await r.text();
    expect(html).toContain("Protected link");
    expect(html).toContain("Enter the password to open this link.");
    expect(html).toMatch(/<form method="post">/);
    expect(html).not.toMatch(/action=/);
    expect(html).toContain('<label for="pw">Password</label>');
    expect(html).toContain('<input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus>');
    expect(html).toContain("Open link");
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script|<link|src=/);
    expect(html).not.toMatch(/dest\.test|ca\.test|m\.test|spring|ref=|go\d+\.test/);
    for (const v of r.headers.values()) expect(v).not.toMatch(/dest\.test|ca\.test|m\.test/);
    expect(h.points).toHaveLength(0);
  });

  it("HEAD answers the same headers with no body", async () => {
    const d = await seed({ password: HASH });
    const r = await harness().go(d.host, "/spring", { method: "HEAD" });
    expect([r.status, r.headers.get("location"), await r.text()]).toEqual([200, null, ""]);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
  });

  it("trailing slash and case variants show the same form; OPTIONS and PUT are 405 before lookup", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    for (const path of ["/spring/", "/SPRING", "/Spring?lw=qr"]) {
      const r = await h.go(d.host, path);
      expect([path, r.status, r.headers.get("location"), r.headers.get("cache-control"), r.headers.get("x-robots-tag")])
        .toEqual([path, 200, null, "no-store", "noindex"]);
      expect(await r.text()).toContain('name="password"');
    }
    const unlock = await h.go(d.host, "/SPRING/", post(d.host, form(PW), { ip: freshIp() }));
    expect([unlock.status, unlock.headers.get("location")]).toEqual([303, "https://dest.test/x"]);
    for (const method of ["OPTIONS", "PUT"]) {
      const r = await h.go(d.host, "/spring", { method });
      expect([method, r.status, r.headers.get("allow"), r.headers.get("location")]).toEqual([method, 405, "GET, HEAD", null]);
    }
    expect(h.points).toHaveLength(1);
  });

  it("an empty stored hash still counts as protected: the form, never an open redirect", async () => {
    const d = await seed({ password: "" });
    const h = harness();
    const r = await h.go(d.host, "/spring");
    expect([r.status, r.headers.get("location")]).toEqual([200, null]);
    const p = await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }));
    expect([p.status, p.headers.get("location")]).toEqual([401, null]);
  });

  it("a password in the URL is never read: GET /spring?password=<right> is still the form", async () => {
    const d = await seed({ password: HASH });
    const r = await harness().go(d.host, `/spring?password=${PW}`);
    expect([r.status, r.headers.get("location")]).toEqual([200, null]);
    expect(await r.text()).not.toContain(PW);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("phone friendly: 16 px input and 44 px targets", async () => {
    const d = await seed({ password: HASH });
    const html = await (await harness().go(d.host, "/spring")).text();
    expect(html).toMatch(/input,button\{[^}]*min-height:44px;font-size:16px/);
    expect(html).toMatch(/min-height:44px/);
  });
});

describe("unlock", () => {
  it("right password: 303 to the destination, private no-store, no-referrer, robots header, no cookie", async () => {
    const d = await seed({ password: HASH });
    const r = await harness().go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://dest.test/x");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("Review Focus 2: query passes through, QR marker stripped; a CA visitor gets the CA route", async () => {
    const d = await seed({ password: HASH, routes });
    const h = harness();
    const r = await h.go(d.host, "/spring?ref=x&lw=qr", post(d.host, form(PW), { ip: freshIp() }));
    expect(r.headers.get("location")).toBe("https://dest.test/x?ref=x");
    const ca = await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp(), cf: { country: "ca" } }));
    expect(ca.headers.get("location")).toBe("https://ca.test/");
    const phone = await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp(), ua: IPHONE }));
    expect(phone.headers.get("location")).toBe("https://m.test/");
  });

  it("pass-through off: no query on the 303", async () => {
    const d = await seed({ password: HASH, pass: 0 });
    const r = await harness().go(d.host, "/spring?ref=x", post(d.host, form(PW), { ip: freshIp() }));
    expect(r.headers.get("location")).toBe("https://dest.test/x");
  });

  it("wrong or missing password: 401 form with the generic message, nothing reflected, no location", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    for (const body of [form("not-the-one"), form(null), form("")]) {
      const r = await h.go(d.host, "/spring", post(d.host, body, { ip: freshIp() }));
      expect([r.status, r.headers.get("location"), r.headers.get("set-cookie")]).toEqual([401, null, null]);
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      const html = await r.text();
      expect(html).toContain("That password is not right. Try again.");
      expect(html).not.toContain("not-the-one");
      expect(html).toContain('name="password"');
    }
    expect(h.points).toHaveLength(0);
  });

  it("R9: no Origin, Origin null or another host is 403 before the limiter and before PBKDF2", async () => {
    const d = await seed({ password: HASH });
    const ip = freshIp();
    for (const origin of [null, "null", "https://evil.test", `http://${d.host}`, `https://${d.host}.evil.test`]) {
      const r = await harness().go(d.host, "/spring", post(d.host, form(PW), { ip, origin }));
      expect([origin, r.status, r.headers.get("location"), r.headers.get("set-cookie")]).toEqual([origin, 403, null, null]);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect((await limitRows()).filter((k) => k.includes(`198.51.${ipN}.`))).toEqual([]);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("body checks: 415 for a non-form type, 411 without a length, 413 over 1024 bytes; no PBKDF2", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const ip = freshIp();
    const go = (o: Parameters<typeof post>[2], body = form(PW)) => h.go(d.host, "/spring", post(d.host, body, { ip, ...o }));
    expect((await go({ type: "text/plain" })).status).toBe(415);
    expect((await go({ type: "multipart/form-data; boundary=x" })).status).toBe(415);
    expect((await go({ length: null })).status).toBe(411);
    expect((await go({ length: "abc" })).status).toBe(411);
    expect((await go({ length: "2000" })).status).toBe(413);
    expect((await go({}, `password=${"a".repeat(1100)}`)).status).toBe(413);
    // A charset parameter is fine.
    expect((await go({ type: "application/x-www-form-urlencoded; charset=UTF-8" })).status).toBe(303);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it("limiter: the sixth POST from one IP range is 429 before PBKDF2; another range still unlocks", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip }))).status).toBe(401);
    verifyPassword.mockClear();
    // Same /24, different host: still the same range.
    const sixth = await h.go(d.host, "/spring", post(d.host, form(PW), { ip: ip.replace(/\.9$/, ".77") }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("900");
    expect(sixth.headers.get("location")).toBeNull();
    expect(sixth.headers.get("set-cookie")).toBeNull();
    expect(await sixth.text()).toContain("Too many tries.");
    expect(verifyPassword).not.toHaveBeenCalled();
    expect((await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip: freshIp() }))).status).toBe(401);
    expect((await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }))).status).toBe(303);
  });

  it("limiter keys: unlock:<linkId>:<ipPrefix> per link, unlockfail:<ipPrefix> across links", async () => {
    const a = await seed({ password: HASH });
    const ip = freshIp();
    await harness().go(a.host, "/spring", post(a.host, form("wrong-pass"), { ip }));
    const keys = await limitRows();
    expect(keys).toContain(`unlock:${a.link}:198.51.${ipN}.0/24`);
    expect(keys).toContain(`unlockfail:198.51.${ipN}.0/24`);
    // A right unlock counts the attempt but no failure.
    const b = await seed({ password: HASH });
    const ip2 = freshIp();
    await harness().go(b.host, "/spring", post(b.host, form(PW), { ip: ip2 }));
    expect(await limitRows()).toContain(`unlock:${b.link}:198.51.${ipN}.0/24`);
    expect(await limitRows()).not.toContain(`unlockfail:198.51.${ipN}.0/24`);
  });

  it("failures across links: after 20 wrong tries from one range every link answers 429 before PBKDF2", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) {
      const d = await seed({ password: HASH });
      for (let j = 0; j < 5; j++) expect((await harness().go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip }))).status).toBe(401);
    }
    verifyPassword.mockClear();
    const fresh = await seed({ password: HASH });
    expect((await harness().go(fresh.host, "/spring", post(fresh.host, form(PW), { ip }))).status).toBe(429);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("limiter unavailable (D1 error): 503 unavailable page, fail closed, no PBKDF2", async () => {
    const d = await seed({ password: HASH });
    const domain = (await getDomainByHost(env, d.host))!;
    const link = (await getLink(env, domain.id, "spring"))!;
    const broken: Env = { ...env, DB: { prepare() { throw new Error("d1 down"); } } as unknown as D1Database };
    const url = new URL(`https://${d.host}/spring`);
    const r = await handleProtected(new Request(url, post(d.host, form(PW))) as Request, broken, link, domain, url, now());
    expect([r.status, r.headers.get("location"), r.headers.get("set-cookie")]).toEqual([503, null, null]);
    expect(await r.text()).toContain("Password check is unavailable right now.");
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("an expired or scheduled protected link answers like any non-live link: 404, no form", async () => {
    for (const o of [{ expires: now() - 10 }, { starts: now() + 3600 }]) {
      const d = await seed({ password: HASH, ...o });
      const r = await harness().go(d.host, "/spring");
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('name="password"');
      expect((await harness().go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }))).status).toBe(405);
    }
  });

  it("clicks: a right unlock records one point (qr or typed); the form and a wrong try record none", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    await h.go(d.host, "/spring?lw=qr");
    await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip: freshIp() }));
    expect(h.points).toHaveLength(0);
    await h.go(d.host, "/spring?lw=qr", post(d.host, form(PW), { ip: freshIp() }));
    expect(h.points).toHaveLength(1);
    expect(h.points[0].blobs?.[6]).toBe("qr");
    await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }));
    expect(h.points[1].blobs?.[6]).toBe("typed");
  });

  it("the password never reaches a log line, on a wrong and a right attempt", async () => {
    const d = await seed({ password: HASH });
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((k) => vi.spyOn(console, k));
    try {
      const h = harness({ throws: true }); // a failing analytics write logs; it must not carry the password
      await h.go(d.host, "/spring", post(d.host, form("wrong-secret-1"), { ip: freshIp() }));
      await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }));
      for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toMatch(/wrong-secret-1|spring-27x/);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("INTERSTITIAL_HEADERS is a fixed constant with no cookie", () => {
    expect(INTERSTITIAL_HEADERS["content-security-policy"]).toBe(CSP);
    expect(Object.keys(INTERSTITIAL_HEADERS).map((k) => k.toLowerCase())).not.toContain("set-cookie");
  });
});

describe("unlock CPU at 25000 iterations", () => {
  it("measures one full right unlock and one PBKDF2 verify (wall time, workerd timers are coarse)", async () => {
    verifyPassword.mockClear();
    const hash = await hashPassword(PW, 25000);
    const N = 20;
    // Timers only move across I/O in workerd, so each batch ends with a KV read.
    let t = Date.now();
    for (let i = 0; i < N; i++) await verify(PW, hash);
    await env.CACHE.get("tick");
    const verifyMs = (Date.now() - t) / N;
    const d = await seed({ password: hash });
    const h = harness({ clicks: false });
    t = Date.now();
    for (let i = 0; i < N; i++) expect((await h.go(d.host, "/spring", post(d.host, form(PW), { ip: `192.0.${i}.1` }))).status).toBe(303);
    await env.CACHE.get("tick");
    const unlockMs = (Date.now() - t) / N;
    console.info(`unlock bench @25000: verify ${verifyMs.toFixed(2)} ms, full unlock ${unlockMs.toFixed(2)} ms (wall, local)`);
    expect(verifyMs).toBeLessThan(50);
  });
});

describe("fix round 1", () => {
  const rows = async () => (await env.DB.prepare("SELECT key, window_start, count FROM auth_limits ORDER BY key").all()).results;
  const direct = async (u: string, init: RequestInit = {}) => {
    const { handleRedirect } = await import("../src/redirect");
    return handleRedirect(new Request(u, init), env, now());
  };

  it("http: GET and HEAD are 308 to the same https URL, query byte-exact; POST is 403 and reads no password", async () => {
    const d = await seed({ password: HASH });
    for (const method of ["GET", "HEAD"]) {
      const r = await direct(`http://${d.host}/spring?a=%20&b=%2F&lw=qr`, { method });
      expect([method, r.status, r.headers.get("location")]).toEqual([method, 308, `https://${d.host}/spring?a=%20&b=%2F&lw=qr`]);
      expect(await r.text()).not.toContain('name="password"');
    }
    const before = await rows();
    const p = await direct(`http://${d.host}/spring`, post(d.host, form(PW), { ip: freshIp(), origin: `http://${d.host}` }));
    expect([p.status, p.headers.get("location")]).toEqual([403, null]);
    expect(await rows()).toEqual(before);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("http on an unprotected link keeps redirecting as before", async () => {
    const d = await seed();
    const r = await direct(`http://${d.host}/spring`);
    expect([r.status, r.headers.get("location"), r.headers.get("strict-transport-security")]).toEqual([302, "https://dest.test/x", null]);
  });

  it("HSTS on the https form, the 401, the 403 and the 303", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const hsts = "max-age=31536000";
    expect((await h.go(d.host, "/spring")).headers.get("strict-transport-security")).toBe(hsts);
    expect((await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip: freshIp() }))).headers.get("strict-transport-security")).toBe(hsts);
    const o = await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp(), origin: null }));
    expect(o.headers.get("strict-transport-security")).toBe(hsts);
    expect(await o.text()).toContain("This form must be sent from the link's own page. Open the link again.");
    expect((await h.go(d.host, "/spring", post(d.host, form(PW), { ip: freshIp() }))).headers.get("strict-transport-security")).toBe(hsts);
  });

  it("once limited, further POSTs write nothing to D1", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip }));
    const before = await rows();
    for (let i = 0; i < 4; i++) expect((await h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip }))).status).toBe(429);
    expect(await rows()).toEqual(before);
  });

  it("six right unlocks from one range in a window all succeed (the slot is refunded)", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const ip = freshIp();
    for (let i = 0; i < 6; i++) expect((await h.go(d.host, "/spring", post(d.host, form(PW), { ip }))).status).toBe(303);
    const r = await env.DB.prepare("SELECT count FROM auth_limits WHERE key = ?").bind(`unlock:${d.link}:198.51.${ipN}.0/24`).first<{ count: number }>();
    expect(r!.count).toBe(0);
  });

  it("parallel wrong guesses from one range never exceed 5 per window", async () => {
    const d = await seed({ password: HASH });
    const h = harness();
    const ip = freshIp();
    const res = await Promise.all(Array.from({ length: 12 }, () => h.go(d.host, "/spring", post(d.host, form("wrong-pass"), { ip }))));
    const s = res.map((r) => r.status);
    expect(s.filter((x) => x === 401)).toHaveLength(5);
    expect(s.filter((x) => x === 429)).toHaveLength(7);
    expect(verifyPassword.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
