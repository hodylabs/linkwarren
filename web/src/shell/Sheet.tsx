import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { PHONE, useMedia } from "./narrow";

// Set when a sheet closes so a sheet opened in the same tick (palette -> switcher) returns focus to the original opener.
let carried: Element | null = null;

// Open sheets, bottom to top. Only the top one handles Esc and Tab; the shell reads the count to keep its hotkeys out.
const stack: HTMLElement[] = []; // the panels
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** How many sheets are open right now (any kind: overlays and inline confirms). */
export function useOpenSheets(): number {
  return useSyncExternalStore(subscribe, () => stack.length);
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The one dialog primitive. Focus moves inside on open and back to the opener on close; Tab cycles inside; Esc (capture phase,
 * any focus) closes the topmost sheet only; a mousedown on the scrim itself closes, one that starts inside the panel never does (so a drag that ends outside is safe).
 */
export function Sheet({ label, onClose, children, cls = "sheet" }: { label: string; onClose: () => void; children: ReactNode; cls?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const phone = useMedia(PHONE);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Read during the first render: a child's autoFocus has moved focus by the time effects run.
  const openerRef = useRef(document.activeElement);

  useEffect(() => {
    const from = carried ?? openerRef.current;
    const opener = from instanceof HTMLElement ? from : null;
    const p = panel.current!;
    const items = () => [...p.querySelectorAll<HTMLElement>(FOCUSABLE)];
    // A child that autofocused (the palette box) keeps focus.
    if (!p.contains(document.activeElement)) (items()[0] ?? p).focus();
    const self = p;
    stack.push(self);
    changed();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== self) return; // a sheet above this one owns the keyboard
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = items();
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const at = document.activeElement;
      if (!p.contains(at) || (e.shiftKey && (at === first || at === p))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(self), 1);
      changed();
      carried = opener;
      setTimeout(() => (carried = null), 0);
      // A sheet still open keeps focus inside it (unless the opener is in it); the last one to close returns it to the opener.
      const top = stack[stack.length - 1];
      if (top && !(opener && top.contains(opener))) {
        if (!top.contains(document.activeElement)) (top.querySelector<HTMLElement>(FOCUSABLE) ?? top).focus();
      } else if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="scrim on" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div ref={panel} className={cls} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
        {/* Phones have no Esc key and the panel can cover the scrim: a close button, last so first focus and autoFocus are unchanged. */}
        {phone && (
          <button type="button" className="btn ghost sheet-x" aria-label={`Close ${label.toLowerCase()}`} onClick={() => closeRef.current()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
