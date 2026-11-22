import type { Env } from "./env";
import { getSecret } from "./secrets";
import { getSettings } from "./settings";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** EMAIL_FROM set and a Resend key from the Worker secret or the dashboard. */
export const emailConfigured = async (env: Env): Promise<boolean> => !!env.EMAIL_FROM?.trim() && !!(await getSecret(env, "RESEND_API_KEY"));

// Controls, C1, zero-width and bidi marks, line/paragraph separators, bidi overrides/isolates: nothing that can break a header or reorder text.
// Shared with the instance name write (src/api/settings.ts), so every surface sees the same name.
export const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const cut = (s: string, n: number): string => [...s].slice(0, n).join("");

/** Sender display name: unsafe characters, quotes and backslashes removed, at most 60 code points; empty is linkwarren. Callers emit it as a quoted string. */
export const displayName = (name: string | null): string => cut((name ?? "").replace(UNSAFE, "").replace(/["<>\\]/g, "").trim(), 60).trim() || "linkwarren";

/** One line for a subject or a text line: unsafe characters become a space, runs of spaces one, at most n code points. */
const oneLine = (s: string, n = 80): string => cut(s.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim(), n).trim();

/** name: the instance name for the sender; when undefined sendEmail reads it from the settings.
 * key: the Resend key the caller already resolved (one lookup per request); when undefined sendEmail looks it up. */
export type Mail = { to: string; subject: string; text: string; html: string; name?: string | null; key?: string };
export type SendResult = { ok: true } | { ok: false; reason: "not_configured" | "rejected" | "network" | "settings" };

/** One POST to Resend. Never throws; logs the status code only (Resend's error body can echo the request, link included). */
export async function sendEmail(env: Env, m: Mail, f: typeof fetch = fetch): Promise<SendResult> {
  const from = env.EMAIL_FROM?.trim();
  if (!from) return { ok: false, reason: "not_configured" };
  let key: string | undefined;
  let name: string;
  try {
    key = m.key ?? (await getSecret(env, "RESEND_API_KEY"))?.value;
    if (!key) return { ok: false, reason: "not_configured" };
    name = displayName(m.name !== undefined ? m.name : (await getSettings(env)).name);
  } catch {
    console.warn("settings_read_failed");
    return { ok: false, reason: "settings" };
  }
  try {
    const r = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `"${name}" <${from}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(10_000),
    });
    await r.body?.cancel();
    if (!r.ok) {
      console.warn("resend_rejected", r.status);
      return { ok: false, reason: "rejected" };
    }
    return { ok: true };
  } catch {
    console.warn("resend_network");
    return { ok: false, reason: "network" };
  }
}

/** Plain text plus simple HTML: every interpolation escaped, one link, no images (R16: no tracking). */
export function signInEmail(o: { host: string; url: string; name?: string | null }): { subject: string; text: string; html: string } {
  const intro = `Use this link to sign in to linkwarren at ${o.host}:`;
  const outro = "It works once and expires in 15 minutes. If you did not ask for it, ignore this email. Nobody can sign in without it.";
  const url = escapeHtml(o.url);
  return {
    subject: `Your sign-in link for ${displayName(o.name ?? null)}`,
    text: `${intro}\n\n${o.url}\n\n${outro}\n`,
    html: `<p>${escapeHtml(intro)}</p>\n<p><a href="${url}">${url}</a></p>\n<p>${escapeHtml(outro)}</p>\n`,
  };
}

/** The invite: plain text plus simple HTML, every interpolation escaped, one link to the dashboard host's /join page over https. */
export function inviteEmail(o: { instanceName: string; inviter: string; dashboardHost: string; roleName: string; isOwner: boolean }): { subject: string; text: string; html: string } {
  const name = oneLine(o.instanceName);
  const url = `https://${o.dashboardHost}/join`; // no email, id or token: personal data stays out of URLs
  const lines = [`${oneLine(o.inviter)} invited you to ${name}, a link shortener.`];
  const roleLine = o.isOwner ? "You will be an owner: you can manage every person, domain and link." : `You will join with the role ${oneLine(o.roleName)}.`;
  const link = `Open ${url} and sign in with the address this was sent to.`;
  const text = [lines[0]!, link, roleLine].join("\n") + "\n";
  const a = `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  return {
    subject: `You're invited to ${name}`,
    text,
    html: `<p>${escapeHtml(lines[0]!)}</p>\n<p>Open ${a} and sign in with the address this was sent to.</p>\n<p>${escapeHtml(roleLine)}</p>\n`,
  };
}
