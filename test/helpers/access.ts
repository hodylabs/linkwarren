import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

const ISS = "https://team.example.cloudflareaccess.com";
let priv: CryptoKey;

/** Installs a local JWKS (the ACCESS_JWKS_JSON test seam); call once in beforeAll. */
export async function setupAccess(): Promise<void> {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
  (env as { ACCESS_JWKS_JSON?: string }).ACCESS_JWKS_JSON = JSON.stringify({ keys: [pub] });
}

export const tokenFor = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISS).setAudience("test-aud").setIssuedAt().setExpirationTime("5m").sign(priv);
