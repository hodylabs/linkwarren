import { buildReport, loadRows, localParts, parseTz, resolveRange, resolveScope, type AnalyticsReport, type Tz } from "./analytics";
import { rolledThrough } from "./cron";
import { dash } from "./dash";
import { displayName, emailConfigured, escapeHtml, sendEmail, type SendResult } from "./email";
import type { Env } from "./env";
import { ROLE_JOIN, USER_COLS } from "./roles";
import { getSettings } from "./settings";
import { rowToUser } from "./types";

/**
 * S10 weekly email summary. The hourly cron calls sendDigests: a person who opted in gets one email per local week, from
 * 07:00 on Monday in their zone, about the Monday to Sunday before (UTC days), scoped to exactly what they may see in
 * Analytics. `last_week` is claimed before the send; outcomeOf decides whether a failed send keeps the week or releases it, and Resend's Idempotency-Key covers
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

type Pref = {
  user_id: string; tz: string; secret: string; last_week: string | null; try_week: string | null;
  tries: number; attempts: number; claimed_at: number | null; email: string;
};

/** Delivery attempts per person and week (every claim counts, network failures too) before that week is given up (`gave_up`). */
export const MAX_TRIES = 6;
/** A claim older than this with no outcome written (the run died, or its release failed) is unfinished: a later run resumes it. */
export const CLAIM_STALE_SEC = 3600;

/** What one attempt's outcome does to the claimed week. */
type Outcome = { keep: boolean; nextTry: boolean; error: string | null };

/**
 * - Sent: keep the week.
 * - 409 invalid_idempotent_request: this key already reached Resend with another body, so an earlier attempt (whose answer
 *   was lost) was accepted: keep the week. Any other 409 (concurrent_idempotent_requests: the first request is still
 *   running and may yet fail): release with the same key, so the retry either matches it or recovers.
 * - Any other 4xx except 401, 403 and 429: a permanent refusal (bad or suppressed address): keep the week, no retry, error recorded.
 * - 401, 403, 429 or 5xx: Resend answered and did not send: release, and the next attempt uses a new key (`nextTry`), so a payload
 *   rebuilt from newer clicks is never refused for reusing a key with a different body.
 * - Network, settings, or report data not loadable: maybe sent (network) or never tried: release with the same key, so an
 *   accepted send whose answer was lost is not delivered again inside Resend's 24-hour key window.
 * Every attempt counts toward MAX_TRIES whatever the outcome.
 */
export function outcomeOf(res: SendResult | null): Outcome {
  if (!res) return { keep: false, nextTry: false, error: "data_unavailable" };
  if (res.ok) return { keep: true, nextTry: false, error: null };
  if (res.reason !== "rejected") return { keep: false, nextTry: false, error: res.reason };
  const st = res.status ?? 0;
  if (st === 409) return res.name === "invalid_idempotent_request" ? { keep: true, nextTry: false, error: "duplicate" } : { keep: false, nextTry: false, error: "in_progress" };
  // 401 and 403 are the instance's key or sender account, not the address: retried like a 5xx, still bounded by MAX_TRIES.
  if (st >= 400 && st < 500 && st !== 429 && st !== 401 && st !== 403) return { keep: true, nextTry: false, error: `refused_${st}` };
  return { keep: false, nextTry: true, error: `rejected_${st}` };
}

/**
 * One run's sends (at most DIGESTS_PER_RUN attempts). Returns how many went out; one person's failure never stops the others.
 * People are taken by `last_attempt_at` (never tried first), bumped on every attempt, so a failing address goes behind
 * everyone else and cannot starve them.
 */
export async function sendDigests(env: Env, nowSec: number): Promise<number> {
  const d = dash(env);
  if (!d || !(await emailConfigured(env))) return 0;
  const now = nowSec * 1000;
  const stale = nowSec - CLAIM_STALE_SEC;
  // No zone is more than 14 hours ahead of UTC, so last_week at or past the week there is done for everyone: filtered in SQL,
  // done rows never fill the candidate limit ahead of someone still due. Unfinished (stale) claims stay in.
  const doneWeek = weekOf(now, { offset: 840 }).week;
  const prefs = (await env.DB.prepare(
    `SELECT p.user_id, p.tz, p.secret, p.last_week, p.try_week, p.tries, p.attempts, p.claimed_at, u.email FROM digest_prefs p JOIN users u ON u.id = p.user_id
     WHERE p.enabled = 1 AND u.status = 'active' AND (p.last_week IS NULL OR p.last_week < ?1 OR p.claimed_at < ?2)
     ORDER BY p.last_attempt_at IS NOT NULL, p.last_attempt_at, p.user_id LIMIT 500`,
  ).bind(doneWeek, stale).all<Pref>()).results;
  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  let sent = 0, tried = 0;
  for (const p of prefs) {
    if (tried >= DIGESTS_PER_RUN) break; // attempts, not successes: a failing Resend must not spend the run's subrequests
    const tz = parseTz(p.tz);
    if (!tz) continue;
    const w = weekOf(now, tz);
    if (!w.due) continue;
    // A claim with no outcome written after CLAIM_STALE_SEC is unfinished, not delivered: resume it with the same key.
    const resume = p.last_week === w.week && p.claimed_at !== null && p.claimed_at < stale;
    if (p.last_week !== null && p.last_week >= w.week && !resume) continue;
    const prev = resume ? addDays(w.week, -7) : p.last_week; // what a release puts back
    const mine = p.try_week === w.week;
    const tries = mine ? p.tries : 0;
    const give = (mine ? p.attempts : 0) >= MAX_TRIES;
    // Claim first: two overlapping runs cannot both pass this guard for the same week. A week out of attempts is claimed for good.
    const claim = await env.DB.prepare(
      `UPDATE digest_prefs SET last_week = ?1, last_attempt_at = ?3, try_week = ?1, tries = ?4, attempts = ?5,
         claimed_at = CASE WHEN ?6 = 1 THEN NULL ELSE ?3 END, last_error = CASE WHEN ?6 = 1 THEN 'gave_up' ELSE last_error END
       WHERE user_id = ?2 AND enabled = 1 AND (last_week IS NULL OR last_week < ?1 OR (last_week = ?1 AND claimed_at < ?7))`,
    ).bind(w.week, p.user_id, nowSec, tries, (mine ? p.attempts : 0) + (give ? 0 : 1), give ? 1 : 0, stale).run();
    if (!claim.meta.changes || give) continue;
    tried++;
    let res: SendResult | null = null;
    try {
      settings ??= await getSettings(env);
      const mail = await buildFor(env, p, w.week, nowSec, d.base, settings.name);
      res = mail && (await sendEmail(env, {
        to: p.email, ...mail, name: settings.name, idempotencyKey: `digest-${p.user_id}-${w.week}-${tries}`,
        headers: { "List-Unsubscribe": `<${mail.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }));
    } catch (e) {
      console.error("weekly email failed", e instanceof Error ? e.name : "unknown");
    }
    const o = outcomeOf(res);
    if (o.error) console.warn("weekly email not sent", o.error); // a code only, never the address
    if (res?.ok) sent++;
    const done = o.keep
      ? env.DB.prepare("UPDATE digest_prefs SET last_error = ?3, claimed_at = NULL WHERE user_id = ?1 AND last_week = ?2").bind(p.user_id, w.week, o.error)
      : env.DB.prepare("UPDATE digest_prefs SET last_week = ?4, last_error = ?3, tries = tries + ?5, claimed_at = NULL WHERE user_id = ?1 AND last_week = ?2")
        .bind(p.user_id, w.week, o.error, prev, o.nextTry ? 1 : 0);
    // A failed write leaves claimed_at set: after CLAIM_STALE_SEC a later run resumes the week with the same key.
    await done.run().catch(() => console.error("weekly email state not saved"));
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
  // Live reads off but clicks recorded: only the D1 rollups answer, so the whole week must be rolled up before it is sent.
  // (Without the CLICKS binding nothing is recorded at all, so the zeros are complete.)
  if (rows.live === "off" && env.CLICKS) {
    const w = await rolledThrough(env);
    if (!w || w < addDays(week, -1)) return null;
  }
  const hosts = new Map((await env.DB.prepare("SELECT id, host FROM domains").all<{ id: string; host: string }>()).results.map((x) => [x.id, x.host]));
  const report = buildReport(range, rows, hosts, { truncated: false, visitors: false });
  const unsubUrl = `${base}/unsubscribe?u=${encodeURIComponent(p.user_id)}&t=${await unsubToken(p.secret, p.user_id)}`;
  return { ...digestEmail({ instanceName, week, report, dashboardUrl: base, unsubUrl }), unsubUrl };
}
