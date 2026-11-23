import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReport, resolveRange } from "../src/analytics";
import { digestEmail, outcomeOf, sendDigests, startWeek, unsubToken, weekOf } from "../src/digest";
import { dash } from "./helpers/access";
import { fakeResend } from "./helpers/resend";
import { signedIn, withCookie } from "./helpers/session";

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Monday 2026-11-23 08:00 in Paris (07:00 UTC); the week reported is Monday 16 to Sunday 22.
const MON_8_PARIS = sec("2026-11-23T07:00:00Z");

beforeEach(async () => {
  e.AUTH_MODE = "app";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MON_8_PARIS * 1000);
  await env.DB.batch(
    ["digest_prefs", "clicks_daily", "clicks_daily_dim", "analytics_state", "links", "slug_locks", "domain_members", "domains", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  e.AUTH_MODE = origMode;
});

describe("weekOf: the local Monday and whether its email is due", () => {
  it("Monday before 07:00 local is not due yet; 07:00 is", () => {
    expect(weekOf(Date.parse("2026-11-23T05:59:00Z"), { zone: "Europe/Paris" })).toEqual({ week: "2026-11-23", due: false });
    expect(weekOf(Date.parse("2026-11-23T06:00:00Z"), { zone: "Europe/Paris" })).toEqual({ week: "2026-11-23", due: true });
  });
  it("the week is the viewer's, not UTC's", () => {
    // Monday 03:00 UTC is still Sunday evening in New York: the week before, and due (Sunday is later that week).
    expect(weekOf(Date.parse("2026-11-23T03:00:00Z"), { zone: "America/New_York" })).toEqual({ week: "2026-11-16", due: true });
    // Sunday 22:00 UTC is already Monday 07:00 in Tokyo, but the reported UTC Sunday is not over: due at 00:00 UTC.
    expect(weekOf(Date.parse("2026-11-22T22:00:00Z"), { zone: "Asia/Tokyo" })).toEqual({ week: "2026-11-23", due: false });
    expect(weekOf(Date.parse("2026-11-23T00:00:00Z"), { zone: "Asia/Tokyo" })).toEqual({ week: "2026-11-23", due: true });
  });
  it("an opt-in never gets a same-day catch-up", () => {
    expect(startWeek(Date.parse("2026-11-23T05:00:00Z"), { zone: "Europe/Paris" })).toBe("2026-11-16");
    expect(startWeek(Date.parse("2026-11-25T12:00:00Z"), { offset: 0 })).toBe("2026-11-23");
  });
});

describe("digestEmail", () => {
  it("escapes slugs and hosts in the HTML and keeps the text one line per link", () => {
    const range = resolveRange({ range: "custom", from: "2026-11-16", to: "2026-11-22" }, MON_8_PARIS);
    if ("error" in range) throw new Error("range");
    const report = buildReport(range, { days: [{ bucket: "2026-11-17", qr: 2, typed: 3, bots: 1, visitors: 0 }, { bucket: "2026-11-10", qr: 0, typed: 4, bots: 0, visitors: 0 }], links: [{ linkId: "l1", domainId: "d1", slug: "<b>x</b>\n", clicks: 5 }], dims: [], live: "ok" }, new Map([["d1", "ex\"ample.com"]]), { truncated: false, visitors: false });
    const m = digestEmail({ instanceName: "Acme\r\nBcc: x@example.com", week: "2026-11-23", report, dashboardUrl: "https://dash.example.com", unsubUrl: "https://dash.example.com/unsubscribe?u=1&t=abc" });
    expect(m.subject).toBe("Your week in AcmeBcc: x@example.com: 5 clicks");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<b>x</b>");
    expect(m.html).toContain("ex&quot;ample.com/&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).toContain('href="https://dash.example.com/unsubscribe?u=1&amp;t=abc"');
    expect(m.text).toContain("5 clicks: 2 from QR codes, 3 typed or clicked.");
    expect(m.text).toContain("+25% on the week before (4).");
  });
});

/** Domains: main (everyone), private dB owned by b. Clicks on Wednesday of the reported week. */
async function fixture() {
  const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dM','main.example.com','main','active',?,1),('dB','b.example.com','private','active',?,1)", b.user.id, b.user.id);
  for (const [id, d] of [["lM", "dM"], ["lB", "dB"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://example.com/',?,?,1,1)", id, d, `s-${id}`, `s-${id}`, b.user.id, b.user.id);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through','2026-11-21')");
  await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES ('2026-11-18','lM','dM','s-lM',1,2),('2026-11-18','lB','dB','s-lB',0,40)");
  for (const u of [a.user.id, b.user.id])
    await run("INSERT INTO digest_prefs (user_id,enabled,tz,secret,last_week,updated_at) VALUES (?,1,'Europe/Paris',?, '2026-11-16', 1)", u, "s".repeat(64));
  return { a, b };
}
const emailTo = (sent: { to: string[]; text: string }[], to: string) => sent.find((m) => m.to[0] === to)!;

describe("sendDigests", () => {
  it("a member never sees another member's private links; each gets exactly what Analytics shows them", async () => {
    await fixture();
    const fake = fakeResend();
    expect(await sendDigests(env, MON_8_PARIS)).toBe(2);
    const a = emailTo(fake.sent, "a@example.com"), b = emailTo(fake.sent, "b@example.com");
    expect(a.text).toContain("3 clicks");
    expect(a.text).not.toContain("b.example.com");
    expect(a.text).not.toContain("s-lB");
    expect(b.text).toContain("43 clicks");
    expect(b.text).toContain("b.example.com/s-lB: 40");
  });
  it("a retried run never sends twice: last_week is claimed, Resend gets an idempotency key", async () => {
    await fixture();
    const fake = fakeResend();
    const spy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await sendDigests(env, MON_8_PARIS);
    await sendDigests(env, MON_8_PARIS + 3600);
    expect(fake.sent).toHaveLength(2);
    const keys = spy.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>).map((h) => h["idempotency-key"]);
    expect(keys.every((k) => /^digest-.+-2026-11-23-0$/.test(k!))).toBe(true);
    const rows = (await env.DB.prepare("SELECT last_week FROM digest_prefs").all<{ last_week: string }>()).results;
    expect(rows.every((r) => r.last_week === "2026-11-23")).toBe(true);
  });
  it("a refused send releases the week so the next run tries again", async () => {
    const { a } = await fixture();
    await run("UPDATE digest_prefs SET enabled = 0 WHERE user_id != ?", a.user.id);
    const fake = fakeResend();
    fake.failNext(500);
    expect(await sendDigests(env, MON_8_PARIS)).toBe(0);
    expect((await env.DB.prepare("SELECT last_week FROM digest_prefs WHERE user_id = ?").bind(a.user.id).first<{ last_week: string }>())!.last_week).toBe("2026-11-16");
    expect(await sendDigests(env, MON_8_PARIS + 3600)).toBe(1);
  });
  it("a failing Resend is tried at most twice per run, so the run's subrequests stay bounded", async () => {
    await fixture();
    const c = await signedIn("c@example.com");
    await run("INSERT INTO digest_prefs (user_id,enabled,tz,secret,last_week,updated_at) VALUES (?,1,'Europe/Paris',?, '2026-11-16', 1)", c.user.id, "s".repeat(64));
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 500 }));
    expect(await sendDigests(env, MON_8_PARIS)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("not due before 07:00 local, nothing for disabled people or when email is off", async () => {
    const { a } = await fixture();
    const fake = fakeResend();
    expect(await sendDigests(env, sec("2026-11-23T05:00:00Z"))).toBe(0);
    await run("UPDATE users SET status = 'disabled' WHERE id = ?", a.user.id);
    await run("UPDATE digest_prefs SET enabled = 0 WHERE user_id != ?", a.user.id);
    expect(await sendDigests(env, MON_8_PARIS)).toBe(0);
    const prev = env.EMAIL_FROM;
    (env as { EMAIL_FROM?: string }).EMAIL_FROM = "";
    await run("UPDATE users SET status = 'active'");
    expect(await sendDigests(env, MON_8_PARIS)).toBe(0);
    (env as { EMAIL_FROM?: string }).EMAIL_FROM = prev;
    expect(fake.sent).toHaveLength(0);
  });
  it("carries a one-click unsubscribe that works without signing in, and only with the right token", async () => {
    const { a } = await fixture();
    const fake = fakeResend();
    await sendDigests(env, MON_8_PARIS);
    const mail = emailTo(fake.sent, "a@example.com") as unknown as { text: string; headers: Record<string, string> };
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = new URL(/(https:\/\/\S+\/unsubscribe\?\S+)/.exec(mail.text)![1]!);
    const path = url.pathname + url.search;
    vi.restoreAllMocks();
    expect((await dash(path)).status).toBe(200); // asks only: a mail scanner's GET changes nothing
    expect((await env.DB.prepare("SELECT enabled FROM digest_prefs WHERE user_id = ?").bind(a.user.id).first<{ enabled: number }>())!.enabled).toBe(1);
    const bad = `${url.pathname}?u=${a.user.id}&t=${await unsubToken("x".repeat(64), a.user.id)}`;
    expect((await dash(bad, { method: "POST" })).status).toBe(400);
    const ok = await dash(path, { method: "POST", headers: { origin: "https://mail.example.com" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await env.DB.prepare("SELECT enabled FROM digest_prefs WHERE user_id = ?").bind(a.user.id).first<{ enabled: number }>())!.enabled).toBe(0);
  });
});

describe("failed sends never starve the others", () => {
  /** Two failing recipients that sort first, one good one last; Resend answers `bad` for the failing ones. */
  async function three(bad: number) {
    const ids = ["u-a1", "u-a2", "u-z9"];
    for (const id of ids) {
      await signedIn(`${id}@example.com`, { id });
      await run("INSERT INTO digest_prefs (user_id,enabled,tz,secret,last_week,updated_at) VALUES (?,1,'UTC',?, '2026-11-16', 1)", id, "s".repeat(64));
    }
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dM','main.example.com','main','active','u-a1',1)");
    const calls: { to: string; key: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      const to = (JSON.parse(String(init!.body)) as { to: string[] }).to[0]!;
      calls.push({ to, key: (init!.headers as Record<string, string>)["idempotency-key"]! });
      return to.startsWith("u-z9") ? Response.json({ id: "e1" }) : Response.json({ message: "no" }, { status: bad });
    });
    const state = async (id: string) => (await env.DB.prepare("SELECT last_week, tries, last_error FROM digest_prefs WHERE user_id = ?").bind(id).first())!;
    return { calls, state };
  }

  it("2 refused recipients and 1 good one: the good one gets its email on the next run, the refused are not retried this week", async () => {
    const { calls, state } = await three(422);
    expect(await sendDigests(env, MON_8_PARIS)).toBe(0); // both attempts go to the refused addresses
    expect(await sendDigests(env, MON_8_PARIS + 3600)).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(["u-a1@example.com", "u-a2@example.com", "u-z9@example.com"]);
    expect(await state("u-a1")).toMatchObject({ last_week: "2026-11-23", last_error: "refused_422" });
    expect(await sendDigests(env, MON_8_PARIS + 7200)).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("transient failures go behind the others and retry with a new key; out of tries the week is given up", async () => {
    const { calls, state } = await three(503);
    await sendDigests(env, MON_8_PARIS);
    expect(await sendDigests(env, MON_8_PARIS + 3600)).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(["u-a1@example.com", "u-a2@example.com", "u-z9@example.com", "u-a1@example.com"]);
    expect(calls.filter((c) => c.to.startsWith("u-a1")).map((c) => c.key.slice(-2))).toEqual(["-0", "-1"]);
    expect(await state("u-a1")).toMatchObject({ last_week: "2026-11-16", tries: 2, last_error: "rejected_503" });
    for (let h = 2; h < 12; h++) await sendDigests(env, MON_8_PARIS + h * 3600);
    expect(calls.filter((c) => c.to.startsWith("u-a1"))).toHaveLength(6);
    expect(await state("u-a1")).toMatchObject({ last_week: "2026-11-23", last_error: "gave_up" });
  });

  it("outcomeOf: 409 and sends keep the week; network keeps the same key", () => {
    expect(outcomeOf({ ok: false, reason: "rejected", status: 409 })).toMatchObject({ keep: true });
    expect(outcomeOf({ ok: false, reason: "rejected", status: 429 })).toEqual({ keep: false, nextTry: true, error: "rejected_429" });
    expect(outcomeOf({ ok: false, reason: "network" })).toEqual({ keep: false, nextTry: false, error: "network" });
    expect(outcomeOf(null)).toMatchObject({ keep: false, nextTry: false });
  });
});

describe("/api/account/digest", () => {
  const call = (cookie: string, method: string, body?: unknown) =>
    dash("/api/account/digest", withCookie(cookie, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }));
  it("opt in and out with a validated zone; a new opt-in rotates the secret", async () => {
    const a = await signedIn("a@example.com");
    expect(await (await call(a.cookie, "GET")).json()).toEqual({ enabled: false, tz: null, emailReady: true });
    expect((await call(a.cookie, "PUT", { enabled: true, tz: "Mars/Base" })).status).toBe(400);
    expect((await call(a.cookie, "PUT", { enabled: true, tz: "Europe/Paris", extra: 1 })).status).toBe(400);
    expect((await call(a.cookie, "PUT", { enabled: true, tz: "Europe/Paris" })).status).toBe(200);
    const s1 = (await env.DB.prepare("SELECT secret, last_week FROM digest_prefs").first<{ secret: string; last_week: string }>())!;
    expect(s1.last_week).toBe("2026-11-23");
    await call(a.cookie, "PUT", { enabled: false, tz: "Europe/Paris" });
    await call(a.cookie, "PUT", { enabled: true, tz: "Europe/Paris" });
    expect((await env.DB.prepare("SELECT secret FROM digest_prefs").first<{ secret: string }>())!.secret).not.toBe(s1.secret);
    expect(await (await call(a.cookie, "GET")).json()).toEqual({ enabled: true, tz: "Europe/Paris", emailReady: true });
  });
  it("cannot turn on without email", async () => {
    const a = await signedIn("a@example.com");
    const prev = env.EMAIL_FROM;
    (env as { EMAIL_FROM?: string }).EMAIL_FROM = "";
    try {
      expect((await call(a.cookie, "PUT", { enabled: true, tz: "UTC" })).status).toBe(409);
      expect((await (await call(a.cookie, "GET")).json() as { emailReady: boolean }).emailReady).toBe(false);
    } finally {
      (env as { EMAIL_FROM?: string }).EMAIL_FROM = prev;
    }
  });
});
