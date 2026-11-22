import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import { CfError, cfConfig, createDns, getFallbackOrigin, hostnameCount, listDns, setFallbackOrigin } from "../cf/api";
import { AttachError, syncDomain } from "../cf/attach";
import { checkToken, sampleZone } from "../cf/perms";
import type { Env } from "../env";
import { normalizeHost } from "../host";
import { rowToCf, rowToDomain, type UserRow } from "../types";

type E = { Bindings: Env; Variables: { user: UserRow } };
export const settings = new Hono<E>();

const CONTROLS = "cf.controls";
const notConfigured = { error: "cloudflare_not_configured" } as const;

settings.use("*", async (c, next) => {
  if (c.var.user.role !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
});

/** Codes only: a CfError message is `cloudflare_<status>`, never Cloudflare's own text. */
const cfFail = (e: unknown) => {
  if (!(e instanceof CfError)) throw e;
  return e.status === 0
    ? ({ body: { error: "cloudflare_unreachable" }, status: 502 } as const)
    : e.status === 401 || e.status === 403
      ? ({ body: { error: "cloudflare_forbidden" }, status: 409 } as const)
      : ({ body: { error: "cloudflare_error" }, status: 502 } as const);
};
const orNull = <T>(p: Promise<T>) => p.catch(() => null);

settings.get("/cloudflare", async (c) => {
  const cfg = cfConfig(c.env);
  const saas = !!(cfg?.saasZoneId && cfg.cnameTarget);
  const [zone, fb, used, attached, controls] = await Promise.all([
    cfg ? orNull(sampleZone(cfg)) : null,
    saas ? getFallbackOrigin(cfg!).then((o) => (o ? (o.status === "active" ? "active" : "pending") : "missing"), () => null) : null,
    cfg?.saasZoneId ? orNull(hostnameCount(cfg)) : null,
    c.env.DB.prepare("SELECT COUNT(*) n FROM domain_cf WHERE kind = 'account' AND route_id IS NOT NULL").first<{ n: number }>(),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(CONTROLS).first<{ value: string }>(),
  ]);
  const target = c.env.CF_CNAME_TARGET?.trim();
  return c.json({
    configured: !!cfg,
    outsideReady: saas && fb === "active",
    accountName: zone?.accountName ?? null,
    cnameTarget: target ? normalizeHost(target) : null,
    fallbackOrigin: fb,
    hostnames: used === null ? null : { used, limit: 100 },
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
  const cfg = cfConfig(c.env, body.data.token);
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

settings.post("/cloudflare/setup", async (c) => {
  const cfg = cfConfig(c.env);
  if (!cfg) return c.json(notConfigured, 409);
  if (!cfg.saasZoneId || !cfg.cnameTarget) return c.json({ error: "outside_not_configured" }, 409);
  const target = cfg.cnameTarget;
  try {
    const records = (await listDns(cfg, cfg.saasZoneId, target)).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    // shortcut: "ours" is recognised by the comment linkwarren writes; no table records this id. Fails closed on anything else.
    if (records.some((r) => r.comment !== "linkwarren" || !r.proxied)) return c.json({ error: "target_in_use" }, 409);
    if (!records.length) await createDns(cfg, cfg.saasZoneId, target);
    await setFallbackOrigin(cfg);
    const fb = await getFallbackOrigin(cfg).catch(() => null);
    await auditStmt(c.env, { actorId: c.var.user.id, action: "cloudflare.setup", targetType: "settings", targetId: "cloudflare", detail: { target } }).run();
    return c.json({ target, fallbackOrigin: fb?.status === "active" ? "active" : "pending" });
  } catch (e) {
    const f = cfFail(e);
    return c.json(f.body, f.status);
  }
});

settings.post("/cloudflare/resync", async (c) => {
  const cfg = cfConfig(c.env);
  if (!cfg) return c.json(notConfigured, 409);
  const rows = (await c.env.DB.prepare(
    `SELECT d.id FROM domains d JOIN domain_cf c ON c.domain_id = d.id
     WHERE c.kind = 'outside' OR (c.kind = 'account' AND c.route_id IS NOT NULL) ORDER BY d.host`,
  ).all<{ id: string }>()).results;
  let ok = 0;
  const failed: { host: string; error: string }[] = [];
  // Sequential on purpose: keeps Cloudflare's rate limit and the subrequest budget predictable.
  for (const { id } of rows) {
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
      failed.push({ host: dom.host, error: e instanceof AttachError ? e.code : e instanceof CfError ? e.message : "internal_error" });
    }
  }
  await auditStmt(c.env, { actorId: c.var.user.id, action: "cloudflare.resync", targetType: "settings", targetId: "cloudflare", detail: { ok, failed: failed.length } }).run();
  return c.json({ ok, failed });
});
