import { createElement, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Screen = "links" | "domains" | "people" | "analytics" | "agents" | "settings";
const SCREENS: readonly Screen[] = ["links", "domains", "people", "analytics", "agents", "settings"];

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
if (typeof window !== "undefined") window.addEventListener("popstate", emit);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const snapshot = () => location.pathname + location.search;

const screenOf = (path: string): Screen | null => {
  const seg = path.split("?")[0]!.split("/")[1] ?? "";
  return (SCREENS as readonly string[]).includes(seg) ? (seg as Screen) : null;
};

/** The current screen and query. "/" and unknown paths resolve to links and rewrite the URL to /links. */
export function useRoute(): { screen: Screen; query: URLSearchParams } {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const screen = screenOf(loc);
  useEffect(() => {
    if (!screen) navigate("/links", { replace: true });
  }, [screen]);
  return useMemo(() => ({ screen: screen ?? "links", query: new URLSearchParams(loc.split("?")[1] ?? "") }), [screen, loc]);
}

/** A plain link that navigates in-app on an unmodified left click; any other click keeps browser behaviour (new tab and so on). */
export function NavLink({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return createElement("a", {
    ...rest,
    href: to,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
  });
}
