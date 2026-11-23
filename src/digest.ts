import { buildReport, loadRows, localParts, parseTz, resolveRange, resolveScope, type AnalyticsReport, type Tz } from "./analytics";
import { dash } from "./dash";
import { displayName, emailConfigured, escapeHtml, sendEmail } from "./email";
import type { Env } from "./env";
import { ROLE_JOIN, USER_COLS } from "./roles";
import { getSettings } from "./settings";
import { rowToUser } from "./types";

/**
 * S10 weekly email summary. The hourly cron calls sendDigests: a person who opted in gets one email per local week, from
 * 07:00 on Monday in their zone, about the Monday to Sunday before (UTC days), scoped to exactly what they may see in
 * Analytics. `last_week` is claimed before the send and released if Resend refuses it, and Resend's Idempotency-Key covers
 * a retry of the same week, so a re-run cron never sends twice.
 */

export const DIGEST_HOUR = 7;
/**
 * Emails per hourly run: each is one report (6 Analytics Engine reads per id chunk) plus a Resend call, next to the rollup's
 * 15 and the update check, under the Free plan's 50 subrequests.
 * shortcut: 2 an hour is 48 a day, about 330 a week (the send window runs until Sunday); raise it on Workers Paid if more people opt in.
 */
export const DIGESTS_PER_RUN = 2;
const TOP = 5;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The local Monday of the week `ms` is in, and whether the summary of the week before is due: Monday from 07:00 local (or
 * later that week), and never before the reported UTC days are over (a zone ahead of UTC reaches Monday first).
 */
export function weekOf(ms: number, tz: Tz): { week: string; due: boolean } {
  const p = localParts(ms, tz);
  const week = addDays(p.day, -p.dow);
  return { week, due: (p.dow > 0 || p.hour >= DIGEST_HOUR) && ms >= Date.parse(`${week}T00:00:00Z`) };
}

/** On opt-in: the newest week that counts as already handled, so the first email is the next due Monday, never a catch-up the same day. */
export function startWeek(ms: number, tz: Tz): string {
  const w = weekOf(ms, tz);
  return w.due ? w.week : addDays(w.week, -7);
}

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mac(secret: string, msg: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(`digest-unsub|${msg}`));
}
/** A new per-person secret (32 random bytes, hex): a new one on each opt-in, so older unsubscribe links stop working. */
export const newSecret = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
export const unsubToken = async (secret: string, userId: string): Promise<string> => b64url(await mac(secret, userId));

/** Turns the summary off when `token` is the person's current signature. Constant-time compare; true when it matched. */
export async function unsubscribe(env: Env, userId: string, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const row = await env.DB.prepare("SELECT secret FROM digest_prefs WHERE user_id = ?").bind(userId).first<{ secret: string }>();
  if (!row) return false;
  const want = new Uint8Array(await mac(row.secret, userId));
  const got = Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  if (got.byteLength !== want.byteLength || !crypto.subtle.timingSafeEqual(got, want)) return false;
  await env.DB.prepare("UPDATE digest_prefs SET enabled = 0, updated_at = ? WHERE user_id = ?").bind(Math.floor(Date.now() / 1000), userId).run();
  return true;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

/** Plain text plus simple HTML, every interpolation escaped (hosts and slugs are people's text); no images, no tracking. */
export function digestEmail(o: { instanceName: string | null; week: string; report: AnalyticsReport; dashboardUrl: string; unsubUrl: string }): { subject: string; text: string; html: string } {
  const r = o.report, t = r.totals, name = displayName(o.instanceName);
  const change = t.prevClicks === null ? (t.clicks ? "No clicks the week before." : "") : `${t.clicks >= t.prevClicks ? "+" : ""}${Math.round(((t.clicks - t.prevClicks) / t.prevClicks) * 100)}% on the week before (${fmt(t.prevClicks)}).`;
  const head = `Clicks from ${r.from} to ${r.to} (UTC days) on links you can see in ${name}:`;
  const lines = [`${fmt(t.clicks)} clicks: ${fmt(t.qr)} from QR codes, ${fmt(t.typed)} typed or clicked.`, change].filter(Boolean);
  const top = r.links.slice(0, TOP).map((l) => `${oneLine(l.host || "Unknown domain")}/${oneLine(l.slug)}: ${fmt(l.clicks)}`);
  const open = `${o.dashboardUrl}/analytics`;
  const foot = "You get this because you turned on the weekly email in your account. Turn it off:";
  const text = [head, "", ...lines, "", ...(top.length ? ["Top links", ...top, ""] : []), `Open analytics: ${open}`, "", foot, o.unsubUrl, ""].join("\n");
  const e = escapeHtml;
  const html =
    `<p>${e(head)}</p>\n` + lines.map((l) => `<p>${e(l)}</p>\n`).join("") +
    (top.length ? `<p><b>Top links</b></p>\n<ol>${top.map((l) => `<li>${e(l)}</li>`).join("")}</ol>\n` : "") +
    `<p><a href="${e(open)}">Open analytics</a></p>\n<p>${e(foot)} <a href="${e(o.unsubUrl)}">unsubscribe</a></p>\n`;
  return { subject: `Your week in ${name}: ${fmt(t.clicks)} clicks`, text, html };
}

type Pref = { user_id: string; tz: string; secret: string; last_week: string | null; email: string };

/** One run's sends (at most DIGESTS_PER_RUN). Returns how many went out; a failure of one person never stops the others. */
export async function sendDigests(env: Env, nowSec: number): Promise<number> {
  const d = dash(env);
  if (!d || !(await emailConfigured(env))) return 0;
  const now = nowSec * 1000;
  const prefs = (await env.DB.prepare(
    "SELECT p.user_id, p.tz, p.secret, p.last_week, u.email FROM digest_prefs p JOIN users u ON u.id = p.user_id WHERE p.enabled = 1 AND u.status = 'active' ORDER BY p.last_week, p.user_id LIMIT 500",
  ).all<Pref>()).results;
  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  let sent = 0, tried = 0;
  for (const p of prefs) {
    if (tried >= DIGESTS_PER_RUN) break; // attempts, not successes: a failing Resend must not spend the run's subrequests
    const tz = parseTz(p.tz);
    if (!tz) continue;
    const w = weekOf(now, tz);
    if (!w.due || (p.last_week !== null && p.last_week >= w.week)) continue;
    // Claim first: two overlapping runs cannot both pass this guard for the same week.
    const claim = await env.DB.prepare("UPDATE digest_prefs SET last_week = ?1 WHERE user_id = ?2 AND enabled = 1 AND (last_week IS NULL OR last_week < ?1)")
      .bind(w.week, p.user_id).run();
    if (!claim.meta.changes) continue;
    tried++;
    const release = () => env.DB.prepare("UPDATE digest_prefs SET last_week = ? WHERE user_id = ? AND last_week = ?").bind(p.last_week, p.user_id, w.week).run();
    try {
      settings ??= await getSettings(env);
      const mail = await buildFor(env, p, w.week, nowSec, d.base, settings.name);
      const res = mail && (await sendEmail(env, {
        to: p.email, ...mail, name: settings.name, idempotencyKey: `digest-${p.user_id}-${w.week}`,
        headers: { "List-Unsubscribe": `<${mail.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }));
      if (res && res.ok) sent++;
      // The next hourly run tries again; the same Idempotency-Key keeps it to one email for 24 hours.
      // shortcut: an accepted send whose answer is lost is retried; past Resend's 24-hour key window that could send twice. Store a send state if that shows.
      else await release();
    } catch (e) {
      console.error("weekly email failed", e instanceof Error ? e.name : "unknown");
      await release().catch(() => undefined);
    }
  }
  return sent;
}

async function buildFor(env: Env, p: Pref, week: string, nowSec: number, base: string, instanceName: string | null) {
  const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.id = ?`).bind(p.user_id).first();
  if (!row) return null;
  const user = rowToUser(row);
  const range = resolveRange({ range: "custom", from: addDays(week, -7), to: addDays(week, -1) }, nowSec);
  if ("error" in range) return null;
  // The same scope as their Analytics screen with no filters (no grant: this is the person, not a key).
  const s = await resolveScope(env, user, null, "", null);
  if ("error" in s) return null;
  const rows = await loadRows(env, range, s.scope, nowSec);
  if (rows.live === "unavailable") return null; // recent days missing: released, the next run tries again
  const hosts = new Map((await env.DB.prepare("SELECT id, host FROM domains").all<{ id: string; host: string }>()).results.map((x) => [x.id, x.host]));
  const report = buildReport(range, rows, hosts, { truncated: false, visitors: false });
  const unsubUrl = `${base}/unsubscribe?u=${encodeURIComponent(p.user_id)}&t=${await unsubToken(p.secret, p.user_id)}`;
  return { ...digestEmail({ instanceName, week, report, dashboardUrl: base, unsubUrl }), unsubUrl };
}
