import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

export const ISS = "https://team.example.cloudflareaccess.com";
export const AUD = "test-aud";
let priv: CryptoKey;
/** A key the JWKS does not contain, for foreign-signature tests. */
export let other: CryptoKey;

/** Installs a local JWKS (the ACCESS_JWKS_JSON test seam); call once in beforeAll. */
export async function setupAccess(): Promise<void> {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  other = (await generateKeyPair("RS256")).privateKey;
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
  (env as { ACCESS_JWKS_JSON?: string }).ACCESS_JWKS_JSON = JSON.stringify({ keys: [pub] });
}

export type Opts = { noExp?: boolean; email?: string | null; iss?: string; aud?: string; exp?: string | number; key?: CryptoKey };
export async function token(o: Opts = {}) {
  const claims = o.email === null ? {} : { email: o.email ?? "a@example.com" };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setIssuedAt();
  if (!o.noExp) jwt.setExpirationTime(o.exp ?? "5m");
  return jwt.sign(o.key ?? priv);
}
export const tokenFor = (email: string) => token({ email });

export const ORIGIN = "https://dash.test";
/** Fetches the dashboard host the way the browser app does: same-origin Origin header unless the test overrides it. */
export const dash = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) } });
