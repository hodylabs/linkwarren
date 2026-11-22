// The only module that imports @simplewebauthn/server (R1). Every failure surfaces as PasskeyError("passkey_failed"):
// library errors can quote client data, so their text is never logged or returned.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { rowToUser, type UserRow } from "./types";

export const CHALLENGE_TTL = 300;
export const MAX_PASSKEYS = 10;
/** R10: ES256 and RS256 only (v14's default list adds EdDSA and ML-DSA-44). */
const ALGS = [-7, -257];
const TRANSPORTS = new Set<string>(["ble", "hybrid", "internal", "nfc", "usb"]);

export class PasskeyError extends Error {
  constructor(code: "passkey_failed" = "passkey_failed") {
    super(code);
    this.name = "PasskeyError";
  }
}

export const rp = (env: Env): { rpID: string; origin: string } => {
  const rpID = normalizeHost(env.DASHBOARD_HOST);
  return { rpID, origin: `https://${rpID}` };
};

const nowS = () => Math.floor(Date.now() / 1000);
const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const fail = (): never => { throw new PasskeyError(); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The challenge the client signed over, read back from clientDataJSON (R10: no extra cookie); anything malformed fails. */
function challengeOf(response: unknown): string {
  try {
    const cd = isObj(response) && isObj(response.response) ? response.response.clientDataJSON : null;
    if (typeof cd !== "string") return fail();
    const c = (JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(unb64u(cd))) as Record<string, unknown>).challenge;
    return typeof c === "string" && c.length > 0 && c.length <= 128 ? c : fail();
  } catch {
    return fail();
  }
}

const store = (env: Env, challenge: string, purpose: "register" | "login", userId: string | null) =>
  env.DB.prepare("INSERT INTO auth_challenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(challenge, purpose, userId, nowS() + CHALLENGE_TTL).run();

export async function registrationOptions(env: Env, user: UserRow): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const mine = await env.DB.prepare("SELECT credential_id, transports FROM passkeys WHERE user_id = ?").bind(user.id)
    .all<{ credential_id: string; transports: string }>();
  const o = await generateRegistrationOptions({
    rpName: "linkwarren", rpID: rp(env).rpID, userName: user.email, userDisplayName: user.name ?? user.email,
    userID: new Uint8Array(new TextEncoder().encode(user.id)), attestationType: "none", supportedAlgorithmIDs: ALGS,
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: mine.results.map((r) => ({ id: r.credential_id, transports: JSON.parse(r.transports) as AuthenticatorTransport[] })),
  });
  await store(env, o.challenge, "register", user.id);
  return o;
}

export async function verifyRegistration(env: Env, user: UserRow, response: unknown): Promise<{
  credentialId: string; publicKey: string; counter: number; transports: string[]; deviceType: string; backedUp: boolean;
}> {
  const challenge = challengeOf(response);
  // Single use, and only for the person who fetched the options and is still active (auth_challenges.user_id has no FK).
  const used = await env.DB.prepare(
    "DELETE FROM auth_challenges WHERE challenge = ? AND purpose = 'register' AND user_id = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active') RETURNING challenge",
  ).bind(challenge, user.id, nowS(), user.id).first();
  if (!used) return fail();
  const { rpID, origin } = rp(env);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false, supportedAlgorithmIDs: ALGS,
    });
  } catch {
    return fail();
  }
  if (!v.verified || !v.registrationInfo) return fail();
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  return {
    credentialId: credential.id, publicKey: b64u(credential.publicKey), counter: credential.counter,
    // Client-supplied: keep only known names so stored values stay sane for excludeCredentials.
    transports: [...new Set(credential.transports ?? [])].filter((t) => TRANSPORTS.has(t)),
    deviceType: credentialDeviceType, backedUp: credentialBackedUp,
  };
}

export async function authenticationOptions(env: Env): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const o = await generateAuthenticationOptions({ rpID: rp(env).rpID, allowCredentials: [], userVerification: "preferred" });
  await store(env, o.challenge, "login", null);
  return o;
}

export async function verifyAuthentication(env: Env, response: unknown): Promise<{ user: UserRow; passkeyId: string; newCounter: number }> {
  const challenge = challengeOf(response);
  const used = await env.DB.prepare("DELETE FROM auth_challenges WHERE challenge = ? AND purpose = 'login' AND expires_at > ? RETURNING challenge")
    .bind(challenge, nowS()).first();
  if (!used) return fail();
  const r = response as Record<string, unknown> & { response: Record<string, unknown> }; // shape checked by challengeOf
  if (typeof r.id !== "string" || r.id.length > 1366) return fail(); // 1023-byte WebAuthn credential id cap, base64url
  const row = await env.DB.prepare(
    "SELECT p.id pid, p.public_key, p.counter, p.transports, u.* FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ?",
  ).bind(r.id).first<Record<string, unknown>>();
  if (!row) return fail();
  const user = rowToUser(row);
  // R10: a discoverable credential names its owner; it must be the credential's owner.
  const handle = r.response.userHandle;
  if (handle !== undefined && handle !== null) {
    try {
      if (typeof handle !== "string" || new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(unb64u(handle)) !== user.id) return fail();
    } catch {
      return fail();
    }
  }
  const { rpID, origin } = rp(env);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: r.id, publicKey: unb64u(row.public_key as string), counter: row.counter as number,
        transports: JSON.parse(row.transports as string) as AuthenticatorTransport[],
      },
    });
  } catch {
    return fail(); // includes the counter rule: both non-zero and not increasing
  }
  if (!v.verified) return fail();
  return { user, passkeyId: row.pid as string, newCounter: v.authenticationInfo.newCounter };
}
