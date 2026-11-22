import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

// Software WebAuthn authenticator for tests: attestation "none", ES256 (-7) or RS256 (-257), WebCrypto only, no test dependency.
// It signs whatever rpId and origin it is given, so tests can play a phishing site (evil.test) against the real verifier.
const enc = new TextEncoder();
const concat = (...p: Uint8Array[]): Uint8Array => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sha256 = async (d: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", d as BufferSource));

// Minimal CBOR: unsigned/negative ints, byte and text strings, maps. Enough for the COSE key and the "none" attestation object.
type Cbor = number | Uint8Array | string | Map<Cbor, Cbor>;
function cbor(v: Cbor): Uint8Array {
  const head = (major: number, n: number): Uint8Array =>
    n < 24 ? Uint8Array.of((major << 5) | n)
    : n < 256 ? Uint8Array.of((major << 5) | 24, n)
    : Uint8Array.of((major << 5) | 25, n >> 8, n & 255); // 16-bit is enough: the largest item is an RSA modulus (256 bytes)
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = enc.encode(v); return concat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

// WebCrypto gives ECDSA as raw r||s; WebAuthn wants ASN.1 DER.
function derSig(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
    const t = b.slice(i);
    return concat(Uint8Array.of(0x02, t.length + (t[0]! & 0x80 ? 1 : 0)), t[0]! & 0x80 ? Uint8Array.of(0) : new Uint8Array(0), t);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

/** base64url of a string's UTF-8 bytes, the form WebAuthn sends `userHandle` in. */
export const b64uText = (s: string): string => b64u(enc.encode(s));

export function softAuthenticator(o: { rpId?: string; origin?: string; alg?: -7 | -257 } = {}) {
  const alg = o.alg ?? -7;
  const credId = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = b64u(credId);
  let counter = 0;
  let keys: CryptoKeyPair | undefined;
  const rpIdOf = (fromOpts: string | undefined) => o.rpId ?? fromOpts ?? "localhost";
  const originOf = (rpId: string) => o.origin ?? `https://${rpId}`;

  const keyPair = async (): Promise<CryptoKeyPair> =>
    (keys ??= (alg === -7
      ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      : await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair);

  const coseKey = async (): Promise<Uint8Array> => {
    const jwk = (await crypto.subtle.exportKey("jwk", (await keyPair()).publicKey)) as JsonWebKey;
    const m = new Map<Cbor, Cbor>();
    if (alg === -7) { m.set(1, 2).set(3, -7).set(-1, 1).set(-2, unb64u(jwk.x!)).set(-3, unb64u(jwk.y!)); }
    else { m.set(1, 3).set(3, -257).set(-1, unb64u(jwk.n!)).set(-2, unb64u(jwk.e!)); }
    return cbor(m);
  };

  const authData = async (rpId: string, flags: number, ctr: number, attested?: Uint8Array): Promise<Uint8Array> =>
    concat(await sha256(enc.encode(rpId)), Uint8Array.of(flags), Uint8Array.of(ctr >>> 24, (ctr >>> 16) & 255, (ctr >>> 8) & 255, ctr & 255), attested ?? new Uint8Array(0));

  const clientData = (type: string, challenge: string, origin: string): Uint8Array => enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    credentialId,
    async register(opts: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
      const rpId = rpIdOf(opts.rp.id);
      const att = concat(new Uint8Array(16), Uint8Array.of(credId.length >> 8, credId.length & 255), credId, await coseKey());
      const ad = await authData(rpId, 0x45 /* UP | UV | AT */, 0, att);
      const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]));
      return {
        id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientData("webauthn.create", opts.challenge, originOf(rpId))), attestationObject: b64u(attestationObject), transports: ["internal"] },
      };
    },
    /** `rpId` and `origin` override the constructor's for this assertion only (the same key used on a phishing site). */
    async authenticate(opts: PublicKeyCredentialRequestOptionsJSON, a: { counter?: number; userHandle?: string; rpId?: string; origin?: string } = {}): Promise<AuthenticationResponseJSON> {
      const rpId = a.rpId ?? rpIdOf(opts.rpId);
      const ad = await authData(rpId, 0x05 /* UP | UV */, a.counter ?? ++counter);
      const cd = clientData("webauthn.get", opts.challenge, a.origin ?? originOf(rpId));
      const data = concat(ad, await sha256(cd));
      const pk = (await keyPair()).privateKey;
      const sig = new Uint8Array(await crypto.subtle.sign(alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5", pk, data as BufferSource));
      return {
        id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
        response: { authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u(alg === -7 ? derSig(sig) : sig), ...(a.userHandle ? { userHandle: a.userHandle } : {}) },
      };
    },
  };
}
