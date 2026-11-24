import { aeConfigured, aeQuery } from "./ae";
import { resolveScope } from "./analytics";
import { utcDay } from "./clicks";
import { rolledThrough } from "./cron";
import { dash } from "./dash";
import { CLAIM_STALE_SEC, MAX_TRIES, outcomeOf, unsubToken } from "./digest";
import { displayName, emailConfigured, escapeHtml, sendEmail, type SendResult } from "./email";
import type { Env } from "./env";
import { hit, LIMITS, limitKey, refund } from "./limits";
import { ROLE_JOIN, USER_COLS } from "./roles";
import { getSettings } from "./settings";
import { rowToUser } from "./types";

/**
 * S13 alerts (R6): opt-in email per person about the links they can see.
 * - "Gone quiet": at least QUIET_AVG clicks a day on average over days 15 to 42 before today, and none in the last 14 days (today included).
 * - "Spike": yesterday's clicks are at least SPIKE_FACTOR times the average of the 7 days before it, and at least SPIKE_MIN.
 * Runs on its own cron trigger (ALERT_CRON), never inside the rollup run. One email per person per UTC day at most, listing
 * every new alert; at most LIMITS.alertDay emails per instance per day. The per-person day is claimed exactly like the weekly
 * digest's week (compare-and-set on the attempt state, outcomeOf, Resend's Idempotency-Key), and alert_state remembers what each
 * person was told about each link, so a re-run never repeats an alert. Visibility is resolved per person at send time
 * (their Analytics scope, as the digest does), and only clicks on domains they can use count.
 */

export const ALERT_CRON = "45 * * * *";
export const QUIET_AVG = 5;
const BASE_FROM = 42, BASE_TO = 15, BASE_DAYS = BASE_FROM - BASE_TO + 1; // days 15..42 before today: 28 days
const QUIET_DAYS = 14;
export const SPIKE_FACTOR = 3;
export const SPIKE_MIN = 20;
/** A "gone quiet" alert is not repeated for 28 days: the shortest time in which the same link can go quiet again after new clicks. */
export const QUIET_COOLDOWN = 28;
/**
 * People looked at per run and emails per run. Each person is about 3 D1 calls (user and state, scope, claim or mark), a send
 * adds a Resend call and 2 writes: with the 4 shared reads, 8 people and 3 sends stay well under the Free plan's 50 per invocation.
 */
export const PEOPLE_PER_RUN = 8;
export const SENDS_PER_RUN = 3;
/** Links listed in one email; the rest come the next day. */
export const MAX_LISTED = 10;

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

type Counts = { base: number; recent: number; yday: number; week: number };
/** Human clicks per link, then per domain the clicks happened on (a moved link keeps each domain's clicks apart). */
export type ClickTable = Map<string, Map<string, Counts>>;

/** Files `n` clicks of `day` into the windows the rules read; days outside them are ignored. */
export function addClicks(t: ClickTable, today: string, linkId: string, domainId: string, day: string, n: number): void {
  if (!(n > 0)) return;
  const per = t.get(linkId) ?? t.set(linkId, new Map()).get(linkId)!;
  const c = per.get(domainId) ?? per.set(domainId, { base: 0, recent: 0, yday: 0, week: 0 }).get(domainId)!;
  if (day >= addDays(today, -BASE_FROM) && day <= addDays(today, -BASE_TO)) c.base += n;
  if (day >= addDays(today, -QUIET_DAYS)) c.recent += n;
  if (day === addDays(today, -1)) c.yday += n;
  if (day >= addDays(today, -8) && day <= addDays(today, -2)) c.week += n;
}

const dataset = (env: Env) => env.AE_DATASET?.trim() || "linkwarren_clicks"; // validated by aeConfigured inside aeQuery
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Daily human clicks for the last 43 days: D1 rollups through the watermark, Analytics Engine after it (yesterday is never
 * rolled up yet). Throws on any Analytics Engine failure: a missing day must never read as "quiet".
 * shortcut: one AE query, grouped per day, link and domain; past ROW_CAP rows (about 700 links clicked in the unrolled days) it
 * throws truncated and no alerts go out. Split by link chunks if an instance gets there.
 */
export async function loadClicks(env: Env, nowSec: number): Promise<ClickTable> {
  const today = utcDay(nowSec), start = addDays(today, -BASE_FROM);
  const t: ClickTable = new Map();
  const w = await rolledThrough(env);
  const d1To = w && w >= start ? (w < today ? w : today) : null;
  if (d1To) {
    const r = await env.DB.prepare("SELECT day, link_id, domain_id, qr + typed AS n FROM clicks_daily WHERE day >= ? AND day <= ? AND qr + typed > 0")
      .bind(start, d1To).all<{ day: string; link_id: string; domain_id: string; n: number }>();
    for (const x of r.results) addClicks(t, today, x.link_id, x.domain_id, x.day, x.n);
  }
  const from = Date.parse(`${d1To ? addDays(d1To, 1) : start}T00:00:00Z`);
  if (from < nowSec * 1000) {
    const b = "toStartOfDay(timestamp)";
    const rows = await aeQuery(
      env,
      `SELECT ${b} AS bucket, blob2 AS linkId, blob1 AS domainId, COUNT(*) AS n FROM events.analyticsEngine."${dataset(env)}"
       WHERE accountTag = $account AND timestamp >= $from AND timestamp < $to AND blob8 = $human GROUP BY ${b}, blob2, blob1`,
      { account: env.CF_ACCOUNT_ID?.trim() ?? "", from: iso(from), to: iso(nowSec * 1000), human: "human" },
    );
    for (const r of rows) addClicks(t, today, String(r.linkId ?? ""), String(r.domainId ?? ""), String(r.bucket ?? "").slice(0, 10), Math.round(Number(r.n) || 0));
  }
  return t;
}

export type LinkInfo = { id: string; slug: string; name: string | null; domainId: string; host: string };
export type Alert = { kind: "quiet" | "spike"; link: LinkInfo; clicks: number; avg: number };

/** Pure: the alerts one person gets, from links on their domains (null: all) and clicks on those domains only. */
export function findAlerts(t: ClickTable, links: Map<string, LinkInfo>, domains: Set<string> | null, want: { quiet: boolean; spike: boolean }): Alert[] {
  const out: Alert[] = [];
  for (const [id, per] of t) {
    const link = links.get(id);
    if (!link || (domains && !domains.has(link.domainId))) continue;
    const s = { base: 0, recent: 0, yday: 0, week: 0 };
    for (const [d, c] of per) {
      if (domains && !domains.has(d)) continue;
      s.base += c.base; s.recent += c.recent; s.yday += c.yday; s.week += c.week;
    }
    if (want.quiet && s.base >= QUIET_AVG * BASE_DAYS && s.recent === 0) out.push({ kind: "quiet", link, clicks: 0, avg: s.base / BASE_DAYS });
    if (want.spike && s.yday >= SPIKE_MIN && s.yday * 7 >= SPIKE_FACTOR * s.week) out.push({ kind: "spike", link, clicks: s.yday, avg: s.week / 7 });
  }
  // Spikes first (they are news), then by size.
  return out.sort((a, b) => (a.kind === b.kind ? b.clicks - a.clicks || b.avg - a.avg : a.kind === "spike" ? -1 : 1));
}

/** The day an alert is filed under in alert_state, and whether an earlier entry already covers it. */
const stateDay = (a: Alert, today: string) => (a.kind === "spike" ? addDays(today, -1) : today);
const told = (a: Alert, last: string | undefined, today: string) =>
  last !== undefined && (a.kind === "spike" ? last >= addDays(today, -1) : last > addDays(today, -QUIET_COOLDOWN));

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

/** Plain text plus simple HTML, every interpolation escaped (hosts, slugs and names are people's text); no images, no tracking. */
export function alertEmail(o: { instanceName: string | null; day: string; alerts: Alert[]; more: number; dashboardUrl: string; unsubUrl: string }): { subject: string; text: string; html: string } {
  const name = displayName(o.instanceName);
  const line = (a: Alert) => {
    const where = `${oneLine(a.link.host || "Unknown domain")}/${oneLine(a.link.slug)}${a.link.name ? ` (${oneLine(a.link.name)})` : ""}`;
    return a.kind === "spike"
      ? `Spike: ${where}: ${fmt(a.clicks)} clicks on ${addDays(o.day, -1)}, about ${fmt(a.avg)} a day the week before.`
      : `Gone quiet: ${where}: no clicks in 14 days, about ${fmt(a.avg)} a day before that.`;
  };
  const lines = o.alerts.map(line);
  const head = `Link alerts in ${name} (UTC days):`;
  const more = o.more ? `And ${o.more} more, in the next email.` : "";
  const foot = "You get this because you turned on link alerts in your account. Turn them off:";
  const url = (a: Alert) => `${o.dashboardUrl}/analytics/link/${encodeURIComponent(a.link.id)}`;
  const text = [head, "", ...o.alerts.flatMap((a, i) => [lines[i]!, url(a)]), ...(more ? ["", more] : []), "", foot, o.unsubUrl, ""].join("\n");
  const e = escapeHtml;
  const html =
    `<p>${e(head)}</p>\n<ul>${o.alerts.map((a, i) => `<li>${e(lines[i]!)} <a href="${e(url(a))}">Open</a></li>`).join("")}</ul>\n` +
    (more ? `<p>${e(more)}</p>\n` : "") + `<p>${e(foot)} <a href="${e(o.unsubUrl)}">unsubscribe</a></p>\n`;
  const n = o.alerts.length + o.more;
  return { subject: `${n} link ${n === 1 ? "alert" : "alerts"} in ${name}`, text, html };
}

type Pref = {
  user_id: string; quiet: number; spike: number; secret: string; last_day: string | null; try_day: string | null;
  tries: number; attempts: number; claimed_at: number | null; email: string;
};

/** The ALERT_CRON run. Returns the emails sent; one person's failure never stops the others. */
export async function sendAlerts(env: Env, nowSec: number): Promise<number> {
  const d = dash(env);
  if (!d || !(await emailConfigured(env))) return 0;
  // Without Analytics Engine reads nothing is rolled up and yesterday is unknown: never guess.
  if (!aeConfigured(env)) return 0;
  const today = utcDay(nowSec), stale = nowSec - CLAIM_STALE_SEC;
  const prefs = (await env.DB.prepare(
    `SELECT p.user_id, p.quiet, p.spike, p.secret, p.last_day, p.try_day, p.tries, p.attempts, p.claimed_at, u.email FROM alert_prefs p JOIN users u ON u.id = p.user_id
     WHERE p.enabled = 1 AND (p.quiet = 1 OR p.spike = 1) AND u.status = 'active' AND (p.last_day IS NULL OR p.last_day < ?1 OR (p.last_day = ?1 AND p.claimed_at < ?2))
     ORDER BY p.last_attempt_at IS NOT NULL, p.last_attempt_at, p.user_id LIMIT ${PEOPLE_PER_RUN}`,
  ).bind(today, stale).all<Pref>()).results;
  if (!prefs.length) return 0; // nobody due: no Analytics Engine read at all

  const clicks = await loadClicks(env, nowSec);
  // Only links that could alert anyone: the per-domain sums a person sees are never above the link's totals.
  const hot: string[] = [];
  for (const [id, per] of clicks) {
    let base = 0, yday = 0;
    for (const c of per.values()) (base += c.base), (yday += c.yday);
    if (base >= QUIET_AVG * BASE_DAYS || yday >= SPIKE_MIN) hot.push(id);
  }
  const links = new Map<string, LinkInfo>();
  if (hot.length) {
    // Forwarders count nothing (the click is on their target); an expired link going quiet is expected, not news.
    const r = await env.DB.prepare(
      `SELECT l.id, l.slug, l.name, l.domain_id AS domainId, d.host FROM links l JOIN domains d ON d.id = l.domain_id
       WHERE l.forward_to IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?) AND l.id IN (SELECT value FROM json_each(?))`,
    ).bind(nowSec, JSON.stringify(hot)).all<LinkInfo>();
    for (const l of r.results) links.set(l.id, l);
  }

  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  let sent = 0, tried = 0;
  for (const p of prefs) {
    if (tried >= SENDS_PER_RUN) break;
    const resume = p.last_day === today && p.claimed_at !== null && p.claimed_at < stale;
    const [ur, sr] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`SELECT ${USER_COLS} FROM users u ${ROLE_JOIN} WHERE u.id = ?`).bind(p.user_id),
      env.DB.prepare("SELECT link_id, kind, last_day FROM alert_state WHERE user_id = ?").bind(p.user_id),
    ]);
    if (!ur!.results[0]) continue;
    const user = rowToUser(ur!.results[0]);
    // The same scope as their Analytics screen with no filters, read now: a role or domain change since opt-in counts.
    const s = await resolveScope(env, user, null, "", null);
    if ("error" in s) continue;
    const domains = s.scope.domainIds ? new Set(s.scope.domainIds) : null;
    const prior = new Map((sr!.results as { link_id: string; kind: string; last_day: string }[]).map((x) => [`${x.link_id}|${x.kind}`, x.last_day]));
    const fresh = findAlerts(clicks, links, domains, { quiet: !!p.quiet, spike: !!p.spike }).filter((a) => !told(a, prior.get(`${a.link.id}|${a.kind}`), today));
    if (!fresh.length) {
      // Nothing new: the day is handled (an unfinished claim from a dead run too), so later runs today skip this person.
      await env.DB.prepare(
        "UPDATE alert_prefs SET last_day = ?1, claimed_at = NULL WHERE user_id = ?2 AND enabled = 1 AND (last_day IS NULL OR last_day < ?1 OR (last_day = ?1 AND claimed_at < ?3))",
      ).bind(today, p.user_id, stale).run();
      continue;
    }
    const prev = resume ? addDays(today, -1) : p.last_day; // what a release puts back
    const mine = p.try_day === today;
    const tries = mine ? p.tries : 0;
    const give = (mine ? p.attempts : 0) >= MAX_TRIES;
    // R6: the instance's daily cap, spent before the claim; given back when the claim does not lead to a send.
    if (!give && !(await hit(env, limitKey.alertDay, LIMITS.alertDay))) break;
    const claim = await env.DB.prepare(
      `UPDATE alert_prefs SET last_day = ?1, last_attempt_at = ?3, try_day = ?1, tries = ?4, attempts = ?5,
         claimed_at = CASE WHEN ?6 = 1 THEN NULL ELSE ?3 END, last_error = CASE WHEN ?6 = 1 THEN 'gave_up' ELSE last_error END
       WHERE user_id = ?2 AND enabled = 1 AND (last_day IS NULL OR last_day < ?1 OR (last_day = ?1 AND claimed_at < ?7))
         AND attempts = ?8 AND tries = ?9 AND try_day IS ?10`,
      // Compare-and-set, as in the digest: a row another run changed meanwhile matches nothing and is skipped.
    ).bind(today, p.user_id, nowSec, tries, (mine ? p.attempts : 0) + (give ? 0 : 1), give ? 1 : 0, stale, p.attempts, p.tries, p.try_day).run();
    if (!claim.meta.changes || give) {
      if (!give) await refund(env, limitKey.alertDay).catch(() => {});
      continue;
    }
    tried++;
    const list = fresh.slice(0, MAX_LISTED);
    let res: SendResult | null = null;
    try {
      settings ??= await getSettings(env);
      const unsubUrl = `${d.base}/unsubscribe?k=alerts&u=${encodeURIComponent(p.user_id)}&t=${await unsubToken(p.secret, p.user_id, "alerts")}`;
      const mail = alertEmail({ instanceName: settings.name, day: today, alerts: list, more: fresh.length - list.length, dashboardUrl: d.base, unsubUrl });
      res = await sendEmail(env, {
        to: p.email, ...mail, name: settings.name, idempotencyKey: `alert-${p.user_id}-${today}-${tries}`,
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
    } catch (e) {
      console.error("alert email failed", e instanceof Error ? e.name : "unknown");
    }
    const o = outcomeOf(res);
    if (o.error) console.warn("alert email not sent", o.error); // a code only, never the address
    if (res?.ok) sent++;
    const done = o.keep
      ? [
        env.DB.prepare("UPDATE alert_prefs SET last_error = ?3, claimed_at = NULL WHERE user_id = ?1 AND last_day = ?2").bind(p.user_id, today, o.error),
        // What this email told them; a link deleted meanwhile is skipped (no row to point at).
        env.DB.prepare(
          `INSERT INTO alert_state (user_id, link_id, kind, last_day) SELECT ?, json_extract(j.value, '$.l'), json_extract(j.value, '$.k'), json_extract(j.value, '$.d')
           FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM links WHERE id = json_extract(j.value, '$.l'))
           ON CONFLICT(user_id, link_id, kind) DO UPDATE SET last_day = excluded.last_day`,
        ).bind(p.user_id, JSON.stringify(list.map((a) => ({ l: a.link.id, k: a.kind, d: stateDay(a, today) })))),
      ]
      : [env.DB.prepare("UPDATE alert_prefs SET last_day = ?4, last_error = ?3, tries = tries + ?5, claimed_at = NULL WHERE user_id = ?1 AND last_day = ?2")
        .bind(p.user_id, today, o.error, prev, o.nextTry ? 1 : 0)];
    // A failed write leaves claimed_at set: after CLAIM_STALE_SEC a later run resumes the day with the same key.
    await env.DB.batch(done).catch(() => console.error("alert state not saved"));
  }
  return sent;
}
