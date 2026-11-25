import { vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose";

export const ISS = "https://idp.example.com";
export const GOOGLE = "https://accounts.google.com";
export type Claims = JWTPayload & { email?: unknown; email_verified?: unknown; nonce?: unknown };
export type GhEmail = { email: string; primary: boolean; verified: boolean };

/**
 * A fake OpenID provider (ISS and Google's issuer) and GitHub behind a fetch stub, with a local RS256 key pair.
 * `start` records the authorize URL's nonce, so the next ID token carries it unless `claims` overrides it.
 * Any other URL throws, so a test never reaches the network. Restore with vi.restoreAllMocks().
 */
export async function fakeIdp() {
  const kp = await generateKeyPair("RS256", { extractable: true });
  const other = (await generateKeyPair("RS256")).privateKey;
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JWK;
  const s = {
    nonce: "" as string,
    clientId: "client-1",
    sub: "sub-1",
    email: "a@example.com",
    claims: {} as Claims,
    key: kp.privateKey as CryptoKey,
    gh: { id: 4242, name: null as unknown, emails: [{ email: "a@example.com", primary: true, verified: true }] as GhEmail[] },
    calls: [] as { url: string; method: string; headers: Headers; body: string }[],
    tokenStatus: 200,
    /** Runs while the token call is in flight (e.g. a settings change racing the callback). */
    onToken: null as null | (() => Promise<void>),
    /** Runs while a discovery document is fetched (e.g. a settings save racing another). */
    onDiscovery: null as null | (() => Promise<void>),
  };
  const doc = (iss: string, base: string) => ({
    issuer: iss, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`,
  });
  const idToken = async (iss: string) => {
    const { exp, iat, ...rest } = s.claims;
    const t = new SignJWT({ email: s.email, email_verified: true, nonce: s.nonce, ...rest })
      .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(s.clientId).setSubject(s.sub)
      .setIssuedAt(iat ?? Math.floor(Date.now() / 1000)).setExpirationTime(exp ?? "5m");
    if ("iss" in s.claims) t.setIssuer(s.claims.iss as string);
    if ("aud" in s.claims) t.setAudience(s.claims.aud as string);
    return t.sign(s.key);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    s.calls.push({ url, method, headers: new Headers(init?.headers), body: init?.body ? String(init.body) : "" });
    const origin = new URL(url).origin;
    const google = origin === GOOGLE || origin === "https://oauth2.example.test";
    const base = google ? "https://oauth2.example.test" : ISS;
    if (url.endsWith("/.well-known/openid-configuration")) await s.onDiscovery?.();
    if (url === `${ISS}/.well-known/openid-configuration`) return Response.json(doc(ISS, ISS));
    if (url === `${GOOGLE}/.well-known/openid-configuration`) return Response.json(doc(GOOGLE, base));
    if (url === `${base}/jwks`) return Response.json({ keys: [pub] });
    if (url === `${base}/token` && method === "POST") {
      await s.onToken?.();
      if (s.tokenStatus !== 200) return Response.json({ error: "invalid_grant", error_description: "PROVIDER-SECRET-TEXT" }, { status: s.tokenStatus });
      return Response.json({ access_token: "at", id_token: await idToken(google ? GOOGLE : ISS) });
    }
    if (url === "https://github.com/login/oauth/access_token" && method === "POST") return Response.json({ access_token: "gho_test" });
    if (url === "https://api.github.com/user") return Response.json({ id: s.gh.id, login: "octo", name: s.gh.name });
    if (url === "https://api.github.com/user/emails") return Response.json(s.gh.emails);
    throw new Error(`unexpected fetch ${url}`);
  });
  return {
    s,
    other,
    /** Remembers the nonce of an authorize URL, as the provider would. */
    sawAuthorize(url: string) { s.nonce = new URL(url).searchParams.get("nonce") ?? ""; },
    tokenCall: () => s.calls.filter((c) => c.url.endsWith("/token") || c.url.endsWith("/access_token")).at(-1),
  };
}
