// Host header or URL host -> canonical domain key: no port, no trailing dot, lowercase.
export function normalizeHost(raw: string): string {
  const h = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1 || undefined) : raw.replace(/:\d*$/, "");
  return h.replace(/\.$/, "").toLowerCase();
}
