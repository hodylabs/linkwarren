// S14: Google, GitHub and generic OIDC sign-in. Provider config, discovery, the token exchange and the ID token checks.
// Tokens, codes, client secrets and provider error text never reach logs, errors, audit detail or API responses:
// every failure is an SsoError carrying one fixed code.
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { dash, dashUrl } from "./dash";
import type { Env } from "./env";
import { getSecret, type SecretName } from "./secrets";
import { sha256Hex } from "./session";

export const PROVIDERS = ["google", "github", "oidc"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

export const SECRET_OF: Record<Provider, SecretName> = { google: "GOOGLE_CLIENT_SECRET", github: "GITHUB_CLIENT_SECRET", oidc: "OIDC_CLIENT_SECRET" };
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const DEFAULT_LABEL = "Single sign-on";
const LABELS = { google: "Google", github: "GitHub" } as const;

export class SsoError extends Error {
  constructor(public code: "sso_failed" | "email_unverified") {
    super(code);
    this.name = "SsoError";
  }
}
const fail = () => new SsoError("sso_failed");

/** Settings rows (JSON values) under `sso.<provider>.<field>`; written only by src/api/sso.ts. */
export type SsoConfig = {
  google: { enabled: boolean; clientId: string | null };
  github: { enabled: boolean; clientId: string | null };
  oidc: { enabled: boolean; clientId: string | null; issuer: string | null; label: string | null };
};
export const ssoKey = (p: Provider, field: "enabled" | "clientId" | "issuer" | "label") => `sso.${p}.${field}`;

export async function ssoConfig(env: Env): Promise<SsoConfig> {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'sso.%'").all<{ key: string; value: string }>()).results;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const get = (p: Provider, f: "enabled" | "clientId" | "issuer" | "label") => {
    try {
      return JSON.parse(byKey.get(ssoKey(p, f)) ?? "null") as unknown;
    } catch {
      return null;
    }
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const one = (p: Provider) => ({ enabled: get(p, "enabled") === true, clientId: str(get(p, "clientId")) });
  return { google: one("google"), github: one("github"), oidc: { ...one("oidc"), issuer: str(get("oidc", "issuer")), label: str(get("oidc", "label")) } };
}

/** What a sign-in with `p` needs, or null when the provider is off or incomplete (R10). */
export type Ready = { provider: Provider; clientId: string; secret: string; issuer: string | null; label: string };
export async function ready(env: Env, cfg: SsoConfig, p: Provider): Promise<Ready | null> {
  const c = cfg[p];
  const issuer = p === "google" ? GOOGLE_ISSUER : p === "oidc" ? cfg.oidc.issuer : null;
  if (!c.enabled || !c.clientId || (p === "oidc" && !issuer)) return null;
  const secret = (await getSecret(env, SECRET_OF[p]))?.value;
  if (!secret) return null;
  return { provider: p, clientId: c.clientId, secret, issuer, label: p === "oidc" ? cfg.oidc.label ?? DEFAULT_LABEL : LABELS[p] };
}

/** R1: the exact redirect URI, built from the configured dashboard (never the request Host). */
export const redirectUri = (env: Env, p: Provider) => dashUrl(env, `/auth/sso/${p}/callback`);

/** R2: the state cookie's name and Path for this instance's mode. */
export function stateCookie(env: Env): { name: string; path: string } {
  const d = dash(env);
  if (!d) throw new Error("sso cookie: misconfigured");
  return d.pathMode ? { name: "__Secure-lw_sso", path: d.prefix } : { name: "__Host-lw_sso", path: "/" };
}

/** R5: https, a host, no credentials, query or fragment, at most 512 characters. */
export function issuerOk(raw: string): boolean {
  const u = URL.parse(raw);
  return raw.length <= 512 && !!u && u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.search && !u.hash &&
    !raw.includes("?") && !raw.includes("#");
}

const MAX_BODY = 256 * 1024;
const httpsUrl = (v: unknown): v is string => typeof v === "string" && URL.parse(v)?.protocol === "https:";

/** https only, no redirects, 10 s, a body of at most 256 KiB parsed as JSON; anything else is sso_failed. */
async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  if (!httpsUrl(url)) throw fail();
  try {
    const r = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!r.ok || !r.body || Number(r.headers.get("content-length") ?? 0) > MAX_BODY) {
      await r.body?.cancel();
      throw fail();
    }
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_BODY) {
        await reader.cancel();
        throw fail();
      }
      parts.push(value);
    }
    const all = new Uint8Array(n);
    let i = 0;
    for (const p of parts) { all.set(p, i); i += p.byteLength; }
    return JSON.parse(new TextDecoder().decode(all)) as unknown;
  } catch {
    throw fail(); // never the cause: a fetch or parse error can quote the response
  }
}

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; basic: boolean; jwks: JSONWebKeySet };

/** R5: the issuer's discovery document plus its JWKS, cached in KV for an hour; `fresh` skips the cache (save, key rotation). */
export async function discover(env: Env, issuer: string, fresh = false): Promise<Discovery> {
  const key = `sso:disc:${await sha256Hex(issuer)}`;
  if (!fresh) {
    const hit = await env.CACHE.get<Discovery>(key, "json").catch(() => null);
    if (hit) return hit;
  }
  if (!issuerOk(issuer)) throw fail();
  const d = (await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)) as Record<string, unknown> | null;
  if (!d || d.issuer !== issuer || !httpsUrl(d.authorization_endpoint) || !httpsUrl(d.token_endpoint) || !httpsUrl(d.jwks_uri)) throw fail();
  const jwks = (await fetchJson(d.jwks_uri)) as JSONWebKeySet | null;
  if (!jwks || !Array.isArray(jwks.keys)) throw fail();
  const methods = d.token_endpoint_auth_methods_supported;
  // The spec default (no list) is client_secret_basic; post only when the issuer does not offer basic.
  const basic = !Array.isArray(methods) || methods.includes("client_secret_basic") || !methods.includes("client_secret_post");
  const out: Discovery = { issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri, basic, jwks };
  await env.CACHE.put(key, JSON.stringify(out), { expirationTtl: 3600 }).catch(() => {});
  return out;
}

/** The provider's authorization URL for one started sign-in (R2, R4: PKCE S256, state, nonce). */
export async function authorizeUrl(env: Env, r: Ready, a: { state: string; nonce: string; challenge: string }): Promise<string> {
  const u = r.provider === "github" ? new URL("https://github.com/login/oauth/authorize") : new URL((await discover(env, r.issuer!)).authorization_endpoint);
  const q = u.searchParams;
  q.set("client_id", r.clientId);
  q.set("redirect_uri", redirectUri(env, r.provider));
  q.set("state", a.state);
  q.set("code_challenge", a.challenge);
  q.set("code_challenge_method", "S256");
  if (r.provider === "github") {
    q.set("scope", "read:user user:email");
    q.set("allow_signup", "false");
  } else {
    q.set("response_type", "code");
    q.set("scope", "openid email");
    q.set("nonce", a.nonce);
  }
  return u.href;
}

/** base64url SHA-256 of the PKCE verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Who = { subject: string; email: string };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const form = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

/** Code exchange and identity check (R4). Throws SsoError("sso_failed" | "email_unverified"). */
export async function identify(env: Env, r: Ready, code: string, verifier: string, nonce: string): Promise<Who> {
  return r.provider === "github" ? github(env, r, code, verifier) : oidc(env, r, code, verifier, nonce);
}

async function oidc(env: Env, r: Ready, code: string, verifier: string, nonce: string): Promise<Who> {
  const issuer = r.issuer!;
  const d = await discover(env, issuer);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(env, r.provider), code_verifier: verifier });
  const headers: Record<string, string> = { ...form };
  if (d.basic) headers.authorization = `Basic ${btoa(`${encodeURIComponent(r.clientId)}:${encodeURIComponent(r.secret)}`)}`;
  else { body.set("client_id", r.clientId); body.set("client_secret", r.secret); }
  const tok = (await fetchJson(d.token_endpoint, { method: "POST", headers, body })) as Record<string, unknown> | null;
  const idToken = tok?.id_token;
  if (typeof idToken !== "string") throw fail();
  const check = async (jwks: JSONWebKeySet) => (await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer, audience: r.clientId, algorithms: ["RS256", "ES256"], clockTolerance: 300, maxTokenAge: 600, requiredClaims: ["exp", "iat", "sub"],
  })).payload;
  let p: JWTPayload;
  try {
    p = await check(d.jwks);
  } catch (e) {
    if (!(e instanceof errors.JWKSNoMatchingKey)) throw fail();
    // A rotated key: one fresh JWKS, then give up.
    try { p = await check((await discover(env, issuer, true)).jwks); } catch { throw fail(); }
  }
  if (p.nonce !== nonce) throw fail();
  if (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== r.clientId) throw fail();
  const email = typeof p.email === "string" ? p.email.trim() : "";
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 255 || !EMAIL.test(email)) throw fail();
  // Google sends a boolean; for OIDC a missing or non-boolean claim counts as not verified (R4).
  if (p.email_verified !== true) throw new SsoError("email_unverified");
  return { subject: p.sub, email };
}

async function github(env: Env, r: Ready, code: string, verifier: string): Promise<Who> {
  const body = new URLSearchParams({ client_id: r.clientId, client_secret: r.secret, code, redirect_uri: redirectUri(env, "github"), code_verifier: verifier });
  const tok = (await fetchJson("https://github.com/login/oauth/access_token", { method: "POST", headers: form, body })) as Record<string, unknown> | null;
  const at = tok?.access_token;
  if (typeof at !== "string" || !at) throw fail(); // GitHub answers 200 with an error field on a bad code
  const h = { authorization: `Bearer ${at}`, accept: "application/vnd.github+json", "user-agent": "linkwarren" };
  const [user, emails] = await Promise.all([fetchJson("https://api.github.com/user", { headers: h }), fetchJson("https://api.github.com/user/emails", { headers: h })]);
  const id = (user as Record<string, unknown> | null)?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || !Array.isArray(emails)) throw fail();
  // Only the primary address, and only when GitHub has verified it.
  const primary = (emails as Record<string, unknown>[]).find((e) => e && e.primary === true);
  const email = typeof primary?.email === "string" ? primary.email.trim() : "";
  if (!EMAIL.test(email)) throw fail();
  if (primary!.verified !== true) throw new SsoError("email_unverified");
  return { subject: String(id), email };
}

/** The lowercase domain part of an address. */
export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** R7: true when this person must use OIDC (their email domain is enforced). Owners are never blocked (break-glass). */
export async function ssoRequired(env: Env, user: { role: string; email: string }): Promise<boolean> {
  return user.role !== "owner" && (await domainEnforced(env, user.email));
}

/** The address's domain has SSO enforced. */
export const domainEnforced = async (env: Env, email: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM email_domains WHERE domain = ? AND enforce_sso = 1").bind(emailDomain(email)).first());
