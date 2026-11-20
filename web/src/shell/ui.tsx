import { useRef, type KeyboardEvent, type ReactNode } from "react";

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/** Graphite button, orange plus, grey shortcut letter. */
export function PrimaryButton({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button type="button" className="btn primary" onClick={onClick} aria-keyshortcuts={shortcut}>
      <svg className="plus" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {label}
      {shortcut && <span className="k">{shortcut}</span>}
    </button>
  );
}

export const Tag = ({ tone, children }: { tone: "ok" | "wait" | "bad" | "off"; children: ReactNode }) => (
  <span className={`tag t-${tone}`}>{children}</span>
);

export const Chip = ({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
    {children}
  </button>
);

/** A real button, so Space and Enter toggle it natively. */
export const Switch = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? "sw on" : "sw"} onClick={() => onChange(!checked)} />
);

/** Segmented radio group: one tab stop, arrow keys move and select. */
export function Seg<V extends string | number>({ options, value, onChange, label }: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = (options.findIndex((o) => o.value === value) + step + options.length) % options.length;
    onChange(options[i]!.value);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[i]?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} ref={group} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
