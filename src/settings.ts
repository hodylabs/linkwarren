import { z } from "zod";
import { auditStmt } from "./audit";
import type { Env } from "./env";

export type InstanceSettings = {
  name: string | null;
  mainDomainId: string | null;
  logoVersion: number | null;
  linkRedirectCode: 301 | 302;
  linkPassQuery: boolean;
  setupCompletedAt: number | null;
};

const DEFAULTS: InstanceSettings = { name: null, mainDomainId: null, logoVersion: null, linkRedirectCode: 302, linkPassQuery: true, setupCompletedAt: null };

// Values are JSON-encoded. Only these keys are ever read here (never secret.*, see src/secrets.ts).
const FIELDS: { [K in keyof InstanceSettings]: { key: string; schema: z.ZodType } } = {
  name: { key: "instance.name", schema: z.string().trim().min(1).refine((v) => [...v].length <= 80) },
  mainDomainId: { key: "instance.mainDomainId", schema: z.string() },
  logoVersion: { key: "instance.logoVersion", schema: z.number().int() },
  linkRedirectCode: { key: "links.defaultRedirectCode", schema: z.union([z.literal(301), z.literal(302)]) },
  linkPassQuery: { key: "links.defaultPassQuery", schema: z.boolean() },
  setupCompletedAt: { key: "setup.completedAt", schema: z.number().int() },
};
const NAMES = Object.keys(FIELDS) as (keyof InstanceSettings)[];
const KEYS = NAMES.map((n) => FIELDS[n].key);

export async function getSettings(env: Env): Promise<InstanceSettings> {
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => "?").join(",")})`).bind(...KEYS).all<{ key: string; value: string }>()).results;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const n of NAMES) {
    const raw = byKey.get(FIELDS[n].key);
    if (raw === undefined) continue;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    const r = FIELDS[n].schema.safeParse(v);
    if (r.success) out[n] = r.data;
  }
  return out as InstanceSettings;
}

/** Per key one upsert (null deletes) plus one settings.update audit { key, value }, guarded by the row it records. Batch with the caller's other writes. */
export function settingStmts(env: Env, actorId: string, patch: Partial<InstanceSettings>): D1PreparedStatement[] {
  const now = Math.floor(Date.now() / 1000);
  return NAMES.filter((n) => patch[n] !== undefined).flatMap((n) => {
    const key = FIELDS[n].key;
    const value = patch[n] ?? null;
    const audit = (guard: { sql: string; binds: unknown[] }) =>
      auditStmt(env, { actorId, action: "settings.update", targetType: "settings", targetId: key, detail: { key, value } }, guard);
    if (value === null) return [env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key), audit({ sql: "NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)", binds: [key] })];
    const json = JSON.stringify(value);
    return [
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      ).bind(key, json, now, actorId),
      audit({ sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [key, json] }),
    ];
  });
}
