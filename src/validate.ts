import { normalizeHost } from "./host";

export const DEFAULT_RESERVED: readonly string[] = [
  "admin", "api", "login", "logout", "dash", "dashboard", "auth", "oauth", "mcp", "signup",
  "register", "account", "settings", "app", "static", "assets", "health", "status", "qr",
  ".well-known", "cdn-cgi", "robots.txt", "favicon.ico", "sitemap.xml",
];

export function slugKey(slug: string, caseSensitive: boolean): string {
  return caseSensitive ? slug : slug.toLowerCase();
}

export function checkSlugShape(
  slug: string,
): { ok: true } | { ok: false; reason: "empty" | "too_long" | "charset" | "leading_dot" } {
  if (slug.length === 0) return { ok: false, reason: "empty" };
  if (slug.length > 64) return { ok: false, reason: "too_long" };
  if (!/^[A-Za-z0-9._~-]+$/.test(slug)) return { ok: false, reason: "charset" };
  if (slug.startsWith(".") && slug.toLowerCase() !== ".well-known") return { ok: false, reason: "leading_dot" };
  return { ok: true };
}

export function checkSlug(
  slug: string,
  reservedExtra: string[],
): { ok: true } | { ok: false; reason: "empty" | "too_long" | "charset" | "leading_dot" | "reserved" } {
  const shape = checkSlugShape(slug);
  if (!shape.ok) return shape;
  const lower = slug.toLowerCase();
  if (DEFAULT_RESERVED.includes(lower) || reservedExtra.some((r) => r.toLowerCase() === lower)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true };
}

export type DestinationError = "not_url" | "scheme" | "userinfo" | "too_long" | "loop" | "bad_tel" | "bad_mailto";

// tel: an optional +, digits and visual separators only (RFC 3966 without parameters), at most 32 after the scheme.
const TEL = /^tel:(?=[^]{1,32}$)\+?[0-9().-]*[0-9][0-9().-]*$/i;
// mailto: comma-separated plain addresses (no characters that need escaping), then an optional subject/body query.
const ADDR = "[A-Za-z0-9!$'*+_.-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
const MAILTO = new RegExp(`^mailto:${ADDR}(?:,${ADDR})*(?:\\?([^#]*))?$`, "i");
const FIELD = /^(subject|body)=((?:[A-Za-z0-9._~!$'()*+,;:@/-]|%[0-9A-Fa-f]{2})*)$/i;

/** The query of a mailto: subject and body only, each once, no control character even percent-encoded (header injection). */
function mailtoQueryOk(q: string | undefined): boolean {
  if (q === undefined) return true;
  const seen = new Set<string>();
  for (const pair of q.split("&")) {
    const m = FIELD.exec(pair);
    if (!m) return false;
    const key = m[1]!.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    let v: string;
    try {
      v = decodeURIComponent(m[2]!);
    } catch {
      return false;
    }
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return false;
  }
  return true;
}

/**
 * http(s) destinations, plus tel: and mailto: unless `webOnly`. tel and mailto are matched strictly on the raw text (no
 * whitespace, controls or parser leniency), and the loop check only applies to http(s): they have no host to loop to.
 */
export function checkDestination(
  raw: string,
  shortHosts: string[],
  opts: { webOnly?: boolean } = {},
): { ok: true; url: URL } | { ok: false; reason: DestinationError } {
  if (raw.length > 2048) return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_url" };
  }
  if (!opts.webOnly && url.protocol === "tel:") return TEL.test(raw) ? { ok: true, url } : { ok: false, reason: "bad_tel" };
  if (!opts.webOnly && url.protocol === "mailto:") {
    const m = MAILTO.exec(raw);
    return m && mailtoQueryOk(m[1]) ? { ok: true, url } : { ok: false, reason: "bad_mailto" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const host = normalizeHost(url.host);
  if (shortHosts.some((h) => normalizeHost(h) === host)) return { ok: false, reason: "loop" };
  return { ok: true, url };
}
