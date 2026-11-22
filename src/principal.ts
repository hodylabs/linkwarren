import type { UserRow } from "./types";

/**
 * What the current request may do on top of its person's own rights; never more than the person.
 * `domains` null means every domain the person can use; a list narrows it (for the owner too). `via` labels audit rows.
 */
export type Grant = { write: boolean; del: boolean; domains: readonly string[] | null; via: string | null };

/** The dashboard: the signed-in person themselves. */
export const FULL_GRANT: Grant = Object.freeze({ write: true, del: true, domains: null, via: null });

/** The audit actor of a request, spread into every auditStmt entry. */
export const actor = (c: { var: { user: UserRow; grant: Grant } }): { actorId: string; via: string | null } =>
  ({ actorId: c.var.user.id, via: c.var.grant.via });
