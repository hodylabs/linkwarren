import type { Route } from "../api";

const MAX_COUNTRIES = 50;

/** "ca, us  CA" -> ["CA", "US"]. Two letters A to Z, never XX or T1 (Cloudflare's unknown and Tor), at most 50. */
export function parseCountries(text: string): { ok: true; list: string[] } | { ok: false; bad: string } {
  const list = [...new Set(text.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()))];
  const bad = list.find((c) => !/^[A-Z]{2}$/.test(c) || c === "XX");
  if (bad) return { ok: false, bad };
  if (list.length > MAX_COUNTRIES) return { ok: false, bad: list[MAX_COUNTRIES]! };
  return { ok: true, list };
}

/** Client length check only, same as the server's checkPassword (NFC, 8 to 128 code points); the server stays authoritative. */
export function passwordProblem(raw: string): "password_short" | "password_long" | null {
  const n = [...raw.normalize("NFC")].length;
  return n < 8 ? "password_short" : n > 128 ? "password_long" : null;
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

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const hostPath = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
};

/** One line for the routing rule row: the first route in words, "(+n more)" for the rest, "Off" when none. */
export function routeSummary(routes: Route[], _mainUrl: string): string {
  const r = routes[0];
  if (!r) return "Off";
  const devices = r.devices.map(cap).join(", ");
  const who = r.countries.length ? r.countries.map(countryName).join(", ") + (devices ? ` on ${devices}` : "") : devices;
  return `${who} goes to ${hostPath(r.url)}${routes.length > 1 ? ` (+${routes.length - 1} more)` : ""}`;
}
