import { useEffect, useRef, useSyncExternalStore } from "react";
import { navigate, useRoute } from "../router";
import { stripBase } from "../base";

/** List and detail share one column (tablets and phones). Keep in step with styles.css. */
export const NARROW = "(max-width: 1080px)";
/** The rail becomes a top bar with a menu drawer. Keep in step with styles.css. */
export const PHONE = "(max-width: 760px)";

const query = (q: string) => (typeof matchMedia === "function" ? matchMedia(q) : null);

/** Whether a media query matches now; re-renders when it flips. */
export function useMedia(q: string): boolean {
  return useSyncExternalStore(
    (f) => {
      const m = query(q);
      m?.addEventListener("change", f);
      return () => m?.removeEventListener("change", f);
    },
    () => query(q)?.matches ?? false,
  );
}

/**
 * The detail as a pushed view on narrow screens: `?sel=<id>&view=detail`. Opening pushes a history entry over the list
 * (the entry below keeps the selection), so Back, browser back and Esc all return to the list with the row still selected.
 * Above the breakpoint the view flag is ignored and `show` returns false, so the caller selects in place as before.
 */
export function useDetailView(path: string) {
  const narrow = useMedia(NARROW);
  const { query: q } = useRoute();
  const open = narrow && q.has("sel") && q.get("view") === "detail";

  const show = (id: string): boolean => {
    if (!narrow) return false;
    const p = new URLSearchParams(location.search);
    p.set("sel", id);
    p.delete("view");
    navigate(`${path}?${p}`, { replace: true });
    p.set("view", "detail");
    navigate(`${path}?${p}`, { state: { detail: true } });
    return true;
  };

  const back = () => {
    if ((history.state as { detail?: boolean } | null)?.detail) return history.back();
    // Opened from a link or a reload: nothing of ours to pop, so drop the flag in place.
    const p = new URLSearchParams(location.search);
    p.delete("view");
    const s = p.toString();
    navigate(`${path}${s ? `?${s}` : ""}`, { replace: true });
  };

  // Back on the list: the row the detail showed last stays selected (J/K in the detail only replaced the detail entry,
  // so the list entry below still names the row it opened with), then focus returns to it.
  const sel = q.get("sel");
  const was = useRef(open);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (open) {
      shown.current = sel;
    } else if (was.current) {
      const want = shown.current;
      if (want && sel !== want && stripBase(location.pathname) === path) {
        const p = new URLSearchParams(location.search);
        p.set("sel", want);
        return navigate(`${path}?${p}`, { replace: true }); // runs again with the new selection, then focuses
      }
      shown.current = null;
      document.querySelector<HTMLElement>('.list [aria-selected="true"]')?.focus();
    }
    was.current = open;
  }, [open, sel, path]);

  // A selection rejected by the server (gone or hidden): never restore it when the detail closes.
  const forget = () => {
    shown.current = null;
  };

  return { open, show, back, forget };
}

/** The pushed detail's Back control. Takes focus when the detail opens. */
export const BackBar = ({ label, onBack }: { label: string; onBack: () => void }) => (
  <div className="backbar">
    <button type="button" className="btn ghost" autoFocus onClick={onBack}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {label}
    </button>
  </div>
);
