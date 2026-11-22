import type { Env } from "./env";

export type AuditEntry = {
  actorId: string; via?: string | null; action: string; targetType: string; targetId: string; detail?: unknown;
  /** Rows counted by a subselect at write time and stored as `{"count":n}`: exact for the same batch, unlike a read made before it. Replaces `detail`. */
  count?: { sql: string; binds: unknown[] };
};

/** Append-only audit row, meant to be batched with the write it records. `onlyIf` makes the row conditional (e.g. only when the guarded write won a race). */
export function auditStmt(env: Env, e: AuditEntry, onlyIf?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const at = Math.floor(Date.now() / 1000);
  const vals = [at, e.actorId, e.via ?? null, e.action, e.targetType, e.targetId];
  const detail = e.count ? { sql: `json_object('count', (${e.count.sql}))`, binds: e.count.binds } : { sql: "?", binds: [JSON.stringify(e.detail ?? {})] };
  return env.DB.prepare(
    `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail) SELECT ?,?,?,?,?,?,${detail.sql}${onlyIf ? ` WHERE ${onlyIf.sql}` : ""}`,
  ).bind(...vals, ...detail.binds, ...(onlyIf?.binds ?? []));
}

/**
 * One audit row per entry of `rows`, in one statement over a bound JSON array (`t` target id, `d` detail, plus any other
 * fields the guard reads, e.g. `r` revision). `guard.sql` may reference `j.value` and should look links up by id; each row
 * is written only when its own guard holds. `detail` is stored as JSON text, as auditStmt stores it.
 */
export function auditManyStmt(
  env: Env,
  base: { actorId: string; via: string | null; action: string; targetType: string },
  rows: ({ targetId: string; detail: Record<string, unknown> } & Record<string, unknown>)[],
  guard: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const at = Math.floor(Date.now() / 1000);
  const json = JSON.stringify(rows.map(({ targetId, detail, ...rest }) => ({ ...rest, t: targetId, d: detail })));
  return env.DB.prepare(
    `INSERT INTO audit_log (at, actor_id, via, action, target_type, target_id, detail) SELECT ?,?,?,?,?, json_extract(j.value,'$.t'), json_extract(j.value,'$.d') FROM json_each(?) j WHERE ${guard.sql}`,
  ).bind(at, base.actorId, base.via, base.action, base.targetType, json, ...guard.binds);
}
