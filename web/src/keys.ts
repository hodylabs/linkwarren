import { useEffect, useRef } from "react";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset"]);

/** True where a keystroke is text: text-like inputs, textareas, selects and contenteditable. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  const editable = el.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

const MODS = ["mod", "alt", "shift"] as const;

/** "Shift+Mod+K" -> "mod+shift+k": fixed modifier order, lowercase. */
function normalize(name: string): string {
  const parts = name.toLowerCase().split("+");
  const key = parts.pop()!;
  return [...MODS.filter((m) => parts.includes(m)), key].join("+");
}

/** Binding names for an event, most specific first. Shift is dropped only for single characters ("Shift+N" -> "n", "?" stays "?"). */
function names(e: KeyboardEvent): string[] {
  // Alt changes e.key on some layouts (Alt+D is "∂" on a Mac), so use the physical letter.
  const key = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  const mods = [e.ctrlKey || e.metaKey ? "mod" : "", e.altKey ? "alt" : ""].filter(Boolean);
  const full = [...mods, ...(e.shiftKey ? ["shift"] : []), key].join("+");
  return e.shiftKey && key.length === 1 ? [full, [...mods, key].join("+")] : [full];
}

// Inside text fields only these act; everything else is typing.
const WHILE_TYPING = new Set(["escape", "mod+enter", "mod+shift+enter", "mod+k"]);

/**
 * Window-level hotkeys. Names: "n", "shift+d", "mod+k", "mod+enter", "mod+shift+enter", "alt+d", "escape", "?" (mod = Ctrl or Cmd).
 * A shift+<key> binding wins over the plain key. A handled key is preventDefault-ed; already-prevented events are skipped.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const bound = new Map(Object.entries(latest.current).map(([k, fn]) => [normalize(k), fn]));
      const typing = isTypingTarget(e.target);
      for (const name of names(e)) {
        const fn = bound.get(name);
        if (!fn) continue;
        if (typing && !WHILE_TYPING.has(name) && !name.startsWith("alt+")) return;
        e.preventDefault();
        fn(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const CHORD_MS = 1500;

/**
 * Two-key "G then letter" chords outside text fields. Registered in the capture phase so a chord letter never reaches a screen hotkey.
 * The arm time is a timestamp, not a timer: nothing to clean up and a stale "g" simply expires.
 */
export function useChord(onChord: (letter: string) => boolean, enabled = true): void {
  const latest = useRef(onChord);
  latest.current = onChord;
  useEffect(() => {
    if (!enabled) return;
    let armedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const armed = armedAt !== 0 && Date.now() - armedAt <= CHORD_MS;
      armedAt = 0;
      if (armed && latest.current(key)) e.preventDefault();
      else if (key === "g" && !e.shiftKey) armedAt = Date.now();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}

/** A binding map with exactly the names of a keymap (a `{ name: "what it does" }` object), so the shortcuts sheet cannot drift from what is bound. */
export type Bindings<T> = { [K in keyof T]: (e: KeyboardEvent) => void };

const LABELS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift", escape: "Esc", enter: "Enter" };

/** "mod+shift+enter" -> ["Ctrl", "Shift", "Enter"], "gl" (a palette or chord sequence) -> ["G", "L"]. */
export function keyLabels(name: string): string[] {
  if (name.includes("+")) return name.split("+").map((p) => LABELS[p] ?? p.toUpperCase());
  return LABELS[name] ? [LABELS[name]!] : [...name].map((c) => c.toUpperCase());
}
