import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addClicks, ALERT_CRON, alertEmail, findAlerts, sendAlerts, type ClickTable, type LinkInfo } from "../src/alerts";
import { unsubscribe, unsubToken } from "../src/digest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { dash } from "./helpers/access";
import { signedIn, withCookie } from "./helpers/session";

const e = env as { AUTH_MODE?: string };
const origMode = e.AUTH_MODE;
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = sec("2026-11-23T10:45:00Z"); // today 2026-11-23: baseline 10-12..11-08, quiet window 11-09.., yesterday 11-22, week 11-15..11-21
const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const aeEnv = (): Env => ({ ...env, CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" }) as unknown as Env;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** One fake for Analytics Engine and Resend: `ae` are the rows (or a status) for the next AE query; mails are recorded. */
function fakes() {
  const sent: { to: string[]; subject: string; text: string; html: string; headers?: Record<string, string> }[] = [];
  const keys: string[] = [];
  const s = { ae: [] as unknown[] | number, aeCalls: 0, resend: 200 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SQL_URL) {
      s.aeCalls++;
      if (typeof s.ae === "number") return new Response("no", { status: s.ae });
      return Response.json({ data: s.ae, rows: s.ae.length });
    }
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch ${url}`);
    sent.push(JSON.parse(String(init!.body)));
    keys.push((init!.headers as Record<string, string>)["idempotency-key"]!);
    if (s.resend === 0) throw new TypeError("network"); // 0: the answer is lost
    return s.resend === 200 ? Response.json({ id: "e1" }) : Response.json({ message: "no" }, { status: s.resend });
  });
  return { sent, keys, s };
}

beforeEach(async () => {
  e.AUTH_MODE = "app";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  await env.DB.batch(
    ["alert_prefs", "alert_state", "auth_limits", "clicks_daily", "analytics_state", "links", "slug_locks", "domain_members", "domains", "sessions", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  e.AUTH_MODE = origMode;
});

/**
 * Main domain dM (everyone) with lQ (10 a day in the baseline, then nothing: quiet) and lS (2 a day the week before, 30
 * yesterday from Analytics Engine: spike); private dB owned by b with lP (a spike only b may see).
 */
async function fixture() {
  const a = await signedIn("a@example.com"), b = await signedIn("b@example.com");
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dM','main.example.com','main','active',?,1),('dB','b.example.com','private','active',?,1)", b.user.id, b.user.id);
  for (const [id, d] of [["lQ", "dM"], ["lS", "dM"], ["lP", "dB"]])
    await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://example.com/',?,?,1,1)", id, d, `s-${id}`, `s-${id}`, b.user.id, b.user.id);
  await run("INSERT INTO analytics_state (k,v) VALUES ('rolled_through','2026-11-21')");
  for (let day = "2026-10-12"; day <= "2026-11-08"; day = addDays(day, 1)) await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,'lQ','dM','s-lQ',4,6)", day);
  for (let day = "2026-11-15"; day <= "2026-11-21"; day = addDays(day, 1))
    await run("INSERT INTO clicks_daily (day,link_id,domain_id,slug,qr,typed) VALUES (?,'lS','dM','s-lS',0,2),(?,'lP','dB','s-lP',0,2)", day, day);
  for (const u of [a.user.id, b.user.id]) await run("INSERT INTO alert_prefs (user_id,enabled,secret,updated_at) VALUES (?,1,?,1)", u, "s".repeat(64));
  const f = fakes();
  f.s.ae = [{ bucket: "2026-11-22 00:00:00", linkId: "lS", domainId: "dM", n: 30 }, { bucket: "2026-11-22 00:00:00", linkId: "lP", domainId: "dB", n: 25 }];
  return { a, b, ...f };
}
const mailTo = <M extends { to: string[] }>(sent: M[], to: string) => sent.find((m) => m.to[0] === to);
const prefs = async (id: string) => (await env.DB.prepare("SELECT last_day, tries, attempts, claimed_at, last_error FROM alert_prefs WHERE user_id = ?").bind(id).first<Record<string, unknown>>())!;

describe("findAlerts", () => {
  const link = (id: string, domainId = "d1"): LinkInfo => ({ id, slug: id, name: null, domainId, host: "go.example.com" });
  const table = (fill: (t: ClickTable) => void) => { const t: ClickTable = new Map(); fill(t); return t; };
  const today = "2026-11-23";
  it("quiet needs an average of 5 a day over days 15-42 and none in the last 14 days, today included", () => {
    const links = new Map([["q", link("q")]]);
    const base = (n: number) => table((t) => addClicks(t, today, "q", "d1", "2026-10-20", n));
    expect(findAlerts(base(139), links, null, { quiet: true, spike: true })).toEqual([]);
    expect(findAlerts(base(140), links, null, { quiet: true, spike: true })).toMatchObject([{ kind: "quiet", avg: 5 }]);
    const t = base(500);
    addClicks(t, today, "q", "d1", today, 1);
    expect(findAlerts(t, links, null, { quiet: true, spike: true })).toEqual([]);
    expect(findAlerts(base(500), links, null, { quiet: false, spike: true })).toEqual([]);
    // The 14 days are today and the 13 before it: a click 14 days ago does not count against quiet.
    const edge = (day: string) => { const x = base(500); addClicks(x, today, "q", "d1", day, 1); return findAlerts(x, links, null, { quiet: true, spike: false }); };
    expect(edge("2026-11-09")).toHaveLength(1);
    expect(edge("2026-11-10")).toEqual([]);
  });
  it("spike needs at least 20 yesterday and 3 times the 7-day average before it", () => {
    const links = new Map([["s", link("s")]]);
    const spike = (yday: number, week: number) => table((t) => {
      addClicks(t, today, "s", "d1", "2026-11-22", yday);
      addClicks(t, today, "s", "d1", "2026-11-18", week);
    });
    expect(findAlerts(spike(19, 0), links, null, { quiet: true, spike: true })).toEqual([]);
    expect(findAlerts(spike(30, 70), links, null, { quiet: true, spike: true })).toMatchObject([{ kind: "spike", clicks: 30, avg: 10 }]);
    expect(findAlerts(spike(29, 70), links, null, { quiet: true, spike: true })).toEqual([]);
  });
  it("counts only clicks on the person's domains, and only links whose domain they can use", () => {
    const t = table((x) => {
      addClicks(x, today, "m", "d1", "2026-11-22", 15);
      addClicks(x, today, "m", "d2", "2026-11-22", 15); // the link's clicks before it moved to d1
    });
    const links = new Map([["m", link("m", "d1")]]);
    expect(findAlerts(t, links, null, { quiet: true, spike: true })).toHaveLength(1);
    expect(findAlerts(t, links, new Set(["d1"]), { quiet: true, spike: true })).toEqual([]);
    expect(findAlerts(t, links, new Set(["d2"]), { quiet: true, spike: true })).toEqual([]);
  });
});

describe("alertEmail", () => {
  it("escapes hosts, slugs and names in the HTML and keeps one line per alert", () => {
    const l: LinkInfo = { id: "l1", slug: "<b>x</b>\n", name: "N\"<i>", domainId: "d", host: "ex\"ample.com" };
    const m = alertEmail({ instanceName: "Acme\r\nBcc: x@example.com", day: "2026-11-23", alerts: [{ kind: "spike", link: l, clicks: 30, avg: 2 }], dashboardUrl: "https://dash.example.com", unsubUrl: "https://dash.example.com/unsubscribe?k=alerts&u=1&t=abc" });
    expect(m.subject).toBe("1 link alert in AcmeBcc: x@example.com");
    expect(m.html).not.toContain("<b>x</b>");
    expect(m.html).not.toContain("<i>");
    expect(m.html).toContain('href="https://dash.example.com/unsubscribe?k=alerts&amp;u=1&amp;t=abc"');
    expect(m.text).toContain("Spike: ex\"ample.com/<b>x</b>  (N\"<i>): 30 clicks on 2026-11-22, about 2 a day the week before.");
    expect(m.text).toContain("https://dash.example.com/analytics/link/l1");
  });
});

describe("sendAlerts", () => {
  it("each person gets one email with exactly the links they can see", async () => {
    const f = await fixture();
    expect(await sendAlerts(aeEnv(), NOW)).toBe(2);
    const a = mailTo(f.sent, "a@example.com")!, b = mailTo(f.sent, "b@example.com")!;
    expect(a.text).toContain("Spike: main.example.com/s-lS: 30 clicks on 2026-11-22");
    expect(a.text).toContain("Gone quiet: main.example.com/s-lQ: no clicks in 14 days, about 10 a day before that.");
    expect(a.text).not.toContain("b.example.com");
    expect(b.text).toContain("Spike: b.example.com/s-lP: 25 clicks");
    expect(a.subject).toBe("2 link alerts in linkwarren");
    expect(f.keys.every((k) => /^alert-.+-2026-11-23-0$/.test(k))).toBe(true);
    // Analytics Engine is read once per run, from the day after the watermark.
    expect(f.s.aeCalls).toBe(1);
  });

  it("never repeats: later runs today send nothing, and tomorrow neither the spike nor the quiet link comes again", async () => {
    const f = await fixture();
    await sendAlerts(aeEnv(), NOW);
    expect(await sendAlerts(aeEnv(), NOW + 3600)).toBe(0);
    expect(f.s.aeCalls).toBe(1); // nobody due: no Analytics Engine read
    f.s.ae = [];
    expect(await sendAlerts(aeEnv(), NOW + 86400)).toBe(0);
    expect(f.sent).toHaveLength(2);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM alert_state").first<{ n: number }>())!.n).toBe(5);
    expect((await prefs(f.a.user.id)).last_day).toBe("2026-11-24");
  });

  it("a person checked with nothing to send goes behind the people not looked at yet", async () => {
    const f = await fixture();
    await run("DELETE FROM clicks_daily");
    f.s.ae = [];
    await sendAlerts(aeEnv(), NOW);
    const at = (await env.DB.prepare("SELECT last_attempt_at FROM alert_prefs WHERE user_id = ?").bind(f.a.user.id).first<{ last_attempt_at: number }>())!;
    expect([at.last_attempt_at, (await prefs(f.a.user.id)).last_day]).toEqual([NOW, "2026-11-23"]);
  });

  it("a new spike the next day is a new email; a link that clicked in the last 14 days is not quiet", async () => {
    const f = await fixture();
    await sendAlerts(aeEnv(), NOW);
    f.s.ae = [{ bucket: "2026-11-23 00:00:00", linkId: "lS", domainId: "dM", n: 90 }, { bucket: "2026-11-23 00:00:00", linkId: "lQ", domainId: "dM", n: 1 }];
    expect(await sendAlerts(aeEnv(), NOW + 86400)).toBe(2);
    expect(mailTo(f.sent.slice(2), "a@example.com")!.text).toContain("90 clicks on 2026-11-23");
  });

  it("sends nothing when Analytics Engine fails or is not set up: missing days never read as quiet", async () => {
    const f = await fixture();
    f.s.ae = 500;
    await expect(sendAlerts(aeEnv(), NOW)).rejects.toThrow();
    expect(await sendAlerts(env, NOW)).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect((await prefs(f.a.user.id)).last_day).toBeNull();
  });

  it("a refused send releases the day for the next run, with a new key", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET enabled = 0 WHERE user_id != ?", f.a.user.id);
    f.s.resend = 503;
    expect(await sendAlerts(aeEnv(), NOW)).toBe(0);
    expect(await prefs(f.a.user.id)).toMatchObject({ last_day: null, tries: 1, attempts: 1, claimed_at: null, last_error: "rejected_503" });
    f.s.resend = 200;
    expect(await sendAlerts(aeEnv(), NOW + 3600)).toBe(1);
    expect(f.keys.map((k) => k.slice(-2))).toEqual(["-0", "-1"]);
  });

  it("R6: at most 20 alert emails per instance per day", async () => {
    const f = await fixture();
    await run("INSERT INTO auth_limits (key, window_start, count) VALUES ('alert:day', ?, 20)", NOW - 60);
    expect(await sendAlerts(aeEnv(), NOW)).toBe(0);
    expect(f.sent).toHaveLength(0);
  });

  it("a person who lost access to a domain stops getting its links (scope re-read at send time)", async () => {
    const f = await fixture();
    await run("UPDATE domains SET owner_id = ? WHERE id = 'dB'", f.a.user.id);
    await sendAlerts(aeEnv(), NOW);
    expect(mailTo(f.sent, "b@example.com")!.text).not.toContain("s-lP");
    expect(mailTo(f.sent, "a@example.com")!.text).toContain("s-lP");
  });

  it("only the kinds the person picked; turned off or disabled people get nothing", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET spike = 0 WHERE user_id = ?", f.a.user.id);
    await run("UPDATE users SET status = 'disabled' WHERE id = ?", f.b.user.id);
    expect(await sendAlerts(aeEnv(), NOW)).toBe(1);
    expect(f.sent[0]!.text).not.toContain("Spike");
    expect(f.sent[0]!.text).toContain("Gone quiet");
  });
});

describe("cron dispatch and unsubscribe", () => {
  const ctl = (cron: string) => ({ cron, scheduledTime: NOW * 1000, noRetry() {} }) as ScheduledController;
  it(`only the ${ALERT_CRON} trigger sends alerts; the rollup trigger never does`, async () => {
    const f = await fixture();
    f.s.ae = [];
    await worker.scheduled(ctl("15 * * * *"), aeEnv(), {} as ExecutionContext);
    expect((await prefs(f.a.user.id)).last_day).toBeNull();
    await worker.scheduled(ctl(ALERT_CRON), aeEnv(), {} as ExecutionContext);
    expect((await prefs(f.a.user.id)).last_day).toBe("2026-11-23");
  });

  it("the email's unsubscribe turns alerts off without signing in; a weekly email token does not", async () => {
    const f = await fixture();
    await sendAlerts(aeEnv(), NOW);
    const mail = mailTo(f.sent, "a@example.com")!;
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = new URL(/(https:\/\/\S+\/unsubscribe\?\S+)/.exec(mail.text)![1]!);
    vi.restoreAllMocks();
    const ask = await dash(url.pathname + url.search);
    expect(await ask.text()).toContain("Stop the link alert emails?");
    const digestTok = await unsubToken("s".repeat(64), f.a.user.id, "digest");
    expect((await dash(`/unsubscribe?k=alerts&u=${f.a.user.id}&t=${digestTok}`, { method: "POST" })).status).toBe(400);
    expect((await dash(url.pathname + url.search, { method: "POST" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT enabled FROM alert_prefs WHERE user_id = ?").bind(f.a.user.id).first<{ enabled: number }>())!.enabled).toBe(0);
  });
});

describe("GET/PUT /api/account/alerts", () => {
  const ae = env as unknown as Record<string, unknown>;
  const withAe = () => Object.assign(ae, { CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: "tok" });
  afterEach(() => { delete ae.CLICKS; delete ae.CF_ACCOUNT_ID; delete ae.AE_READ_TOKEN; });

  it("refuses turning on without live analytics reads, and says so", async () => {
    const a = await signedIn("a@example.com");
    const r = await dash("/api/account/alerts", withCookie(a.cookie, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, quiet: true, spike: true }) }));
    expect([r.status, await r.json()]).toEqual([409, { error: "analytics_not_configured" }]);
    expect(((await (await dash("/api/account/alerts", withCookie(a.cookie))).json()) as { analyticsReady: boolean }).analyticsReady).toBe(false);
  });

  it("defaults to off with both kinds, saves, and refuses turning on without email", async () => {
    withAe();
    const a = await signedIn("a@example.com");
    const get = async () => (await dash("/api/account/alerts", withCookie(a.cookie))).json();
    expect(await get()).toEqual({ enabled: false, quiet: true, spike: true, emailReady: true, analyticsReady: true });
    const put = (b: unknown) => dash("/api/account/alerts", withCookie(a.cookie, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    expect((await put({ enabled: true, quiet: false, spike: true })).status).toBe(200);
    expect(await get()).toEqual({ enabled: true, quiet: false, spike: true, emailReady: true, analyticsReady: true });
    expect((await put({ enabled: true, quiet: true, spike: true, extra: 1 })).status).toBe(400);
    const s1 = (await env.DB.prepare("SELECT secret FROM alert_prefs").first<{ secret: string }>())!.secret;
    await env.DB.prepare("UPDATE alert_prefs SET pending = '{}'").run(); // a saved email, signed with s1
    await put({ enabled: false, quiet: true, spike: true });
    expect((await env.DB.prepare("SELECT pending FROM alert_prefs").first<{ pending: string | null }>())!.pending).toBe("{}"); // off keeps it
    await put({ enabled: true, quiet: true, spike: true });
    const row = (await env.DB.prepare("SELECT secret, pending FROM alert_prefs").first<{ secret: string; pending: string | null }>())!;
    expect(row.secret).not.toBe(s1);
    expect(row.pending).toBeNull(); // back on: the old email (old unsubscribe link) is dropped and rebuilt
    const prev = env.EMAIL_FROM;
    (env as { EMAIL_FROM?: string }).EMAIL_FROM = "";
    try {
      expect((await put({ enabled: true, quiet: true, spike: true })).status).toBe(409);
      expect((await put({ enabled: false, quiet: true, spike: true })).status).toBe(200);
    } finally {
      (env as { EMAIL_FROM?: string }).EMAIL_FROM = prev;
    }
  });
});

describe("fix round (whole-branch review)", () => {
  /** The test env with Analytics Engine and a DB whose `batch` runs `hook(n)` first (n counts batch calls from 1). */
  const hooked = (hook: (n: number) => void | Promise<void>): Env => {
    const real = env.DB;
    let n = 0;
    const DB = { prepare: (q: string) => real.prepare(q), batch: async (s: D1PreparedStatement[]) => { await hook(++n); return real.batch(s); } } as unknown as D1Database;
    return { ...aeEnv(), DB };
  };

  it("every new alert is in the one email of the day: none is left for a later email that would never come", async () => {
    const f = await fixture();
    const extra = Array.from({ length: 12 }, (_, i) => `lX${i}`);
    for (const id of extra)
      await run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,'dM',?,?,'https://example.com/',?,?,1,1)", id, id, id, f.b.user.id, f.b.user.id);
    (f.s.ae as unknown[]).push(...extra.map((id) => ({ bucket: "2026-11-22 00:00:00", linkId: id, domainId: "dM", n: 40 })));
    await sendAlerts(aeEnv(), NOW);
    const a = mailTo(f.sent, "a@example.com")!;
    expect(a.subject).toBe("14 link alerts in linkwarren");
    expect(a.text.match(/^Spike: /gm)).toHaveLength(13);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM alert_state WHERE user_id = ?").bind(f.a.user.id).first<{ n: number }>())!.n).toBe(14);
  });

  it("a retry under the same key sends the saved email, never a rebuilt list, and marks only its alerts as told", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET enabled = 0 WHERE user_id != ?", f.a.user.id);
    f.s.resend = 0; // accepted or not, the answer is lost: released with the same key
    await sendAlerts(aeEnv(), NOW);
    const first = f.sent[0]!;
    f.s.resend = 200;
    f.s.ae = [{ bucket: "2026-11-22 00:00:00", linkId: "lQ", domainId: "dM", n: 50 }]; // the data changed: lS no longer spikes
    await sendAlerts(aeEnv(), NOW + 3600);
    expect(f.sent).toHaveLength(2);
    expect([f.sent[1]!.text, f.sent[1]!.subject]).toEqual([first.text, first.subject]);
    expect(f.keys[0]).toBe(f.keys[1]);
    const told = (await env.DB.prepare("SELECT link_id, kind FROM alert_state WHERE user_id = ? ORDER BY link_id").bind(f.a.user.id).all()).results;
    expect(told).toEqual([{ link_id: "lQ", kind: "quiet" }, { link_id: "lS", kind: "spike" }]);
    expect((await env.DB.prepare("SELECT pending FROM alert_prefs WHERE user_id = ?").bind(f.a.user.id).first<{ pending: string | null }>())!.pending).toBeNull();
  });

  it("a saved email is not sent again once its reader may no longer see a link in it", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET enabled = 0 WHERE user_id != ?", f.b.user.id);
    f.s.resend = 0;
    await sendAlerts(aeEnv(), NOW);
    expect(f.sent[0]!.text).toContain("s-lP");
    await run("UPDATE domains SET owner_id = ? WHERE id = 'dB'", f.a.user.id); // b loses the private domain
    f.s.resend = 200;
    await sendAlerts(aeEnv(), NOW + 3600);
    expect(f.sent).toHaveLength(1);
    expect(await prefs(f.b.user.id)).toMatchObject({ last_day: "2026-11-23", claimed_at: null });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM alert_state").first<{ n: number }>())!.n).toBe(0);
  });

  it("a saved email is withheld once its reader loses a domain whose clicks it counted, even if the link's own domain stays", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET enabled = 0 WHERE user_id != ?", f.b.user.id);
    await run("UPDATE links SET domain_id = 'dM' WHERE id = 'lP'"); // moved to the main domain; yesterday's clicks were on dB
    f.s.resend = 0;
    await sendAlerts(aeEnv(), NOW);
    expect(f.sent[0]!.text).toContain("Spike: main.example.com/s-lP: 25 clicks");
    await run("UPDATE domains SET owner_id = ? WHERE id = 'dB'", f.a.user.id);
    f.s.resend = 200;
    await sendAlerts(aeEnv(), NOW + 3600);
    expect(f.sent).toHaveLength(1);
    expect(await prefs(f.b.user.id)).toMatchObject({ last_day: "2026-11-23", claimed_at: null });
  });

  it("a claim write that fails gives the daily slot back", async () => {
    const f = await fixture();
    const real = env.DB;
    const DB = {
      prepare: (q: string) => (q.includes("pending = ?11") ? { bind: () => ({ run: () => Promise.reject(new Error("d1 down")) }) } : real.prepare(q)),
      batch: (s: D1PreparedStatement[]) => real.batch(s),
    } as unknown as D1Database;
    expect(await sendAlerts({ ...aeEnv(), DB }, NOW)).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count FROM auth_limits WHERE key = 'alert:day'").first<{ count: number }>())!.count).toBe(0);
  });

  it("one person's failure skips only that person; the run goes on with the next", async () => {
    const f = await fixture();
    expect(await sendAlerts(hooked((n) => { if (n === 1) throw new Error("d1 down"); }), NOW)).toBe(1);
    expect(f.sent).toHaveLength(1);
  });

  it("a change of kinds between the read and the claim stops the claim; the next run builds the email again", async () => {
    const f = await fixture();
    await run("UPDATE alert_prefs SET enabled = 0 WHERE user_id != ?", f.a.user.id);
    await sendAlerts(hooked(async (n) => { if (n === 1) await run("UPDATE alert_prefs SET quiet = 0 WHERE user_id = ?", f.a.user.id); }), NOW);
    expect(f.sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count FROM auth_limits WHERE key = 'alert:day'").first<{ count: number }>())!.count).toBe(0); // refunded
    await sendAlerts(aeEnv(), NOW + 60);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).not.toContain("Gone quiet");
  });

  it("settings that cannot be read stop before the daily cap is spent", async () => {
    const f = await fixture();
    const real = env.DB;
    const DB = { prepare: (q: string) => { if (q.includes("FROM settings")) throw new Error("settings down"); return real.prepare(q); }, batch: (s: D1PreparedStatement[]) => real.batch(s) } as unknown as D1Database;
    await sendAlerts({ ...aeEnv(), DB }, NOW);
    expect(f.sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT count FROM auth_limits WHERE key = 'alert:day'").first()).toBeNull();
  });

  it("an unsubscribe link signed with an older secret never turns off alerts that were turned on again", async () => {
    const f = await fixture();
    const old = await unsubToken("s".repeat(64), f.a.user.id, "alerts");
    await run("UPDATE alert_prefs SET secret = ? WHERE user_id = ?", "t".repeat(64), f.a.user.id);
    expect(await unsubscribe(env, f.a.user.id, old, "alerts")).toBe(false);
    expect(await unsubscribe(env, f.a.user.id, await unsubToken("t".repeat(64), f.a.user.id, "alerts"), "alerts")).toBe(true);
  });
});
