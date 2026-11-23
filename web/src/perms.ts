import type { Perm } from "../../src/roles";
import type { Domain, Me } from "./api";
import type { Screen } from "./router";
import type { Overlay } from "./state";

export type { Perm };

/** Copy of the server's PERMS (src/roles.ts), in its order: the web bundle never imports Worker code. perms.test.ts keeps them equal. */
export const PERMS = [
  "links.create", "links.editAny", "links.bulk", "analytics.all", "domains.own", "domains.manage",
  "people.manage", "keys", "agents", "settings", "data", "audit",
] as const satisfies readonly Perm[];

type Who = Pick<Me, "role" | "perms">;
export const isOwner = (me: Who): boolean => me.role === "owner";
/** Mirror of the server's `can` (S8 R2) for hiding controls; the server stays the authority. A signed-in person is active. */
export const can = (me: Who, p: Perm): boolean => isOwner(me) || me.perms.includes(p);

/** Each permission's toggle text in the role editor, in PERMS order (S8 R2). */
export const PERM_TEXT: Record<Perm, { label: string; hint: string }> = {
  "links.create": { label: "Create links", hint: "Make short links, and change or delete their own." },
  "links.editAny": { label: "Edit anyone's links", hint: "Change or delete links other people made, on domains they can use, and free up deleted short addresses." },
  "links.bulk": { label: "Change many links at once", hint: "Select several links and edit, move or delete them together." },
  "analytics.all": { label: "See analytics for every domain", hint: "Without it, they see clicks only for domains they can use." },
  "domains.own": { label: "Add their own domains", hint: "Add private domains for themselves. An owner or a domain manager approves them." },
  "domains.manage": { label: "Add and manage domains", hint: "Add main and shared domains, approve, turn off or reject them, choose who can use them, and use the Cloudflare controls." },
  "people.manage": { label: "Invite and manage people", hint: "Invite people, change their role and access, and remove them, only up to their own permissions." },
  keys: { label: "Personal API keys", hint: "Create keys for scripts and other tools." },
  agents: { label: "Connect AI agents", hint: "Connect assistants such as Claude or ChatGPT to work with links for them. Separate from API keys." },
  settings: { label: "Instance settings", hint: "Name, logo, main domain, link defaults and email, the switch that turns AI agent connections on or off for the whole instance, and the Cloudflare connection settings. Saved secrets stay with owners." },
  data: { label: "Export and import", hint: "Download the whole instance (every person, link and domain) and import links from a file." },
  audit: { label: "Audit log", hint: "See every change made by people and agents." },
};

/** Who sees the Roles view (S8 R11, R15): owners and people managers; only owners change roles. */
export const seesRoles = (me: Who): boolean => can(me, "people.manage");
/** Same rule as the server's `within` (src/roles.ts) for assigning a role: an owner any role, anyone else a non-owner role with no key they lack. */
export const mayAssign = (me: Who, r: { id: string; perms: readonly Perm[] }): boolean => isOwner(me) || (r.id !== "owner" && r.perms.every((p) => me.perms.includes(p)));

/** Screens behind a permission; the rest are baseline (R3). */
export function canSee(me: Who, s: Screen): boolean {
  if (s === "people") return can(me, "people.manage") || can(me, "audit");
  if (s === "settings") return can(me, "settings");
  return true;
}

/** Sheets that create something open only for a role that may create it, whatever opened them (a key, the palette, a button). */
export function mayOpen(me: Who, o: Overlay): boolean {
  if (o.kind === "newLink") return can(me, "links.create");
  if (o.kind === "addDomain") return can(me, "domains.own") || can(me, "domains.manage");
  if (o.kind === "newKey") return can(me, "keys");
  if (o.kind === "invite" || o.kind === "person") return can(me, "people.manage");
  return true;
}

/** Same rule as the server's canUseDomain (src/perm.ts); `canUse: false` marks a domain a domain manager may administer but not use. */
export const canUseDomain = (me: Pick<Me, "id" | "role" | "perms">, d: Domain): boolean =>
  d.canUse !== false && d.status !== "disabled" && (isOwner(me) || d.type === "main" || d.isMember || (d.type === "private" && d.ownerId === me.id));
