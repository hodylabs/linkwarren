import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { CfError, cfConfig, cfConfigFor, cnameTarget, createDns, getFallbackOrigin, hostnameCount, listDns, setFallbackOrigin } from "../cf/api";
import { syncDomain, syncErrorCode } from "../cf/attach";
import { checkToken, sampleZone } from "../cf/perms";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { deleteSecretStmts, putSecretStmts, secretsReady, secretStatus, type SecretName } from "../secrets";
import { rowToCf, rowToDomain, type UserRow } from "../types";
import type { Grant } from "../principal";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const settings = new Hono<E>();

const CONTROLS = "cf.controls";
const notConfigured = { error: "cloudflare_not_configured" } as const;

settings.use("*", async (c, next) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
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
settings.post("/cloudflare/check", async (c) => {
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    ).bind(CONTROLS, value, Math.floor(Date.now() / 1000), user.id),
    auditStmt(c.env, { actorId: user.id, action: "settings.update", targetType: "settings", targetId: CONTROLS, detail: { key: CONTROLS, value } },
      { sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [CONTROLS, value] }),
  ]);
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
  const upsert = (key: string, value: string) => c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  ).bind(key, value, Math.floor(Date.now() / 1000), userId);
  const setting = async (key: string) => (await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  // The upsert and the audit share one batch; the audit is guarded by the row it records.
  const record = (recordId: string | null, error?: string) => c.env.DB.batch([
    ...(recordId ? [upsert(TARGET_RECORD, recordId)] : []),
    auditStmt(c.env, { actorId: userId, action: "cloudflare.setup", targetType: "settings", targetId: "cloudflare", detail: { target, ...(recordId ? { recordId } : {}), ...(error ? { error } : {}) } },
      recordId ? { sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [TARGET_RECORD, recordId] } : undefined),
  ]);
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
    if (!records.length) {
      const n = crypto.randomUUID();
      await upsert(TARGET_INTENT, n).run();
      created = (await createDns(cfg, zoneId, target, mark(n))).id;
    }
    // shortcut: Cloudflare has no conditional write for the fallback origin, so one set in the dashboard between the read above
    // and this PUT is replaced. The window is one round trip; use a conditional write if Cloudflare ever offers one.
    if (!fb) await setFallbackOrigin(cfg);
    const now = fb ?? (await getFallbackOrigin(cfg).catch(() => null));
    await record(created ?? unrecorded[0]?.id ?? null);
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
const secretBody = z.strictObject({ value: z.string() });
settings.get("/secrets", async (c) => c.json(await secretStatus(c.env)));

settings.put("/secrets/:name", async (c) => {
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
  await c.env.DB.batch(await putSecretStmts(c.env, c.var.user.id, name, value));
  return c.json(await secretStatus(c.env));
});

settings.delete("/secrets/:name", async (c) => {
  const name = secretName(c.req.param("name"));
  if (!name) return c.json({ error: "not_found" }, 404);
  await c.env.DB.batch(deleteSecretStmts(c.env, c.var.user.id, name));
  return c.json(await secretStatus(c.env));
});
