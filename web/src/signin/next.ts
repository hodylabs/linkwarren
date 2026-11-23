import { BASE, withBase } from "../base";

/** Client copy of the server's safeNext (src/session.ts): only same-origin relative inner paths, re-checked before every assign. */
export function isSafeNext(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048 || !s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    const u = new URL(s, location.origin);
    // R9: resolved under the base, it must stay under the base ("/../slug" would land on a short link).
    const p = new URL(BASE + s, location.origin).pathname;
    // A dot segment can still resolve to a "//x" pathname.
    return u.origin === location.origin && !u.pathname.startsWith("//") && (p === BASE || p.startsWith(BASE + "/"));
  } catch {
    return false;
  }
}

/** `s` without one leading base segment ("/dashboard/x" -> "/x"): next values are inner paths (R9), so a base-prefixed one is never doubled. Mirrors unPrefix in src/session.ts. */
export function unBase(s: unknown): unknown {
  if (!BASE || typeof s !== "string" || !s.startsWith(BASE)) return s;
  const rest = s.slice(BASE.length);
  return rest === "" ? "/" : rest[0] === "/" ? rest : rest[0] === "?" || rest[0] === "#" ? "/" + rest : s;
}

/** Indirection so tests can observe navigation (jsdom's location.assign cannot be spied). */
export const nav = { assign: (url: string): void => location.assign(url) };

/** A full page load to inner path `s` under the base when it is safe, else to the dashboard root. */
export const goNext = (s: unknown): void => {
  const n = unBase(s);
  nav.assign(withBase(isSafeNext(n) ? n : "/"));
};
