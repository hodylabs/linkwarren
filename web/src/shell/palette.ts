import type { AppState } from "../state";
import type { Domain } from "../api";
import { navigate } from "../router";
import { SECTIONS } from "../settings/copy";

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
export function buildCommands(ctx: Ctx, isOwner: boolean, appMode = false): Command[] {
  const go = (keys: string, label: string, to: string): Command => ({ keys, section: "Go to", label, run: () => navigate(to) });
  return [
    go("gl", "Links", "/links"),
    go("gd", "Domains", "/domains"),
    go("ga", "Analytics", "/analytics"),
    go("af", "Filter analytics by domain", "/analytics?pick=1"),
    go("gi", "API & agents", "/agents"),
    ...(isOwner ? [go("gp", "People & audit log", "/people"), go("gs", "Settings", "/settings")] : []),
    ...(isOwner ? SECTIONS.map((s, i): Command => ({ ...go(`s${i + 1}`, `Settings: ${s.label}`, `/settings/${s.id}`), quiet: true })) : []),
    ...switcherDomains(ctx.domains).slice(0, 9).map((d, i): Command => ({
      keys: `g${i + 1}`, section: "Switch", label: `Switch to ${d.host}`, run: () => ctx.setCurrentDomain(d.id),
    })),
    { keys: "cl", section: "Create", label: "New link", run: () => ctx.open({ kind: "newLink" }) },
    { keys: "cd", section: "Create", label: "Add a domain", run: () => ctx.open({ kind: "addDomain" }) },
    { keys: "ck", section: "Create", label: "New API key", run: () => ctx.open({ kind: "newKey" }) },
    ...(isOwner ? [{ keys: "cp", section: "Create" as const, label: "Invite a person", run: () => ctx.open({ kind: "invite" }) }] : []),
    { keys: "sd", section: "Switch", label: "Switch domain", run: () => ctx.open({ kind: "switcher" }) },
    ...(appMode ? [{ keys: "ys", section: "Help" as const, label: "Sign-in and security", run: () => ctx.open({ kind: "account" }) }] : []),
    { keys: "?", section: "Help", label: "All keyboard shortcuts", run: () => ctx.open({ kind: "shortcuts" }) },
  ];
}
