import type { Env } from "./env";
import { getSecret } from "./secrets";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** EMAIL_FROM set and a Resend key from the Worker secret or the dashboard. */
export const emailConfigured = async (env: Env): Promise<boolean> => !!env.EMAIL_FROM?.trim() && !!(await getSecret(env, "RESEND_API_KEY"));

export type Mail = { to: string; subject: string; text: string; html: string };
export type SendResult = { ok: true } | { ok: false; reason: "not_configured" | "rejected" | "network" };

/** One POST to Resend. Never throws; logs the status code only (Resend's error body can echo the request, link included). */
export async function sendEmail(env: Env, m: Mail, f: typeof fetch = fetch): Promise<SendResult> {
  const from = env.EMAIL_FROM?.trim();
  const key = from ? (await getSecret(env, "RESEND_API_KEY"))?.value : undefined;
  if (!from || !key) return { ok: false, reason: "not_configured" };
  try {
    const r = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
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
export function signInEmail(o: { host: string; url: string }): { subject: string; text: string; html: string } {
  const intro = `Use this link to sign in to linkwarren at ${o.host}:`;
  const outro = "It works once and expires in 15 minutes. If you did not ask for it, ignore this email. Nobody can sign in without it.";
  const url = escapeHtml(o.url);
  return {
    subject: "Your sign-in link for linkwarren",
    text: `${intro}\n\n${o.url}\n\n${outro}\n`,
    html: `<p>${escapeHtml(intro)}</p>\n<p><a href="${url}">${url}</a></p>\n<p>${escapeHtml(outro)}</p>\n`,
  };
}
