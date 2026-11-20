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

export function checkDestination(
  raw: string,
  shortHosts: string[],
): { ok: true; url: URL } | { ok: false; reason: "not_url" | "scheme" | "userinfo" | "too_long" | "loop" } {
  if (raw.length > 2048) return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const host = normalizeHost(url.host);
  if (shortHosts.some((h) => normalizeHost(h) === host)) return { ok: false, reason: "loop" };
  return { ok: true, url };
}
