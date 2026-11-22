import { Hono, type Context } from "hono";
import { z } from "zod";
import { resolveUser } from "../auth";
import { emailConfigured, sendEmail, signInEmail } from "../email";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { LIMITS, blocked, hit, limitKey } from "../limits";
import { createSession, ipPrefix, newSecret, safeNext, sha256Hex } from "../session";

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

/** The parsed body, or null for oversized, non-JSON or invalid input (zod issues are never echoed). */
async function parse<T extends z.ZodType>(c: Context<E>, schema: T): Promise<z.infer<T> | null> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return null;
  try {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return null;
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const invalid = { error: "invalid_body" } as const;
const tooMany = { error: "too_many_attempts" } as const;

// Trim first, then validate, so the limiter key and the lookup both see the canonical address (Task 3 M3).
const emailBody = z.strictObject({ email: z.string().trim().pipe(z.email().max(254)), next: z.string().max(2048).optional() });

signin.post("/email", async (c) => {
  const b = await parse(c, emailBody);
  if (!b) return c.json(invalid, 400);
  const env = c.env;
  if (!emailConfigured(env)) return c.json({ error: "email_not_configured" }, 503);
  const prefix = ipPrefix(c.req.header("cf-connecting-ip") ?? null);
  // Both limiters count before any lookup, so unknown addresses use up their budget too (R5).
  const [byAddr, byIp] = await Promise.all([hit(env, await limitKey.addr(b.email), LIMITS.address), hit(env, limitKey.ip(prefix), LIMITS.ip)]);
  if (!byAddr || !byIp) return c.json(tooMany, 429);

  const now = nowS();
  // R6 opportunistic prune, one bounded DELETE per table (D1 has no DELETE ... LIMIT). Over-90-day sessions already have expires_at <= now.
  const prune = (t: string, col: string, before: number) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${col} <= ? LIMIT 100)`).bind(before);
  // One lookup for every address: same queries whether or not a mail goes out (R5).
  const [, , , , who] = await env.DB.batch([
    prune("login_tokens", "expires_at", now),
    prune("auth_challenges", "expires_at", now),
    prune("auth_limits", "window_start", now - 3600),
    prune("sessions", "expires_at", now),
    env.DB.prepare("SELECT (SELECT status FROM users WHERE email = ?) status, EXISTS (SELECT 1 FROM users) any_user").bind(b.email),
  ]);
  const row = who!.results[0] as { status: string | null; any_user: number };
  // R11: active or invited users, or the owner email while nobody exists yet. Disabled people get the same 202 and no mail.
  const canReceive = row.status === "active" || row.status === "invited" ||
    (!row.any_user && b.email.toLowerCase() === (env.OWNER_EMAIL ?? "").trim().toLowerCase());

  if (canReceive) {
    // R14: the instance cap answers the same 202, so it never tells which addresses can sign in.
    if (!(await hit(env, limitKey.inst, LIMITS.instance))) {
      console.warn("email_cap");
    } else {
      const secret = newSecret();
      await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha256Hex(secret), b.email, safeNext(b.next, origin(env)), now, now + TOKEN_TTL).run();
      // R4: the token rides in the fragment. R5: sent after the response, so timing does not depend on the mail.
      const host = normalizeHost(env.DASHBOARD_HOST);
      c.executionCtx.waitUntil(sendEmail(env, { to: b.email, ...signInEmail({ host, url: `${origin(env)}/sign-in#token=${secret}` }) }));
    }
  }
  return c.json({ ok: true }, 202);
});

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
  await env.DB.batch(s.stmts);
  c.header("Set-Cookie", s.setCookie);
  return c.json({ next: safeNext(t.next, origin(env)) });
});
