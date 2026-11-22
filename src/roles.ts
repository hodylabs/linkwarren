import type { UserRow } from "./types";

/** The closed permission list (S8 R2), in display order. Stored keys not in it are ignored on read. */
export const PERMS = [
  "links.create", "links.editAny", "links.bulk", "analytics.all", "domains.own", "domains.manage",
  "people.manage", "keys", "agents", "settings", "data", "audit",
] as const;
export type Perm = (typeof PERMS)[number];
/** The built-in Member role's seeded perms: exactly what a member could do before roles existed. */
export const MEMBER_DEFAULT: readonly Perm[] = ["links.create", "links.bulk", "domains.own", "keys", "agents"];

/** Stored perms JSON to keys: known keys only, once each, in PERMS order; anything that is not a JSON array is no permission at all. */
export function parsePerms(text: unknown): Perm[] {
  if (typeof text !== "string") return [];
  let v: unknown;
  try { v = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const a: unknown[] = v;
  return PERMS.filter((p) => a.includes(p));
}

export const can = (user: UserRow, p: Perm): boolean => user.status === "active" && (user.role === "owner" || user.perms.includes(p));

/** Every key of `perms` is one the actor has (an owner has all). */
export const within = (perms: readonly Perm[], actor: UserRow): boolean => actor.role === "owner" || perms.every((p) => actor.perms.includes(p));

export type Guard = { sql: string; binds: unknown[] };

/** A stored perms value as a JSON array for json_each; anything else (bad JSON, an object) reads as `[]`, so SQL fails closed like parsePerms. */
const arr = (col: string) => `(CASE WHEN json_valid(${col}) THEN (CASE WHEN json_type(${col}) = 'array' THEN ${col} ELSE '[]' END) ELSE '[]' END)`;

/** SQL twin of `can` for a write's batch: the person is active and is an owner or their role has `p` (bound, never interpolated). */
export const actorCan = (userId: string, p: Perm): Guard => ({
  sql: `EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = COALESCE(u.role_id, u.role) WHERE u.id = ? AND u.status = 'active'
    AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM json_each(${arr("r.perms")}) WHERE value = ?)))`,
  binds: [userId, p],
});

/** SQL twin of `within` for assigning `roleId`: the actor is active and an owner, or the role exists, is not Owner and has no key the actor's role lacks. */
export const roleWithin = (roleId: string, actorId: string): Guard => ({
  sql: `EXISTS (SELECT 1 FROM users a JOIN roles ar ON ar.id = COALESCE(a.role_id, a.role) JOIN roles t ON t.id = ?
    WHERE a.id = ? AND a.status = 'active' AND (a.role = 'owner' OR (t.id != 'owner' AND NOT EXISTS (
      SELECT 1 FROM json_each(${arr("t.perms")}) k WHERE k.value NOT IN (SELECT value FROM json_each(${arr("ar.perms")}))))))`,
  binds: [roleId, actorId],
});

/** Every query feeding rowToUser selects these from `users u` with ROLE_JOIN: the role comes with the user, never as its own query. */
export const USER_COLS = "u.*, COALESCE(u.role_id, u.role) role_key, r.name role_name, r.perms role_perms";
export const ROLE_JOIN = "JOIN roles r ON r.id = COALESCE(u.role_id, u.role)";

/** The earliest active owner (S8 R8): owns a main or shared domain a non-owner adds. */
export const FIRST_OWNER = "(SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at, id LIMIT 1)";
