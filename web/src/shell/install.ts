import { useSyncExternalStore } from "react";

/** Chrome's install event (Android, desktop Chrome and Edge). Not in the DOM typings. */
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallEvent | null = null;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

const KEY = "lw.install"; // a visit count, or "done" once the person installed or said not now

export function markDone() {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    // storage blocked: the nudge may show again on a later visit
  }
}

if (typeof window !== "undefined") {
  // preventDefault keeps Chrome's own install bar away; we ask once, our way (shouldNudge).
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    markDone();
    changed();
  });
}

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS reports itself as a Mac; the touch points tell them apart.
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** "prompt": the browser can install on a click. "ios": Safari has no install API, so we show the Share steps. null: nothing to offer. */
export type InstallKind = "prompt" | "ios" | null;

function installKind(): InstallKind {
  if (standalone()) return null;
  if (deferred) return "prompt";
  return ios() ? "ios" : null;
}

export const useInstall = (): InstallKind => useSyncExternalStore(subscribe, installKind);

/** Shows the browser's install dialog. The event works once; Chrome fires a fresh one later if the person said no. */
export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  changed();
  await e.prompt();
  if ((await e.userChoice).outcome === "accepted") markDone();
}

/**
 * The one-time nudge: on a phone, from the second visit, until the person installs or taps Not now. After that only the
 * rail button offers it. `stored` is the raw lw.install value.
 */
export function shouldNudge(stored: string | null, kind: InstallKind, phone: boolean): boolean {
  if (!kind || !phone || stored === "done") return false;
  return Number(stored) >= 2;
}

let counted = false;
/** Counts this page load as a visit (once, even under StrictMode) and returns the stored value after counting. */
export function countVisit(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    if (counted || v === "done") return v;
    counted = true;
    const next = String((Number(v) || 0) + 1);
    localStorage.setItem(KEY, next);
    return next;
  } catch {
    return "done"; // storage blocked: we could never remember a Not now, so never nudge
  }
}
