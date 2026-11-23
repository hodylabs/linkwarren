import { createElement, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { stripBase, withBase } from "./base";

export type Screen = "links" | "domains" | "people" | "analytics" | "agents" | "settings";
const SCREENS: readonly Screen[] = ["links", "domains", "people", "analytics", "agents", "settings"];

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
if (typeof window !== "undefined") window.addEventListener("popstate", emit);

/** `to` is an inner path; the base is added here. A replace keeps the entry's history state (a pushed detail view stays marked as pushed); a push sets `opts.state`. */
export function navigate(to: string, opts: { replace?: boolean; state?: unknown } = {}): void {
  if (opts.replace) history.replaceState(history.state, "", withBase(to));
  else history.pushState(opts.state ?? null, "", withBase(to));
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const snapshot = () => stripBase(location.pathname) + location.search;

const screenOf = (path: string): Screen | null => {
  const seg = path.split("?")[0]!.split("/")[1] ?? "";
  return (SCREENS as readonly string[]).includes(seg) ? (seg as Screen) : null;
};

/**
 * The current screen, the path segment after it (a Settings section) and query. "/" and unknown paths resolve to links and rewrite the URL to /links;
 * /setup (the first-run wizard, which renders outside the router) lands on /settings/instance once the instance is set up.
 */
export function useRoute(): { screen: Screen; sub: string; query: URLSearchParams } {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const screen = screenOf(loc);
  useEffect(() => {
    if (!screen) navigate(loc.split("?")[0] === "/setup" ? "/settings/instance" : "/links", { replace: true });
  }, [screen, loc]);
  return useMemo(
    () => ({ screen: screen ?? "links", sub: loc.split("?")[0]!.split("/")[2] ?? "", query: new URLSearchParams(loc.split("?")[1] ?? "") }),
    [screen, loc],
  );
}

/** A plain link that navigates in-app on an unmodified left click; any other click keeps browser behaviour (new tab and so on). */
export function NavLink({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return createElement("a", {
    ...rest,
    href: withBase(to),
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
  });
}
