import { type Ctx } from "./cache";
import { splitQrMarker } from "./clicks";
import type { Env } from "./env";
import { blocked, hit, LIMITS } from "./limits";
import { passwordPage } from "./pages";
import { verifyPassword } from "./password";
import { destinationOf, recordClick, robots } from "./redirect";
import { ipPrefix } from "./session";
import type { DomainRow, LinkRow } from "./types";

/** R10: no form-action (Chrome would apply it to the 303 to an outside destination); scripts blocked by default-src. */
export const INTERSTITIAL_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  // Not no-referrer: on a page with that policy browsers send `Origin: null` with the form POST, and R9 refuses null.
  // same-origin sends the real Origin to this host and nothing to any other; the 303 itself carries no-referrer.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

/** Attempts per link and IP range (counted before PBKDF2, right or wrong); failures per range across all links use LIMITS.failIp. */
const UNLOCK = { n: 5, s: 900 } as const;
const MAX_BODY = 1024;

const plain = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Short host, protected link: GET/HEAD show the form; POST is the unlock. No cookie, no session, nothing reflected. */
export async function handleProtected(req: Request, env: Env, link: LinkRow, domain: DomainRow, url: URL, now: number, ctx?: Ctx): Promise<Response> {
  const head = req.method === "HEAD";
  const show = (state: Parameters<typeof passwordPage>[0], status: number, extra: Record<string, string> = {}) =>
    new Response(head ? null : passwordPage(state), { status, headers: { ...INTERSTITIAL_HEADERS, ...extra } });
  if (req.method !== "POST") return show("ask", 200);

  // R9: the only CSRF gate (there is no session to ride); missing or "null" is refused.
  if (req.headers.get("origin") !== `https://${url.host}`) return show("ask", 403);
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return plain("Unsupported media type", 415);
  const len = req.headers.get("content-length");
  if (len === null || !/^\d{1,10}$/.test(len)) return plain("Length required", 411);
  if (Number(len) > MAX_BODY) return plain("Payload too large", 413);

  // Limits before any PBKDF2 work. The per-link counter is one atomic upsert, so parallel guesses cannot slip past it.
  const prefix = ipPrefix(req.headers.get("cf-connecting-ip")) ?? "none";
  const failKey = `unlockfail:${prefix}`;
  try {
    if ((await blocked(env, failKey, LIMITS.failIp)) || !(await hit(env, `unlock:${link.id}:${prefix}`, UNLOCK)))
      return show("limited", 429, { "retry-after": String(UNLOCK.s) });
  } catch {
    return show("unavailable", 503); // fail closed: no limiter, no password check
  }

  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) return plain("Payload too large", 413);
  const password = new URLSearchParams(new TextDecoder().decode(bytes)).get("password");
  // Only right or wrong is observable: every check of this link runs the same PBKDF2 and a timing-safe compare.
  if (password === null || link.passwordHash === null || !(await verifyPassword(password, link.passwordHash))) {
    await hit(env, failKey, LIMITS.failIp).catch(() => false);
    return show("wrong", 401);
  }

  const m = splitQrMarker(url.search);
  const res = new Response(null, {
    status: 303, // always 303, whatever redirect_code says (R4): POST becomes GET, nothing cacheable pairs URL and destination
    headers: { location: destinationOf(req, link, m.search), "cache-control": "private, no-store", "referrer-policy": "no-referrer", ...robots(domain) },
  });
  if (env.CLICKS && ctx) ctx.waitUntil(recordClick(env, req, link, domain, m.qr, now).catch(() => {}));
  return res;
}
