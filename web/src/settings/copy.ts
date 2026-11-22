import { errorText } from "../copy";

/** Settings sections in subnav order: URL `/settings/<id>` (R15) and label. */
export const SECTIONS = [
  { id: "instance", label: "This instance" },
  { id: "sign-in", label: "Sign-in" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "email", label: "Email" },
  { id: "link-defaults", label: "Link defaults" },
  { id: "data", label: "Data and retention" },
  { id: "backups", label: "Backups and export" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

const EXTRA: Record<string, string> = {
  fallback_in_use: "This Cloudflare zone already uses a different fallback origin for another service. linkwarren will not replace it.",
  target_in_use: "The CNAME target name already has a DNS record that linkwarren did not create. Remove or rename it in Cloudflare first.",
  outside_not_configured: "Outside domains are not configured. Set the Cloudflare for SaaS variables, then reload. See the deploy guide.",
  rate_range: "Enter a whole number from 10 to 1000.",
  stalled: "Cloudflare stopped answering. Try again in a minute.",
  bad_name: "Use 1 to 60 characters.",
  bad_main_domain: "Pick an active main domain.",
  logo_type: "Use a PNG, WebP or JPEG image.",
  not_square: "The logo must be square (the same width and height).",
  too_large: "The logo must be at most 1024 px and 64 KB.",
  token_invalid: "Cloudflare does not accept this token. Copy the whole token and check that it is active.",
  bad_key: "That does not look like a Resend API key. It starts with re_.",
  set_by_secret: "A Worker secret already sets this, and it always wins. Change it with npx wrangler secret put <NAME> -c wrangler.instance.jsonc.",
  secrets_key_missing: "Pasting needs the SECRETS_KEY Worker secret. Set it, or set this value as a Worker secret instead.",
  email_not_configured: "Email is not set up yet. Set EMAIL_FROM and the Resend API key first.",
  too_soon: "A test email was just sent. Wait a minute before sending another.",
  too_many: "Too many emails were sent this hour. Try again later.",
  email_failed: "Resend did not send the email. Check the API key and that the sender's domain is verified in Resend.",
  export_expired: "This export expired or was started elsewhere. Start it again.",
  analytics_not_included: "This export was started without analytics. Start it again.",
};

/** Settings-screen error text: its own codes first, then the shared list. */
export const settingsError = (code: string): string => (Object.hasOwn(EXTRA, code) ? EXTRA[code]! : errorText(code));
