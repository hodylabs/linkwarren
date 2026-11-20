import type { AppState } from "../state";
import type { Domain } from "../api";
import { navigate } from "../router";

export type Command = { keys: string; section: "Go to" | "Create" | "Switch" | "Help"; label: string; run: () => void };
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
  const next = s.buf + e.key.toLowerCase();
  const exact = cmds.find((c) => c.keys === next);
  if (exact) return { s: { buf: "", text: "" }, run: exact, consumed: true };
  if (cmds.some((c) => c.keys.startsWith(next))) return { s: { buf: next, text: "" }, consumed: true };
  if (s.buf) return { s: { buf: "", text: s.buf + e.key }, consumed: true };
  return pass;
}

const GROUPS = ["main", "shared", "private"] as const;

/** Switcher order: Main, Shared, Private, each by host. The first nine get keys 1 to 9. */
export function switcherDomains(domains: Domain[]): Domain[] {
  return GROUPS.flatMap((t) => domains.filter((d) => d.type === t).sort((a, b) => a.host.localeCompare(b.host)));
}

type Ctx = Pick<AppState, "domains" | "open" | "setCurrentDomain">;

export function buildCommands(ctx: Ctx, isOwner: boolean): Command[] {
  const go = (keys: string, label: string, to: string): Command => ({ keys, section: "Go to", label, run: () => navigate(to) });
  return [
    go("gl", "Links", "/links"),
    go("gd", "Domains", "/domains"),
    go("ga", "Analytics", "/analytics"),
    ...(isOwner ? [go("gp", "People & audit log", "/people"), go("gi", "API & agents", "/agents"), go("gs", "Settings", "/settings")] : []),
    ...switcherDomains(ctx.domains).slice(0, 9).map((d, i): Command => ({
      keys: `g${i + 1}`, section: "Switch", label: `Switch to ${d.host}`, run: () => ctx.setCurrentDomain(d.id),
    })),
    { keys: "cl", section: "Create", label: "New link", run: () => ctx.open({ kind: "newLink" }) },
    { keys: "cd", section: "Create", label: "Add a domain", run: () => ctx.open({ kind: "addDomain" }) },
    { keys: "sd", section: "Switch", label: "Switch domain", run: () => ctx.open({ kind: "switcher" }) },
    { keys: "?", section: "Help", label: "All keyboard shortcuts", run: () => ctx.open({ kind: "shortcuts" }) },
  ];
}
