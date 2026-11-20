import type { Env } from "./env";

export type AuditEntry = {
  actorId: string; via?: string | null; action: string; targetType: string; targetId: string; detail?: unknown;
};

/** Append-only audit row, meant to be batched with the write it records. `onlyIf` makes the row conditional (e.g. only when the guarded write won a race). */
export function auditStmt(env: Env, e: AuditEntry, onlyIf?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const at = Math.floor(Date.now() / 1000);
  const vals = [at, e.actorId, e.via ?? null, e.action, e.targetType, e.targetId, JSON.stringify(e.detail ?? {})];
  return env.DB.prepare(
    `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail) SELECT ?,?,?,?,?,?,?${onlyIf ? ` WHERE ${onlyIf.sql}` : ""}`,
  ).bind(...vals, ...(onlyIf?.binds ?? []));
}
