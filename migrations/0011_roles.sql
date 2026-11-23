-- Roles (S8): Owner and Member are built in; owners add custom roles. A person's effective role is COALESCE(role_id, role):
-- role_id is NULL (the built-in row named by role) or a custom role id, and only a member can have one.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  perms TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
-- Owner's stored perms are ignored (an owner has every permission). Member's defaults equal the pre-roles member rights.
INSERT INTO roles (id, name, perms, builtin, created_at, updated_at) VALUES
  ('owner', 'Owner', '[]', 1, 0, 0),
  ('member', 'Member', '["links.create","links.bulk","domains.own","keys","agents"]', 1, 0, 0);
-- NULL default, so existing rows need no backfill; the foreign key makes deleting a role still in use fail.
ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id);
CREATE INDEX users_role_id ON users(role_id);
-- Backstop for the code guards: role_id is NULL, or a custom role on a member.
CREATE TRIGGER users_role_id_ins BEFORE INSERT ON users
WHEN NEW.role_id IS NOT NULL AND (NEW.role != 'member' OR NEW.role_id IN ('owner', 'member'))
BEGIN SELECT RAISE(ABORT, 'role_id'); END;
CREATE TRIGGER users_role_id_upd BEFORE UPDATE OF role, role_id ON users
WHEN NEW.role_id IS NOT NULL AND (NEW.role != 'member' OR NEW.role_id IN ('owner', 'member'))
BEGIN SELECT RAISE(ABORT, 'role_id'); END;
-- Plain owners and members reach the built-in rows only through COALESCE(role_id, role), not the foreign key, so deleting one
-- would lock every one of them out: refuse it.
CREATE TRIGGER roles_builtin_del BEFORE DELETE ON roles
WHEN OLD.id IN ('owner', 'member')
BEGIN SELECT RAISE(ABORT, 'builtin_role'); END;
