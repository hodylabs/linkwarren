import type { Env } from "./env";

/** Provisional: sized for the Workers Free plan's 10 ms CPU; finalised from the live Free measurement. */
export const PASSWORD_DEFAULT_ITERATIONS = 10000;
/** Workers WebCrypto PBKDF2 maximum; also the DoS ceiling for counts read back from a stored hash. */
export const PASSWORD_MAX_ITERATIONS = 100000;
const MIN_SETTING = 1000;
const PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MAX_RAW_UNITS = 4096;

/** Instance setting: trimmed decimal integer, clamped to 1000..100000; unset, blank or not an integer gives the default. */
export function iterationsOf(env: Pick<Env, "PASSWORD_HASH_ITERATIONS">): number {
  const v = env.PASSWORD_HASH_ITERATIONS?.trim() ?? "";
  if (!/^\d{1,9}$/.test(v)) return PASSWORD_DEFAULT_ITERATIONS;
  return Math.min(PASSWORD_MAX_ITERATIONS, Math.max(MIN_SETTING, Number(v)));
}

/** NFC-normalizes (never trims) and checks 8 to 128 code points. */
export function checkPassword(raw: string): { ok: true; value: string } | { ok: false; reason: "password_short" | "password_long" } {
  const value = raw.normalize("NFC");
  const n = [...value].length;
  if (n < 8) return { ok: false, reason: "password_short" };
  if (n > 128) return { ok: false, reason: "password_long" };
  return { ok: true, value };
}

const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Strict: only the unpadded base64url alphabet at the exact length for `bytes`, else null. */
function unb64u(s: string, bytes: number): Uint8Array<ArrayBuffer> | null {
  if (s.length !== Math.ceil((bytes * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const out = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return out.length === bytes ? out : null;
}

async function derive(value: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(value), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BYTES * 8);
}

/** `value` is the `checkPassword` output (already NFC). Format: pbkdf2-sha256$<iterations>$<salt>$<hash>. */
export async function hashPassword(value: string, iterations: number): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_MAX_ITERATIONS) throw new Error("bad iteration count");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = new Uint8Array(await derive(value, salt, iterations));
  return `${PREFIX}$${iterations}$${b64u(salt)}$${b64u(hash)}`;
}

/** Uses the stored count; anything malformed, or a count outside 1..PASSWORD_MAX_ITERATIONS, is false (never throws). */
export async function verifyPassword(raw: string, stored: string): Promise<boolean> {
  // CPU guard before NFC work: 128 code points never exceed this many UTF-16 units, even typed decomposed.
  if (raw.length > MAX_RAW_UNITS) return false;
  try {
    const p = stored.split("$");
    if (p.length !== 4 || p[0] !== PREFIX || !/^[1-9]\d{0,5}$/.test(p[1])) return false;
    const iterations = Number(p[1]);
    if (iterations > PASSWORD_MAX_ITERATIONS) return false;
    const salt = unb64u(p[2], SALT_BYTES);
    const want = unb64u(p[3], HASH_BYTES);
    if (!salt || !want) return false;
    const got = await derive(raw.normalize("NFC"), salt, iterations);
    return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
