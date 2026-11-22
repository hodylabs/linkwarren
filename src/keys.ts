import { newSecret, sha256Hex } from "./session";

/** `lw_` + base64url of 32 CSPRNG bytes (46 chars). */
export const KEY_SHAPE = /^lw_[A-Za-z0-9_-]{43}$/;

/** A new personal API key: the secret is shown once; only its hash and the 10-char display prefix are stored. */
export function newKey(): { secret: string; prefix: string } {
  const secret = `lw_${newSecret()}`;
  return { secret, prefix: secret.slice(0, 10) };
}

/** Lowercase hex SHA-256 of the whole key. A 256-bit random secret has nothing to brute-force, so no salt or slow KDF. */
export const hashKey = (secret: string): Promise<string> => sha256Hex(secret);
