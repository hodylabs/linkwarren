import { MEMBER_DEFAULT, PERMS, type Perm } from "../../../src/roles";

/** Test only: the role fields /api/me carries for the two built-in roles, and a custom role with exactly `perms`. */
export const OWNER_ROLE = { roleId: "owner", roleName: "Owner", perms: [...PERMS] };
export const MEMBER_ROLE = { roleId: "member", roleName: "Member", perms: [...MEMBER_DEFAULT] };
export const customRole = (perms: Perm[], roleName = "Helper") => ({ role: "member" as const, roleId: "hl", roleName, perms });
