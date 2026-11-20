// Host header or URL host -> canonical domain key: no port, no trailing dot, lowercase.
export function normalizeHost(raw: string): string {
  const h = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1 || undefined) : raw.replace(/:\d*$/, "");
  return h.replace(/\.$/, "").toLowerCase();
}

// URL pathname -> slug, or null when it cannot name a link (bare, nested, bad encoding, over 64 chars).
export function slugFromPath(pathname: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s === "" || s.includes("/") || s.length > 64 ? null : s;
}
