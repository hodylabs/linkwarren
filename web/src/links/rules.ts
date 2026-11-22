import { passwordRule } from "../../../src/password-rule";
import type { Route, RouteDevice } from "../api";

const MAX_COUNTRIES = 50;

/** "ca, us  CA" -> ["CA", "US"]. Two ASCII letters (checked raw, before upper-casing), never XX or T1 (Cloudflare's unknown and Tor), at most 50. */
export function parseCountries(text: string): { ok: true; list: string[] } | { ok: false; bad: string } {
  const raw = text.split(/[\s,]+/).filter(Boolean);
  // Raw check first, like the server: "ß".toUpperCase() is "SS", which must not pass as a code.
  const badRaw = raw.find((c) => !/^[A-Za-z]{2}$/.test(c));
  if (badRaw) return { ok: false, bad: badRaw };
  const list = [...new Set(raw.map((c) => c.toUpperCase()))];
  if (list.includes("XX")) return { ok: false, bad: "XX" };
  if (list.length > MAX_COUNTRIES) return { ok: false, bad: list[MAX_COUNTRIES]! };
  return { ok: true, list };
}

/** Client length check, the server's own rule (src/password-rule.ts); the server stays authoritative. */
export function passwordProblem(raw: string): "password_short" | "password_long" | null {
  const r = passwordRule(raw);
  return r.ok ? null : r.reason;
}

let names:Intl.DisplayNames | null | undefined;
/** "CA" -> "Canada"; the code itself when the browser has no name for it. */
export function countryName(code: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      names = null;
    }
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const DEVICE_LABEL: Record<RouteDevice, string> = {
  mobile: "Mobile", tablet: "Tablet", desktop: "Desktop", ios: "iOS", android: "Android",
  windows: "Windows", macos: "macOS", linux: "Linux", chromeos: "ChromeOS",
};
const hostPath = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
};

/** One line for the routing rule row: the first route in words, "(+n more)" for the rest, "Off" when none. */
export function routeSummary(routes: Route[]): string {
  const r = routes[0];
  if (!r) return "Off";
  const devices = r.devices.map((d) => DEVICE_LABEL[d] ?? d).join(", ");
  const who = r.countries.length ? r.countries.map(countryName).join(", ") + (devices ? ` on ${devices}` : "") : devices;
  return `${who} goes to ${hostPath(r.url)}${routes.length > 1 ? ` (+${routes.length - 1} more)` : ""}`;
}
