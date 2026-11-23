// Storage choice (R2): rows in the existing `settings` table under key `secret.<NAME>` (no migration, no secrets table).
// Value format `v1.<iv b64url>.<ciphertext+tag b64url>`: AES-GCM 256, a fresh random 96-bit IV per write, AAD = the name (UTF-8; QR codes use `qr.<id>`),
// key = the Worker secret SECRETS_KEY (base64 of exactly 32 bytes). Exports must skip `key LIKE 'secret.%'`; getSettings never reads them.
// Plaintext, key and ciphertext never reach logs, errors, audit detail or API responses.
import { auditStmt } from "./audit";
import type { Guard } from "./roles";
import type { Env } from "./env";

export type SecretName = "CF_API_TOKEN" | "RESEND_API_KEY";
export type SecretSource = "secret" | "dashboard" | "missing";

export class SecretsError extends Error {
  constructor(public code: "secrets_key_missing") {
    super(code);
    this.name = "SecretsError";
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const rowKey = (name: SecretName) => `secret.${name}`;
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function rawKey(env: Env): Uint8Array | null {
  const s = env.SECRETS_KEY?.trim();
  if (!s) return null;
  try {
    const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    return b.length === KEY_BYTES ? b : null;
  } catch {
    return null;
  }
}

export const secretsReady = (env: Env): boolean => rawKey(env) !== null;

const aesKey = (raw: Uint8Array, use: "encrypt" | "decrypt") => crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);

/**
 * AES-GCM 256 with SECRETS_KEY: a fresh random 96-bit IV per call, `aad` bound as additional data. Returns `v1.<iv>.<ct>`.
 * Throws SecretsError("secrets_key_missing") when SECRETS_KEY is missing or not 32 bytes.
 */
export async function encryptValue(env: Env, aad: string, plaintext: string): Promise<string> {
  const raw = rawKey(env);
  if (!raw) throw new SecretsError("secrets_key_missing");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, await aesKey(raw, "encrypt"), utf8(plaintext));
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
}

/** The plaintext of an encryptValue result, or null for a missing key and any malformed, tampered, wrong-AAD or wrong-key value. */
export async function decryptValue(env: Env, aad: string, stored: string): Promise<string | null> {
  const raw = rawKey(env);
  return raw ? decrypt(raw, aad, stored) : null;
}

/** `guard` (optional): an SQL condition both statements also need, e.g. the actor is still an owner. */
export async function putSecretStmts(env: Env, actorId: string, name: SecretName, plaintext: string, guard?: Guard): Promise<D1PreparedStatement[]> {
  const value = await encryptValue(env, name, plaintext);
  const key = rowKey(name);
  return [
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE ${guard?.sql ?? "1"} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(key, value, Math.floor(Date.now() / 1000), actorId, ...(guard?.binds ?? [])),
    auditStmt(env, { actorId, action: "secret.update", targetType: "settings", targetId: key, detail: { name } },
      { sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [key, value] }),
  ];
}

export function deleteSecretStmts(env: Env, actorId: string, name: SecretName, guard?: Guard): D1PreparedStatement[] {
  const key = rowKey(name);
  return [
    env.DB.prepare(`DELETE FROM settings WHERE key = ?${guard ? ` AND ${guard.sql}` : ""}`).bind(key, ...(guard?.binds ?? [])),
    auditStmt(env, { actorId, action: "secret.delete", targetType: "settings", targetId: key, detail: { name } }, guard),
  ];
}

/** null for any malformed, tampered, wrong-AAD or wrong-key value. */
async function decrypt(raw: Uint8Array, aad: string, stored: string): Promise<string | null> {
  const [v, iv, ct, ...rest] = stored.split(".");
  if (v !== "v1" || !iv || !ct || rest.length) return null;
  try {
    const ivb = unb64u(iv);
    if (ivb.length !== IV_BYTES) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivb, additionalData: utf8(aad) }, await aesKey(raw, "decrypt"), unb64u(ct));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(pt) || null;
  } catch {
    return null;
  }
}

/** The Worker secret wins when set (non-empty after trim); else the value pasted in the dashboard. Unreadable reads as missing. */
export async function getSecret(env: Env, name: SecretName): Promise<{ value: string; source: "secret" | "dashboard" } | null> {
  const w = env[name]?.trim();
  if (w) return { value: w, source: "secret" };
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(rowKey(name)).first<{ value: string }>();
  if (!row) return null;
  const value = await decryptValue(env, name, row.value);
  if (value === null) {
    console.warn("secrets_unreadable", name);
    return null;
  }
  return { value, source: "dashboard" };
}

export async function secretStatus(env: Env): Promise<{ pasteAvailable: boolean; cf: SecretSource; resend: SecretSource }> {
  const [cf, resend] = await Promise.all([getSecret(env, "CF_API_TOKEN"), getSecret(env, "RESEND_API_KEY")]);
  return { pasteAvailable: secretsReady(env), cf: cf?.source ?? "missing", resend: resend?.source ?? "missing" };
}
