import { errorText } from "../copy";

const EXTRA: Record<string, string> = {
  fallback_in_use: "This Cloudflare zone already uses a different fallback origin for another service. linkwarren will not replace it.",
  target_in_use: "The CNAME target name already has a DNS record that linkwarren did not create. Remove or rename it in Cloudflare first.",
  outside_not_configured: "Outside domains are not configured. Set the Cloudflare for SaaS variables, then reload. See the deploy guide.",
  cloudflare_plan_limit: "Your Cloudflare plan allows no more rate limit rules in this zone.",
  rate_range: "Enter a whole number from 10 to 1000.",
  cloudflare_0: "Cloudflare did not answer.",
  stalled: "Cloudflare stopped answering. Try again in a minute.",
};

/** Settings-screen error text: its own codes first, then the shared list. */
export const settingsError = (code: string): string => (Object.hasOwn(EXTRA, code) ? EXTRA[code]! : errorText(code));
