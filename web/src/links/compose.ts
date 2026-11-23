import { checkSlugShape } from "../../../src/validate";

const yy = (y: string) => y.slice(2);

/** Up to three slug ideas from the last path segment of a destination URL. */
export function suggestSlugs(url: string): string[] {
  let path: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
    path = u.pathname;
  } catch {
    return [];
  }
  let seg = path.split("/").filter(Boolean).pop() ?? "";
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* bad escape: keep it raw */
  }
  const base = seg.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  if (!base) return [];
  const words = base.split("-");
  const year = words.find((w) => /^(19|20)\d{2}$/.test(w));
  const out = [base, words.map((w) => (w === year ? yy(w) : w)).join("")];
  if (year && words[0] !== year) out.push(words[0]!.slice(0, 2) + yy(year));
  return [...new Set(out)].filter((s) => checkSlugShape(s).ok).slice(0, 3);
}

export type Utm = { source: string; medium: string; campaign: string };
const KEYS = ["source", "medium", "campaign"] as const;

function parse(dest: string): URL | null {
  try {
    const u = new URL(dest);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
const name = (pair: string) => {
  const k = pair.split("=")[0]!;
  try {
    return decodeURIComponent(k.replace(/\+/g, " "));
  } catch {
    return k;
  }
};

export function readUtm(dest: string): Utm {
  const u = parse(dest);
  const out: Utm = { source: "", medium: "", campaign: "" };
  if (u) for (const k of KEYS) out[k] = u.searchParams.get(`utm_${k}`) ?? "";
  return out;
}

/** Writes the three tags into the URL. Other params keep their text and order; an empty value removes the key; an invalid URL comes back unchanged. */
export function withUtm(dest: string, utm: Utm): string {
  const u = parse(dest);
  if (!u) return dest;
  const parts = u.search.replace(/^\?/, "").split("&").filter(Boolean);
  let changed = false;
  for (const k of KEYS) {
    const key = `utm_${k}`;
    const next = utm[k] ? `${key}=${encodeURIComponent(utm[k])}` : null;
    const hits = parts.map((p, i) => (name(p) === key ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 0 && next === null) continue;
    // A repeated key collapses to one: the first position keeps the value, the rest go.
    if (next !== null) {
      if (hits.length) parts[hits[0]!] = next;
      else parts.push(next);
    }
    for (const i of hits.slice(next === null ? 0 : 1).reverse()) parts.splice(i, 1);
    changed = true;
  }
  if (!changed) return dest;
  u.search = parts.join("&");
  return u.toString();
}
