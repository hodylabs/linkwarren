import { useRef, type KeyboardEvent, type ReactNode } from "react";

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/** A screen's page action: orange button, graphite circled plus and text (7.5:1 on the orange), shortcut letter. */
export function PrimaryButton({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button type="button" className="btn primary act" onClick={onClick} aria-keyshortcuts={shortcut}>
      <svg className="plus" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
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
export function Seg<V extends string | number>({ options, value, onChange, label, wrap, cls }: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  /** Options may wrap onto several rows (narrow panels): each button is its own rounded box. */
  wrap?: boolean;
  /** Extra class names after `seg` (the analytics range uses `seg2`). */
  cls?: string;
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
    <div className={["seg", wrap && "wrap", cls].filter(Boolean).join(" ")} role="radiogroup" aria-label={label} ref={group} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Page header: title with its count, one muted line, then the toolbar (search, filters, page action). */
export function ScreenHeader({ title, count, text, children }: { title: string; count?: ReactNode; text?: ReactNode; children?: ReactNode }) {
  return (
    <header className="top">
      <div className="t-row">
        <h1>{title}</h1>
        {count && <span className="t-count">{count}</span>}
      </div>
      {text && <p className="desc">{text}</p>}
      {children && <div className="toolbar">{children}</div>}
    </header>
  );
}

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

/** Opens the command palette; shows the current search, or the placeholder. */
export const SearchButton = ({ q, placeholder, onOpen }: { q: string; placeholder: string; onOpen: () => void }) => (
  <button type="button" className="search" onClick={onOpen} aria-keyshortcuts="Control+K">
    <SearchIcon />
    <span>{q || placeholder}</span>
    <Kbd>Ctrl K</Kbd>
  </button>
);

/** Empty list: icon tile, title, one line, optional action. */
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="tile">
        <SearchIcon />
      </span>
      <p className="et">{title}</p>
      <p className="ed">{text}</p>
      {children}
    </div>
  );
}

/** The detail panel's close (X) button; Esc does the same. */
export const CloseButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="btn ghost x-btn" aria-label={label} aria-keyshortcuts="Escape" onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  </button>
);
