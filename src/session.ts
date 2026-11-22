import { auditStmt } from "./audit";
import type { Env } from "./env";
import { rowToUser, type SessionRef, type UserRow } from "./types";

export const SESSION_COOKIE = "__Host-lw_session";
/** Rolling idle lifetime (30 d), absolute cap and cookie Max-Age (90 d), and how often a live session is refreshed (10 min). */
export const ROLLING = 2_592_000;
export const ABSOLUTE = 7_776_000;
export const TOUCH_EVERY = 600;

/** 256 bits from the CSPRNG, base64url without padding (43 chars). */
export function newSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Plain SHA-256 is enough for 256-bit random secrets: nothing to brute-force, so no salt or slow KDF. */
export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The session cookie value when it has the exact secret shape; anything else (or a missing cookie) is null.
 * A duplicated name takes the first one (browsers send the longest path first), and a malformed first one fails closed.
 * `__Host-` stops sibling hosts from setting this name in current browsers; refusing duplicates outright would only trade
 * that leftover login-CSRF risk (old browsers) for a cookie-tossing lockout, so the first one wins.
 */
export function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
    }
  }
  return null;
}

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * A fresh session for `user`: statements for the caller's batch (drop the incoming cookie's session (R8, fixation), insert, audit)
 * and the Set-Cookie value. The secret leaves this function only inside `setCookie`.
 */
export async function createSession(env: Env, req: Request, user: UserRow, method: "email" | "passkey"): Promise<{ setCookie: string; stmts: D1PreparedStatement[] }> {
  const secret = newSecret();
  const id = crypto.randomUUID();
  const now = nowS();
  const stmts: D1PreparedStatement[] = [];
  const old = readCookie(req);
  if (old) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(old)));
  stmts.push(
    env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, method, created_at, last_seen_at, expires_at, device, ip_prefix) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, await sha256Hex(secret), user.id, method, now, now, now + ROLLING, deviceLabel(req.headers.get("user-agent")), ipPrefix(req.headers.get("cf-connecting-ip"))),
    auditStmt(env, { actorId: user.id, action: "auth.sign_in", targetType: "session", targetId: id, detail: { method } },
      { sql: "EXISTS (SELECT 1 FROM sessions WHERE id = ?)", binds: [id] }),
  );
  // __Host- forces Secure, Path=/ and no Domain: host-only, so short-link hosts never receive it.
  return { setCookie: `${SESSION_COOKIE}=${secret}; Path=/; Max-Age=${ABSOLUTE}; Secure; HttpOnly; SameSite=Lax`, stmts };
}

/** The signed-in person for the request's cookie, refused past `expires_at` (rolling) or the absolute cap; refreshes at most every TOUCH_EVERY. */
export async function readSession(req: Request, env: Env): Promise<{ user: UserRow; session: SessionRef } | null> {
  const secret = readCookie(req);
  if (!secret) return null;
  const now = nowS();
  const r = await env.DB.prepare(
    "SELECT u.*, s.id sid, s.created_at screated, s.last_seen_at sseen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.created_at > ?",
  ).bind(await sha256Hex(secret), now, now - ABSOLUTE).first<Record<string, unknown>>();
  if (!r) return null;
  const user = rowToUser(r);
  // Guarded on last_seen_at so concurrent requests refresh once; a disabled person's session is never extended.
  if (user.status === "active" && (r.sseen as number) <= now - TOUCH_EVERY) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = MIN(created_at + ${ABSOLUTE}, ? + ${ROLLING}) WHERE id = ? AND last_seen_at <= ?`)
      .bind(now, now, r.sid, now - TOUCH_EVERY).run();
  }
  return { user, session: { id: r.sid as string, createdAt: r.screated as number } };
}

export const clearCookie = (): string => `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

/** Deletes one session by public id, or all of a person's sessions; `guard` adds an AND condition (e.g. a race check). */
export function endSessionStmt(env: Env, where: { id: string } | { userId: string }, guard?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const [col, v] = "id" in where ? ["id", where.id] : ["user_id", where.userId];
  return env.DB.prepare(`DELETE FROM sessions WHERE ${col} = ?${guard ? ` AND (${guard.sql})` : ""}`).bind(v, ...(guard?.binds ?? []));
}

const BROWSERS: [RegExp, string][] = [[/Edg(e|A|iOS)?\//, "Edge"], [/(Chrome|CriOS)\//, "Chrome"], [/(Firefox|FxiOS)\//, "Firefox"], [/Version\/(?=.*Safari\/)/, "Safari"]];
const SYSTEMS: [RegExp, string][] = [[/Windows/, "Windows"], [/iPhone|iPad|iPod/, "iOS"], [/Macintosh|Mac OS X/, "macOS"], [/Android/, "Android"], [/CrOS/, "ChromeOS"], [/Linux/, "Linux"]];

/** "<Browser> on <OS>" from a short known list, else null. Order matters: Edge says Chrome, iOS says Mac OS X, Android says Linux. */
export function deviceLabel(ua: string | null): string | null {
  if (!ua) return null;
  ua = ua.slice(0, 512); // bounds regex work on an attacker-sized header; real UAs are far shorter
  const b = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const o = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return b && o ? `${b} on ${o}`.slice(0, 40) : null;
}

const v4Prefix = (s: string) => {
  const p = s.split(".");
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && +x <= 255) ? `${+p[0]!}.${+p[1]!}.${+p[2]!}.0/24` : null;
};

/** IPv4 as its /24, IPv6 as its /48, IPv4-mapped IPv6 as IPv4; anything unparseable is null. */
export function ipPrefix(ip: string | null): string | null {
  const s = (ip ?? "").trim().toLowerCase();
  if (s.includes(".")) {
    const m = /^(?:::ffff:)?([\d.]+)$/.exec(s);
    return m ? v4Prefix(m[1]!) : null;
  }
  const halves = s.split("::");
  if (!s || halves.length > 2) return null;
  const parts = (h: string) => (h ? h.split(":") : []);
  const head = parts(halves[0]!), tail = parts(halves[1] ?? "");
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const g = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  const n = g.map((x) => parseInt(x, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.0/24`;
  return `${n.slice(0, 3).map((x) => x.toString(16)).join(":")}::/48`;
}

/**
 * A same-origin relative return path, else "/": starts with "/" (not "//" or "/\"), no control characters, at most 2048 chars,
 * and resolves to `origin`. The raw value is returned (not the parsed path) because the parser can turn "/.//x" into "//x".
 */
export function safeNext(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const u = new URL(raw, origin);
    // A dot segment can still resolve to a "//x" pathname (same origin, but protocol-relative if anything re-resolves it).
    return u.origin === new URL(origin).origin && !u.pathname.startsWith("//") ? raw : "/";
  } catch {
    return "/";
  }
}
