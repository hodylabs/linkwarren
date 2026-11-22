import { Hono, type Context } from "hono";
import { z } from "zod";
import { resolveUser } from "../auth";
import { sendEmail, signInEmail } from "../email";
import { getSecret } from "../secrets";
import { getSettings } from "../settings";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { DAY_KEYS_SQL, LIMITS, blocked, hit, limitKey } from "../limits";
import { createSession, ipPrefix, newSecret, safeNext, sha256Hex } from "../session";
import { PasskeyError, authenticationOptions, verifyAuthentication } from "../webauthn";

type E = { Bindings: Env };
/** Mounted at /auth behind appModeOnly (R2, R3); never behind requireUser, so it never calls authenticate. */
export const signin = new Hono<E>();

const TOKEN_TTL = 900;
const MAX_BODY = 8192;
const origin = (env: Env) => `https://${normalizeHost(env.DASHBOARD_HOST)}`;
const nowS = () => Math.floor(Date.now() / 1000);

// R3 guard: POST only (anything else is the JSON 404, never the SPA shell), the exact dashboard Origin is required
// (not just checked when present, as on /api/*), JSON only, never cached.
signin.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "POST") return c.json({ error: "not_found" }, 404);
  if (c.req.header("origin") !== origin(c.env)) return c.json({ error: "forbidden_origin" }, 403);
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "unsupported_media_type" }, 415);
  await next();
});

/** The body as text, or null past `max` bytes: stops reading there, so a chunked body without Content-Length is capped too. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { all.set(p, i); i += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
}

/** The parsed body, or null for oversized, non-JSON or invalid input (zod issues are never echoed). Shared with /api/account. */
export async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  try {
    const raw = await readCapped(c.req.raw, MAX_BODY);
    if (raw === null) return null;
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** R6 opportunistic prune, one bounded DELETE per table (D1 has no DELETE ... LIMIT). Over-90-day sessions already have expires_at <= now. */
function prunes(env: Env, now: number): D1PreparedStatement[] {
  const prune = (t: string, col: string, before: number, where = "1") =>
    env.DB.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${col} <= ? AND ${where} LIMIT 100)`).bind(before);
  return [
    prune("login_tokens", "expires_at", now),
    prune("auth_challenges", "expires_at", now),
    prune("auth_limits", "window_start", now - 3600, `NOT (${DAY_KEYS_SQL})`),
    prune("sessions", "expires_at", now),
  ];
}

const invalid = { error: "invalid_body" } as const;
const tooMany = { error: "too_many_attempts" } as const;

// Trim first, then validate, so the limiter key and the lookup both see the canonical address (Task 3 M3).
const emailBody = z.strictObject({ email: z.string().trim().pipe(z.email().max(254)), next: z.string().max(2048).optional() });

signin.post("/email", async (c) => {
  const b = await parse(c, emailBody);
  if (!b) return c.json(invalid, 400);
  const env = c.env;
  const notConfigured = () => c.json({ error: "email_not_configured" }, 503);
  if (!env.EMAIL_FROM?.trim()) return notConfigured();
  const prefix = ipPrefix(c.req.header("cf-connecting-ip") ?? null);
  // Both limiters count before any lookup, so unknown addresses use up their budget too (R5).
  const [byAddr, byIp] = await Promise.all([hit(env, await limitKey.addr(b.email), LIMITS.address), hit(env, limitKey.ip(prefix), LIMITS.ip)]);
  if (!byAddr || !byIp) return c.json(tooMany, 429);
  // After the limiters (a stored key costs a D1 read and a decrypt) and once per request: the mail reuses it.
  const key = (await getSecret(env, "RESEND_API_KEY"))?.value;
  if (!key) return notConfigured();

  const now = nowS();
  // One lookup for every address: same queries whether or not a mail goes out (R5).
  const [, , , , who] = await env.DB.batch([
    ...prunes(env, now),
    env.DB.prepare("SELECT (SELECT status FROM users WHERE email = ?) status, EXISTS (SELECT 1 FROM users) any_user").bind(b.email),
  ]);
  const row = who!.results[0] as { status: string | null; any_user: number };
  // R11: active or invited users, or the owner email while nobody exists yet. Disabled people get the same 202 and no mail.
  const canReceive = row.status === "active" || row.status === "invited" ||
    (!row.any_user && b.email.toLowerCase() === (env.OWNER_EMAIL ?? "").trim().toLowerCase());

  // R5: every write that only a receiving address needs runs after the response, so the response path does the same
  // D1 work for every address. R14: the instance cap still answers the same 202 and sends nothing.
  if (canReceive) c.executionCtx.waitUntil(mailLink(env, b.email, b.next, now, key));
  return c.json({ ok: true }, 202);
});

/** Background: instance cap, then the token row (hash only), then the mail. R4: the token rides in the URL fragment. */
async function mailLink(env: Env, email: string, next: string | undefined, now: number, key: string): Promise<void> {
  try {
    if (!(await hit(env, limitKey.inst, LIMITS.instance))) {
      console.warn("email_cap");
      return;
    }
    const secret = newSecret();
    await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(secret), email, safeNext(next, origin(env)), now, now + TOKEN_TTL).run();
    const name = (await getSettings(env)).name;
    await sendEmail(env, { to: email, name, key, ...signInEmail({ host: normalizeHost(env.DASHBOARD_HOST), url: `${origin(env)}/sign-in#token=${secret}`, name }) });
  } catch {
    console.warn("sign_in_mail_failed"); // codes only: a D1 error text could carry bound values
  }
}

const verifyBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

signin.post("/email/verify", async (c) => {
  const b = await parse(c, verifyBody);
  if (!b) return c.json(invalid, 400);
  const env = c.env;
  const failKey = limitKey.fail(ipPrefix(c.req.header("cf-connecting-ip") ?? null));
  if (await blocked(env, failKey, LIMITS.failIp)) return c.json(tooMany, 429);
  const now = nowS();
  // Single use by one guarded UPDATE: of two concurrent verifies exactly one gets the row (Review Focus 2). Lookup by hash only.
  const t = await env.DB.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, next")
    .bind(now, await sha256Hex(b.token), now).first<{ email: string; next: string }>();
  if (!t) {
    await hit(env, failKey, LIMITS.failIp);
    return c.json({ error: "link_invalid" }, 400);
  }
  const r = await resolveUser(env, t.email);
  if (!("user" in r)) return c.json({ error: r.error }, r.status);
  const s = await createSession(env, c.req.raw, r.user, "email");
  if (!s.started(await env.DB.batch(s.stmts))) return c.json({ error: "disabled" }, 403); // disabled after the check above
  c.header("Set-Cookie", s.setCookie);
  return c.json({ next: safeNext(t.next, origin(env)) });
});

signin.post("/passkey/options", async (c) => {
  if (!(await parse(c, z.strictObject({})))) return c.json(invalid, 400);
  // Anonymous callers write a challenge row per call: a per-prefix budget (own key, so sign-in emails keep theirs) bounds that.
  if (!(await hit(c.env, limitKey.opts(ipPrefix(c.req.header("cf-connecting-ip") ?? null)), LIMITS.ip))) return c.json(tooMany, 429);
  await c.env.DB.batch(prunes(c.env, nowS()));
  return c.json(await authenticationOptions(c.env));
});

const passkeyBody = z.strictObject({ response: z.unknown(), next: z.string().max(2048).optional() });
const passkeyFailed = { error: "passkey_failed" } as const;

signin.post("/passkey/verify", async (c) => {
  const b = await parse(c, passkeyBody);
  if (!b) return c.json(invalid, 400);
  const env = c.env;
  const failKey = limitKey.fail(ipPrefix(c.req.header("cf-connecting-ip") ?? null));
  if (await blocked(env, failKey, LIMITS.failIp)) return c.json(tooMany, 429);
  let v;
  try {
    v = await verifyAuthentication(env, b.response);
  } catch (err) {
    if (!(err instanceof PasskeyError)) throw err;
    await hit(env, failKey, LIMITS.failIp);
    return c.json(passkeyFailed, 400); // one answer for every cause (R10); nothing logged, library text can quote client data
  }
  if (v.user.status !== "active") return c.json({ error: "disabled" }, 403);
  // Counters only move forward (0 = an authenticator without one). Of two racing assertions at the same counter only one
  // gets the row; the other is a concurrent or replayed assertion and gets no session.
  const moved = await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND (counter < ? OR ? = 0)")
    .bind(v.newCounter, nowS(), v.passkeyId, v.newCounter, v.newCounter).run();
  if (!moved.meta.changes) {
    await hit(env, failKey, LIMITS.failIp);
    return c.json(passkeyFailed, 400);
  }
  const s = await createSession(env, c.req.raw, v.user, "passkey");
  if (!s.started(await env.DB.batch(s.stmts))) return c.json({ error: "disabled" }, 403); // disabled after the check above
  c.header("Set-Cookie", s.setCookie);
  return c.json({ next: safeNext(b.next, origin(env)) });
});
