import type { AppState, Overlay } from "../state";
import type { Domain, Me } from "../api";
import { canSee, mayOpen, seesRoles } from "../perms";
import { navigate } from "../router";
import { sectionsFor } from "../settings/copy";

/** `quiet`: left out of the opening list; found by typing its name or its first key. */
export type Command = { keys: string; section: "Go to" | "Create" | "Switch" | "Help"; label: string; run: () => void; quiet?: true };
export type PaletteState = { buf: string; text: string };
type KeyInfo = { key: string; ctrl: boolean; meta: boolean; alt: boolean; composing: boolean };

/**
 * One keystroke in the palette box. With the box empty a letter that starts a shortcut is buffered; a letter that breaks it
 * becomes search text (buffer + letter), so "go" and "spring" search. Anything else (modifiers, IME, text already typed) is normal typing.
 */
export function paletteKey(s: PaletteState, e: KeyInfo, cmds: Command[]): { s: PaletteState; run?: Command; consumed: boolean } {
  const pass = { s, consumed: false };
  if (e.ctrl || e.meta || e.alt || e.composing || s.text) return pass;
  if (e.key === "Backspace") return s.buf ? { s: { buf: s.buf.slice(0, -1), text: "" }, consumed: true } : pass;
  if (e.key.length !== 1) return pass;
  // buf keeps the typed case (it becomes search text on a miss); matching is case-insensitive.
  const next = s.buf + e.key;
  const lower = next.toLowerCase();
  const exact = cmds.find((c) => c.keys === lower);
  if (exact) return { s: { buf: "", text: "" }, run: exact, consumed: true };
  if (cmds.some((c) => c.keys.startsWith(lower))) return { s: { buf: next, text: "" }, consumed: true };
  if (s.buf) return { s: { buf: "", text: s.buf + e.key }, consumed: true };
  return pass;
}

const GROUPS = ["main", "shared", "private"] as const;

/** Switcher order: Main, Shared, Private, each by host. The first nine get keys 1 to 9. */
export function switcherDomains(domains: Domain[]): Domain[] {
  return GROUPS.flatMap((t) => domains.filter((d) => d.type === t).sort((a, b) => a.host.localeCompare(b.host)));
}

type Ctx = Pick<AppState, "domains" | "open" | "setCurrentDomain">;

/** `appMode`: linkwarren signs people in itself (not Cloudflare Access), so the account sheet exists. */
export function buildCommands(ctx: Ctx, me: Pick<Me, "role" | "perms">, appMode = false): Command[] {
  const go = (keys: string, label: string, to: string): Command => ({ keys, section: "Go to", label, run: () => navigate(to) });
  const create = (keys: string, label: string, o: Overlay): Command[] =>
    mayOpen(me, o) ? [{ keys, section: "Create", label, run: () => ctx.open(o) }] : [];
  return [
    go("gl", "Links", "/links"),
    ...(canSee(me, "qr") ? [go("gq", "QR codes", "/qr")] : []),
    go("gd", "Domains", "/domains"),
    go("ga", "Analytics", "/analytics"),
    go("af", "Filter analytics by domain", "/analytics?pick=1"),
    go("gi", "API & agents", "/agents"),
    ...(canSee(me, "people") ? [go("gp", "People & audit log", "/people")] : []),
    ...(seesRoles(me) ? [go("gr", "Roles", "/people/roles")] : []),
    ...(canSee(me, "settings") ? [go("gs", "Settings", "/settings")] : []),
    ...(canSee(me, "settings") ? sectionsFor(me).map((s, i): Command => ({ ...go(`s${i + 1}`, `Settings: ${s.label}`, `/settings/${s.id}`), quiet: true })) : []),
    ...switcherDomains(ctx.domains).slice(0, 9).map((d, i): Command => ({
      keys: `g${i + 1}`, section: "Switch", label: `Switch to ${d.host}`, run: () => ctx.setCurrentDomain(d.id),
    })),
    ...create("cl", "New link", { kind: "newLink" }),
    ...create("cd", "Add a domain", { kind: "addDomain" }),
    ...create("ck", "New API key", { kind: "newKey" }),
    ...create("cp", "Invite a person", { kind: "invite" }),
    { keys: "sd", section: "Switch", label: "Switch domain", run: () => ctx.open({ kind: "switcher" }) },
    ...(appMode ? [{ keys: "ys", section: "Help" as const, label: "Sign-in and security", run: () => ctx.open({ kind: "account" }) }] : []),
    { keys: "?", section: "Help", label: "All keyboard shortcuts", run: () => ctx.open({ kind: "shortcuts" }) },
  ];
}
