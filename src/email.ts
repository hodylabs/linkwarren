import type { Env } from "./env";
import { getSecret } from "./secrets";
import { getSettings } from "./settings";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** EMAIL_FROM set and a Resend key from the Worker secret or the dashboard. */
export const emailConfigured = async (env: Env): Promise<boolean> => !!env.EMAIL_FROM?.trim() && !!(await getSecret(env, "RESEND_API_KEY"));

/** Sender display name: no quoting, angle or control characters (header injection), at most 60 characters; empty is linkwarren. */
export const displayName = (name: string | null): string =>
  (name ?? "").replace(/["<>\\]|[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60).trim() || "linkwarren";

/** One line for a subject or a text line: control characters (CR/LF included) become nothing, runs of spaces one. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();

export type Mail = { to: string; subject: string; text: string; html: string };
export type SendResult = { ok: true } | { ok: false; reason: "not_configured" | "rejected" | "network" };

/** One POST to Resend. Never throws; logs the status code only (Resend's error body can echo the request, link included). */
export async function sendEmail(env: Env, m: Mail, f: typeof fetch = fetch): Promise<SendResult> {
  const from = env.EMAIL_FROM?.trim();
  const key = from ? (await getSecret(env, "RESEND_API_KEY"))?.value : undefined;
  if (!from || !key) return { ok: false, reason: "not_configured" };
  try {
    const name = displayName((await getSettings(env)).name);
    const r = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${name} <${from}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
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

/** The invite: plain text plus simple HTML, every interpolation escaped, one link to the dashboard host over https. */
export function inviteEmail(o: { instanceName: string; inviter: string; dashboardHost: string; role: "owner" | "member" }): { subject: string; text: string; html: string } {
  const name = oneLine(o.instanceName);
  const url = `https://${o.dashboardHost}/`;
  const lines = [`${oneLine(o.inviter)} invited you to ${name}, a link shortener.`];
  const owner = "You will be an owner: you can manage every person, domain and link.";
  const link = `Sign in at ${url} with your email.`;
  const text = [lines[0]!, link, ...(o.role === "owner" ? [owner] : [])].join("\n") + "\n";
  const a = `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  return {
    subject: `You're invited to ${name}`,
    text,
    html: `<p>${escapeHtml(lines[0]!)}</p>\n<p>Sign in at ${a} with your email.</p>\n${o.role === "owner" ? `<p>${escapeHtml(owner)}</p>\n` : ""}`,
  };
}
