import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { auditStmt } from "../audit";
import { authMode } from "../auth";
import { AE_DAYS } from "../analytics";
import { AUDIT_KEEP_DAYS } from "../cron";
import { checkLogo, LOGO_HEADERS, LOGO_KEY, LOGO_MAX_BYTES, LOGO_TYPES, type LogoType } from "../logo";
import { getSettings, settingStmts, type InstanceSettings } from "../settings";
import { updateInfo } from "../update";
import { emailConfigured, sendEmail, UNSAFE } from "../email";
import { LIMITS, hit, hitAll, limitKey } from "../limits";
import { CfError, cfConfig, cfConfigFor, cnameTarget, createDns, getFallbackOrigin, hostnameCount, listDns, setFallbackOrigin } from "../cf/api";
import { syncDomain, syncErrorCode } from "../cf/attach";
import { checkToken, sampleZone } from "../cf/perms";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { dashUrl } from "../dash";
import { deleteSecretStmts, putSecretStmts, secretsReady, secretStatus, type SecretName } from "../secrets";
import { rowToCf, rowToDomain, type UserRow } from "../types";
import type { Grant } from "../principal";
import { actorCan, can, requirePerm, type Guard } from "../roles";
import { holds } from "./domains";
import { ACTOR_OK } from "./users";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const settings = new Hono<E>();

const CONTROLS = "cf.controls";
const notConfigured = { error: "cloudflare_not_configured" } as const;
const forbidden = { error: "forbidden" } as const;

const ownerOnly = async (c: { var: { user: UserRow }; json: (b: unknown, s: 403) => Response }, next: () => Promise<void>) => {
  if (c.var.user.role !== "owner") return c.json(forbidden, 403);
  await next();
};
/** The SQL re-checks of this router's two gates, for the write's own batch. */
const mayEdit = (u: UserRow): Guard => actorCan(u.id, "settings");
const isOwner = (u: UserRow): Guard => ({ sql: ACTOR_OK, binds: [u.id] });
/** One settings upsert, written only while `g` holds. */
const upsertIf = (env: Env, key: string, value: string, actorId: string, g: Guard) => env.DB.prepare(
  `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE ${g.sql} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
).bind(key, value, Math.floor(Date.now() / 1000), actorId, ...g.binds);
// S8 R5: `settings` opens this router; secret writes and the token check add ownerOnly on their route. Domain managers
// also read the Cloudflare page (read only, no secret), so they see whether the Cloudflare controls are on.
const needSettings = requirePerm("settings");
settings.use("*", (c, next) =>
  c.req.method === "GET" && c.req.path === "/api/settings/cloudflare" && can(c.var.user, "domains.manage") ? next() : needSettings(c, next));

/** Any signed-in user: what the rail, document title and link form need. */
export const instance = new Hono<E>();
instance.get("/", async (c) => {
  const s = await getSettings(c.env);
  return c.json({
    name: s.name, logoVersion: s.logoVersion, configured: s.setupCompletedAt !== null, dashboardHost: normalizeHost(c.env.DASHBOARD_HOST), dashboardUrl: dashUrl(c.env, ""),
    mainDomainId: s.mainDomainId, linkDefaults: { redirectCode: s.linkRedirectCode, passQuery: s.linkPassQuery },
    // From the same settings read: no extra query. Only those who can act on it (owners and `settings`) see it.
    update: can(c.var.user, "settings") ? updateInfo(s) : null,
  });
});
instance.get("/logo", async (c) => {
  const r = await c.env.CACHE.getWithMetadata<{ type?: string; v?: number }>(LOGO_KEY, "arrayBuffer");
  const type = r.metadata?.type;
  // logoVersion null = removed: serve 404 even if a failed KV delete left bytes behind. A D1 read, so no extra KV op
  // (KV deletes are capped at 1000/day on Free) and nothing to retry.
  if (!r.value || !LOGO_TYPES.includes(type as LogoType) || (await getSettings(c.env)).logoVersion === null) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "no_logo" }, 404);
  }
  // Cacheable only under the version these bytes carry: a stale KV read (eventual consistency) or bytes the KV write
  // never reached are never cached under the new ?v= URL.
  const current = r.metadata?.v !== undefined && c.req.query("v") === String(r.metadata.v);
  return new Response(r.value, { headers: { "Content-Type": type!, ...LOGO_HEADERS, ...(current ? {} : { "Cache-Control": "no-store" }) } });
});

const MAIN_OK = "EXISTS (SELECT 1 FROM domains WHERE id = ? AND type = 'main' AND status != 'disabled')";
const validMain = async (env: Env, id: string | null) => !!id && !!(await env.DB.prepare(`SELECT ${MAIN_OK} ok`).bind(id).first<{ ok: number }>())?.ok;

async function settingsBody(env: Env) {
  const [s, secrets] = await Promise.all([getSettings(env), secretStatus(env)]);
  // Same rule as emailConfigured(), from the key secretStatus already resolved (one read and decrypt, not two).
  const emailOk = !!env.EMAIL_FROM?.trim() && secrets.resend !== "missing";
  const mode = authMode(env);
  return {
    name: s.name, mainDomainId: s.mainDomainId, dashboardHost: normalizeHost(env.DASHBOARD_HOST), dashboardUrl: dashUrl(env, ""), authMode: mode,
    ...(mode === "access" ? { teamDomain: env.ACCESS_TEAM_DOMAIN ?? "" } : {}),
    emailFrom: env.EMAIL_FROM?.trim() || null, emailConfigured: emailOk, secrets,
    linkRedirectCode: s.linkRedirectCode, linkPassQuery: s.linkPassQuery, updatesCheck: s.updatesCheck, retention: { auditDays: AUDIT_KEEP_DAYS, clickDetailDays: AE_DAYS },
  };
}
settings.get("/", async (c) => c.json(await settingsBody(c.env)));

const NAME_MAX = 60;
const settingsPatch = z.strictObject({
  name: z.string().max(400).optional(),
  mainDomainId: z.string().min(1).max(64).optional(),
  linkRedirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
  linkPassQuery: z.boolean().optional(),
  updatesCheck: z.boolean().optional(),
});
settings.patch("/", async (c) => {
  const body = settingsPatch.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const { name: rawName, ...rest } = body.data;
  const patch: Partial<InstanceSettings> = { ...rest };
  if (!Object.values(body.data).some((v) => v !== undefined)) return c.json({ error: "no_changes" }, 400);
  if (rawName !== undefined) {
    // Control, bidi and zero-width characters are stripped, never stored: the rail, the title and email all see the same name.
    const name = rawName.replace(UNSAFE, "").trim();
    const len = [...name].length;
    if (len < 1 || len > NAME_MAX) return c.json({ error: "bad_name" }, 400);
    patch.name = name;
  }
  const main = rest.mainDomainId;
  if (main !== undefined && !(await validMain(c.env, main))) return c.json({ error: "bad_main_domain" }, 400);
  // Re-checked in SQL: a domain disabled or retyped after the read above leaves every key of this patch unwritten.
  const res = await c.env.DB.batch(settingStmts(c.env, c.var.user.id, patch, main === undefined ? undefined : { sql: MAIN_OK, binds: [main] }));
  // An upsert always changes a row, so none written means a guard refused it: the permission, else the main domain.
  if (!res[0]!.meta.changes) {
    if (!(await holds(c.env, mayEdit(c.var.user)))) return c.json(forbidden, 403);
    return c.json({ error: "bad_main_domain" }, 400);
  }
  return c.json(await settingsBody(c.env));
});

// Base64 of 64 KiB plus the JSON around it; a larger body is refused before it is parsed.
const LOGO_BODY_MAX = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 256;
// `type` is the browser's label, accepted but ignored: the bytes decide (checkLogo).
const logoBody = z.strictObject({ type: z.string().max(100).optional(), data: z.string().min(1).max(LOGO_BODY_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const logoAudit = (env: Env, actorId: string, action: string, detail: object, guard: { sql: string; binds: unknown[] }) =>
  auditStmt(env, { actorId, action, targetType: "settings", targetId: "instance.logo", detail }, guard);
settings.put("/logo", bodyLimit({ maxSize: LOGO_BODY_MAX + 256, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
  const body = logoBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(body.data.data), (ch) => ch.charCodeAt(0));
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const check = checkLogo(bytes);
  if (!check.ok) return c.json({ error: check.reason }, 400);
  if (!(await hit(c.env, limitKey.logoDay, LIMITS.logoDay))) return c.json({ error: "too_many" }, 429);
  const type = check.type;
  const v = Date.now();
  const res = await c.env.DB.batch([
    ...settingStmts(c.env, c.var.user.id, { logoVersion: v }),
    logoAudit(c.env, c.var.user.id, "logo.update", { type, bytes: bytes.length },
      { sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: ["instance.logoVersion", JSON.stringify(v)] }),
  ]);
  if (!res[0]!.meta.changes) return c.json(forbidden, 403);
  // The bytes follow the guarded version, so a refused request leaves the served logo as it was. One KV write per upload (R7),
  // under a fixed name: no user-provided filename is ever kept. Should it fail, the old bytes stay served uncached (no-store).
  await c.env.CACHE.put(LOGO_KEY, bytes, { metadata: { type, v } });
  return c.json({ logoVersion: v });
});
settings.delete("/logo", async (c) => {
  // Nothing to remove: no KV delete, no audit.
  if ((await getSettings(c.env)).logoVersion === null) return c.json({ logoVersion: null });
  if (!(await hit(c.env, limitKey.logoDay, LIMITS.logoDay))) return c.json({ error: "too_many" }, 429);
  // The audit first, on the version this batch's guarded DELETE then removes: only a request that removes it records it.
  const may = mayEdit(c.var.user);
  const res = await c.env.DB.batch([
    logoAudit(c.env, c.var.user.id, "logo.remove", {}, { sql: `EXISTS (SELECT 1 FROM settings WHERE key = ?) AND ${may.sql}`, binds: ["instance.logoVersion", ...may.binds] }),
    ...settingStmts(c.env, c.var.user.id, { logoVersion: null }),
  ]);
  // Nothing deleted: removed concurrently (fine), or the permission is gone (the bytes stay).
  if (!res[0]!.meta.changes && !(await holds(c.env, may))) return c.json(forbidden, 403);
  // Only after the guarded change: a refused request never removes the served logo.
  await c.env.CACHE.delete(LOGO_KEY);
  return c.json({ logoVersion: null });
});

/** Owner only: first-run progress (R10). The server stores only setup.completedAt. */
export const setup = new Hono<E>();
setup.use("*", ownerOnly);
async function setupSteps(env: Env) {
  const [s, cf, email] = await Promise.all([getSettings(env), cfConfigFor(env), emailConfigured(env)]);
  const steps = { name: s.name !== null, signIn: true as const, cloudflare: cf !== null, mainDomain: await validMain(env, s.mainDomainId), email };
  return { configured: s.setupCompletedAt !== null, steps };
}
setup.get("/", async (c) => c.json(await setupSteps(c.env)));
setup.post("/complete", async (c) => {
  const { steps } = await setupSteps(c.env);
  const missing = (["name", "mainDomain"] as const).filter((k) => !steps[k]);
  if (missing.length) return c.json({ error: "incomplete", missing }, 400);
  const now = Math.floor(Date.now() / 1000);
  // Still an active owner (R5), and not completed yet.
  const own = isOwner(c.var.user);
  const once = { sql: `NOT EXISTS (SELECT 1 FROM settings WHERE key = 'setup.completedAt') AND ${own.sql}`, binds: own.binds };
  // The audit runs first under the same guard as the insert, so exactly one of two racing calls writes both rows.
  const res = await c.env.DB.batch([
    auditStmt(c.env, { actorId: c.var.user.id, action: "setup.complete", targetType: "settings", targetId: "setup.completedAt", detail: {} }, once),
    c.env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) SELECT 'setup.completedAt', ?, ?, ? WHERE ${once.sql}`).bind(JSON.stringify(now), now, c.var.user.id, ...once.binds),
  ]);
  if (res[1]!.meta.changes === 0) return (await holds(c.env, own)) ? c.json({ error: "already_configured" }, 409) : c.json(forbidden, 403);
  return c.json({ configured: true });
});

/** Codes only (the shared mapping), never Cloudflare's own text. */
const cfFail = (e: unknown) => {
  if (!(e instanceof CfError)) throw e;
  const error = syncErrorCode(e);
  return { body: { error }, status: error === "cloudflare_unreachable" || error === "cloudflare_error" ? 502 : 409 } as const;
};
const orNull = <T>(p: Promise<T>) => p.catch(() => null);

settings.get("/cloudflare", async (c) => {
  const cfg = await cfConfigFor(c.env);
  const saas = !!(cfg?.saasZoneId && cfg.cnameTarget);
  const [zone, fb, used, attached, controls] = await Promise.all([
    cfg ? orNull(sampleZone(cfg)) : null,
    // in_use: the zone's fallback origin is not our target (setup refuses to replace it), so outside domains are not ready.
    saas ? getFallbackOrigin(cfg!).then((o) => (!o ? "missing" : normalizeHost(o.origin) !== cfg!.cnameTarget ? "in_use" : o.status === "active" ? "active" : "pending"), () => null) : null,
    cfg?.saasZoneId ? orNull(hostnameCount(cfg)) : null,
    c.env.DB.prepare("SELECT COUNT(*) n FROM domain_cf WHERE kind = 'account' AND route_id IS NOT NULL").first<{ n: number }>(),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(CONTROLS).first<{ value: string }>(),
  ]);
  const target = cnameTarget(c.env);
  return c.json({
    configured: !!cfg,
    outsideReady: saas && fb === "active",
    accountName: zone?.accountName ?? null,
    cnameTarget: target,
    fallbackOrigin: fb,
    hostnames: used === null || !Number.isFinite(used) ? null : { used, limit: 100 },
    attachedCount: attached?.n ?? 0,
    controlsEnabled: controls?.value === "1",
  });
});

const checkBody = z.strictObject({ token: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional() });
settings.post("/cloudflare/check", ownerOnly, async (c) => {
  const text = await c.req.text();
  let raw: unknown = {};
  try {
    if (text) raw = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const body = checkBody.safeParse(raw);
  // Never echo the zod issues: they would carry the candidate token.
  if (!body.success) return c.json({ error: body.error.issues.some((i) => i.path[0] === "token") ? "invalid_token_format" : "invalid_body" }, 400);
  // A candidate token (first-run wizard) is only held in this request: nothing is stored.
  const cfg = body.data.token ? cfConfig(c.env, body.data.token) : await cfConfigFor(c.env);
  if (!cfg) return c.json(notConfigured, 409);
  try {
    return c.json(await checkToken(cfg));
  } catch (e) {
    const f = cfFail(e);
    return c.json(f.body, f.status);
  }
});

const patchBody = z.strictObject({ controlsEnabled: z.boolean() });
settings.patch("/cloudflare", async (c) => {
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const value = body.data.controlsEnabled ? "1" : "0";
  const user = c.var.user;
  const [set] = await c.env.DB.batch([
    upsertIf(c.env, CONTROLS, value, user.id, mayEdit(user)),
    auditStmt(c.env, { actorId: user.id, action: "settings.update", targetType: "settings", targetId: CONTROLS, detail: { key: CONTROLS, value } },
      { sql: "changes() > 0 AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [CONTROLS, value] }),
  ]);
  if (!set!.meta.changes) return c.json(forbidden, 403);
  return c.json({ controlsEnabled: body.data.controlsEnabled });
});

const TARGET_RECORD = "cf.target_record_id";
// Stored before the record is created and written into its comment, so a record whose id never reached D1 is still provably ours.
const TARGET_INTENT = "cf.target_record_intent";

settings.post("/cloudflare/setup", async (c) => {
  const cfg = await cfConfigFor(c.env);
  if (!cfg) return c.json(notConfigured, 409);
  if (!cfg.saasZoneId || !cfg.cnameTarget) return c.json({ error: "outside_not_configured" }, 409);
  const { saasZoneId: zoneId, cnameTarget: target } = cfg;
  const userId = c.var.user.id;
  const setting = async (key: string) => (await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  // Both statements re-check `settings`; the audit is also guarded by the row it records. A refusal leaves a created
  // record recognisable by its intent mark, so a retry by someone allowed still records it.
  const g = mayEdit(c.var.user);
  const record = async (recordId: string | null, error?: string) => {
    const res = await c.env.DB.batch([
      ...(recordId ? [upsertIf(c.env, TARGET_RECORD, recordId, userId, g)] : []),
      auditStmt(c.env, { actorId: userId, action: "cloudflare.setup", targetType: "settings", targetId: "cloudflare", detail: { target, ...(recordId ? { recordId } : {}), ...(error ? { error } : {}) } },
        recordId ? { sql: `${g.sql} AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`, binds: [...g.binds, TARGET_RECORD, recordId] } : g),
    ]);
    return res.at(-1)!.meta.changes > 0;
  };
  let created: string | null = null;
  try {
    // Every refusal comes before the first write.
    const fb = await getFallbackOrigin(cfg);
    // The fallback origin is zone-wide: replacing someone else's would repoint every custom hostname in the zone.
    if (fb && normalizeHost(fb.origin) !== target) return c.json({ error: "fallback_in_use" }, 409);
    const [ours, intent] = await Promise.all([setting(TARGET_RECORD), setting(TARGET_INTENT)]);
    const mark = (n: string) => `linkwarren setup ${n}`;
    const records = (await listDns(cfg, zoneId, target)).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    // Ours: the stored id, or the comment of a create whose id was lost when its D1 write failed. Anything else is foreign.
    const unrecorded = records.filter((r) => r.id !== ours);
    if (unrecorded.some((r) => !intent || r.comment !== mark(intent))) return c.json({ error: "target_in_use" }, 409);
    // The first write re-checks `settings` (the intent row in SQL, else one read): lost, nothing reaches Cloudflare.
    if (!records.length) {
      const n = crypto.randomUUID();
      if (!(await upsertIf(c.env, TARGET_INTENT, n, userId, g).run()).meta.changes) return c.json(forbidden, 403);
      created = (await createDns(cfg, zoneId, target, mark(n))).id;
    } else if (!fb && !(await holds(c.env, g))) return c.json(forbidden, 403);
    // shortcut: Cloudflare has no conditional write for the fallback origin, so one set in the dashboard between the read above
    // and this PUT is replaced. The window is one round trip; use a conditional write if Cloudflare ever offers one.
    if (!fb) await setFallbackOrigin(cfg);
    const now = fb ?? (await getFallbackOrigin(cfg).catch(() => null));
    if (!(await record(created ?? unrecorded[0]?.id ?? null))) return c.json(forbidden, 403);
    return c.json({ target, fallbackOrigin: now?.status === "active" ? "active" : "pending" });
  } catch (e) {
    const f = cfFail(e);
    // A record we created must stay known even when a later step failed, or a retry would call it foreign.
    if (created) await record(created, f.body.error);
    return c.json(f.body, f.status);
  }
});

// Workers Free allows 50 subrequests per call. An outside sync takes about 10, an account one 3i+4 for a host i labels below its zone.
// shortcut: deep account hosts can still pass 50; the cap shows as cloudflare_unreachable and the loop resumes from that domain.
const BATCH = 3;
const resyncBody = z.strictObject({ after: z.string().min(1).max(64).optional() });
settings.post("/cloudflare/resync", async (c) => {
  const cfg = await cfConfigFor(c.env);
  if (!cfg) return c.json(notConfigured, 409);
  const text = await c.req.text();
  let raw: unknown = {};
  try {
    if (text) raw = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const body = resyncBody.safeParse(raw);
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  // `after` is the `next` of the previous call: the first domain id not yet done (inclusive).
  const rows = (await c.env.DB.prepare(
    `SELECT d.id FROM domains d JOIN domain_cf c ON c.domain_id = d.id
     WHERE (c.kind = 'outside' OR (c.kind = 'account' AND c.route_id IS NOT NULL)) AND d.status IN ('pending', 'active') AND d.id >= ? ORDER BY d.id LIMIT ?`,
  ).bind(body.data.after ?? "", BATCH + 1).all<{ id: string }>()).results;
  let ok = 0;
  let next = rows[BATCH]?.id ?? null;
  const failed: { host: string; error: string }[] = [];
  for (const { id } of rows.slice(0, BATCH)) {
    const [d, cf] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first(),
      c.env.DB.prepare("SELECT * FROM domain_cf WHERE domain_id = ?").bind(id).first(),
    ]);
    if (!d || !cf) continue; // deleted meanwhile
    const dom = rowToDomain(d);
    try {
      // Repair mode: re-creates only our own pieces and can never perform a takeover.
      await syncDomain(c.env, cfg, dom, rowToCf(cf), { attach: false });
      ok++;
    } catch (e) {
      const error = syncErrorCode(e);
      failed.push({ host: dom.host, error });
      // Unreachable includes the subrequest limit: later domains would fail the same way, so retry from here.
      if (error === "cloudflare_unreachable") {
        next = id;
        break;
      }
    }
  }
  await auditStmt(c.env, { actorId: c.var.user.id, action: "cloudflare.resync", targetType: "settings", targetId: "cloudflare", detail: { ok, failed: failed.length, next } }).run();
  return c.json({ ok, failed, next });
});

// Write-only (R2): every response is the status, never a value. The Worker secret always wins, so a paste over it is refused.
const secretName = (p: string): SecretName | null => (p === "cf" ? "CF_API_TOKEN" : p === "resend" ? "RESEND_API_KEY" : null);
const secretBody = z.strictObject({ value: z.string().max(512) });
settings.get("/secrets", async (c) => c.json(await secretStatus(c.env)));

settings.put("/secrets/:name", ownerOnly, async (c) => {
  const name = secretName(c.req.param("name"));
  if (!name) return c.json({ error: "not_found" }, 404);
  const body = secretBody.safeParse(await c.req.json().catch(() => null));
  // Never echo the zod issues: they could carry the value.
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  if (c.env[name]?.trim()) return c.json({ error: "set_by_secret" }, 409);
  if (!secretsReady(c.env)) return c.json({ error: "secrets_key_missing" }, 409);
  const value = body.data.value.trim();
  if (name === "RESEND_API_KEY" && !/^re_[A-Za-z0-9_]{10,200}$/.test(value)) return c.json({ error: "bad_key" }, 400);
  if (name === "CF_API_TOKEN") {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) return c.json({ error: "token_invalid" }, 400);
    const cfg = cfConfig(c.env, value);
    if (!cfg) return c.json(notConfigured, 409);
    try {
      if ((await checkToken(cfg)).token !== "active") return c.json({ error: "token_invalid" }, 400);
    } catch (e) {
      const f = cfFail(e);
      return c.json(f.body, f.status);
    }
  }
  // Re-checked in SQL: an owner demoted meanwhile stores nothing.
  const [set] = await c.env.DB.batch(await putSecretStmts(c.env, c.var.user.id, name, value, isOwner(c.var.user)));
  if (!set!.meta.changes) return c.json(forbidden, 403);
  return c.json(await secretStatus(c.env));
});

settings.delete("/secrets/:name", ownerOnly, async (c) => {
  const name = secretName(c.req.param("name"));
  if (!name) return c.json({ error: "not_found" }, 404);
  const [del] = await c.env.DB.batch(deleteSecretStmts(c.env, c.var.user.id, name, isOwner(c.var.user)));
  if (!del!.meta.changes && !(await holds(c.env, isOwner(c.var.user)))) return c.json(forbidden, 403);
  return c.json(await secretStatus(c.env));
});

// Mails the caller's own address only. Order: config, the one-a-minute test limit, the instance mail cap, then the send.
settings.post("/email/test", async (c) => {
  if (!(await emailConfigured(c.env))) return c.json({ error: "email_not_configured" }, 409);
  const hit = await hitAll(c.env, [{ key: limitKey.mailTest, limit: LIMITS.mailTest }, { key: limitKey.inst, limit: LIMITS.instance }]);
  if (!hit.ok) return c.json({ error: hit.key === limitKey.mailTest ? "too_soon" : "too_many" }, 429);
  const user = c.var.user;
  const text = "This is a test email from linkwarren. If you can read it, email is working.";
  const r = await sendEmail(c.env, { to: user.email, subject: "linkwarren test email", text: `${text}\n`, html: `<p>${text}</p>\n` });
  if (!r.ok) return c.json({ error: "email_failed", reason: r.reason }, 502);
  await auditStmt(c.env, { actorId: user.id, action: "email.test", targetType: "settings", targetId: "email", detail: {} }).run();
  return c.json({ ok: true });
});
