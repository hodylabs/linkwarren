// Host header or URL host -> canonical domain key: no port, no trailing dot, lowercase.
export function normalizeHost(raw: string): string {
  const h = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1 || undefined) : raw.replace(/:\d*$/, "");
  return h.replace(/\.$/, "").toLowerCase();
}

// Second-level labels that make a two-letter ccTLD pair (co.uk, com.au) one registrable suffix.
// shortcut: a fixed list, display only (instructions.name/apex, dashboard copy); use the Public Suffix List if users need more.
const CC_SLD = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);
/** Registrable apex by the simple rule: the last two labels, or three when they are a ccTLD pair like co.uk. */
export function apexOf(host: string): string {
  const l = host.split(".");
  const n = l.length >= 3 && l[l.length - 1]!.length === 2 && CC_SLD.has(l[l.length - 2]!) ? 3 : 2;
  return l.slice(-n).join(".");
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
