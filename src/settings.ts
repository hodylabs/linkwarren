import { z } from "zod";
import { auditStmt } from "./audit";
import type { Env } from "./env";
import { actorCan } from "./roles";

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
  mainDomainId: { key: "instance.mainDomainId", schema: z.string().max(64) },
  logoVersion: { key: "instance.logoVersion", schema: z.number().int() },
  linkRedirectCode: { key: "links.defaultRedirectCode", schema: z.union([z.literal(301), z.literal(302)]) },
  linkPassQuery: { key: "links.defaultPassQuery", schema: z.boolean() },
  setupCompletedAt: { key: "setup.completedAt", schema: z.number().int() },
};
const NAMES = Object.keys(FIELDS) as (keyof InstanceSettings)[];
const KEYS = NAMES.map((n) => FIELDS[n].key);

/** The one read behind getSettings, for callers that fold it into their own batch (parse the rows with parseSettings). */
export const settingsQ = (env: Env) => env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => "?").join(",")})`).bind(...KEYS);

export async function getSettings(env: Env): Promise<InstanceSettings> {
  return parseSettings((await settingsQ(env).all<{ key: string; value: string }>()).results);
}

export function parseSettings(rows: { key: string; value: string }[]): InstanceSettings {
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

/** Per key one upsert (null deletes) plus one settings.update audit { key, value }, guarded by the row it records. Batch with the caller's other writes.
 * `when`: an extra SQL condition every upsert and audit also needs (e.g. the chosen main domain is still valid). */
export function settingStmts(env: Env, actorId: string, patch: Partial<InstanceSettings>, when?: { sql: string; binds: unknown[] }): D1PreparedStatement[] {
  const now = Math.floor(Date.now() / 1000);
  // S8 R5: every write re-checks the settings permission in its own statement, so one lost mid-request writes nothing.
  const may = actorCan(actorId, "settings");
  const w = ` AND ${may.sql}${when ? ` AND ${when.sql}` : ""}`;
  const wb = [...may.binds, ...(when?.binds ?? [])];
  return NAMES.filter((n) => patch[n] !== undefined).flatMap((n) => {
    const key = FIELDS[n].key;
    const value = patch[n] ?? null;
    const audit = (guard: { sql: string; binds: unknown[] }) =>
      auditStmt(env, { actorId, action: "settings.update", targetType: "settings", targetId: key, detail: { key, value } }, { sql: guard.sql + w, binds: [...guard.binds, ...wb] });
    // The audit runs first, on the row this DELETE is about to remove: a row someone else already removed is not audited twice.
    if (value === null) return [audit({ sql: "EXISTS (SELECT 1 FROM settings WHERE key = ?)", binds: [key] }), env.DB.prepare(`DELETE FROM settings WHERE key = ?${w}`).bind(key, ...wb)];
    const json = JSON.stringify(value);
    return [
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?,?,?,? WHERE 1${w} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).bind(key, json, now, actorId, ...wb),
      audit({ sql: "EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)", binds: [key, json] }),
    ];
  });
}
