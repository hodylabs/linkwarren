/** Client copy of the server's safeNext (src/session.ts): only same-origin relative paths, re-checked before every assign. */
export function isSafeNext(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048 || !s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    const u = new URL(s, location.origin);
    // A dot segment can still resolve to a "//x" pathname.
    return u.origin === location.origin && !u.pathname.startsWith("//");
  } catch {
    return false;
  }
}

/** Indirection so tests can observe navigation (jsdom's location.assign cannot be spied). */
export const nav = { assign: (url: string): void => location.assign(url) };

/** A full page load to `s` when it is safe, else to "/". */
export const goNext = (s: unknown): void => nav.assign(isSafeNext(s) ? s : "/");
