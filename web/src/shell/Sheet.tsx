import { useEffect, useRef, type ReactNode } from "react";

// Set when a sheet closes so a sheet opened in the same tick (palette -> switcher) returns focus to the original opener.
let carried: Element | null = null;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The one dialog primitive. Focus moves inside on open and back to the opener on close; Tab cycles inside; Esc (capture phase,
 * any focus) closes; a mousedown on the scrim itself closes, one that starts inside the panel never does (so a drag that ends outside is safe).
 */
export function Sheet({ label, onClose, children, cls = "sheet" }: { label: string; onClose: () => void; children: ReactNode; cls?: string }) {
  const panel = useRef<HTMLDivElement>(null);
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
    const onKey = (e: KeyboardEvent) => {
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
      carried = opener;
      setTimeout(() => (carried = null), 0);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="scrim on" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div ref={panel} className={cls} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
