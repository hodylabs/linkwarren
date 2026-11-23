import { useRef, type KeyboardEvent, type ReactNode } from "react";

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

// Stroke icons from the mockup's symbol set (24 x 24, drawn with currentColor by styles.css).
const PATHS = {
  copy: "M9 9h11v11H9zM5 15V6a2 2 0 0 1 2-2h8",
  edit: "M4 20h4L19 9l-4-4L4 16z",
  qr: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3M21 14v7h-4M14 21v-3",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  x: "M6 6l12 12M18 6 6 18",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01",
  side: "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9 4v16M15 10l-2 2 2 2",
  menu: "M4 7h16M4 12h16M4 17h16",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  lock: "M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3",
  route: "M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 17V9a4 4 0 0 1 4-4h6M18 7v8a4 4 0 0 1-4 4H8",
  fwd: "M5 12h14M13 6l6 6-6 6",
  card: "M3 5h18v14H3zM9 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a3 3 0 0 1 6 0M14 10h4M14 14h3",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  mail: "M3 5h18v14H3zM3 7l9 6 9-6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  back: "m15 6-6 6 6 6",
  dl: "M12 4v11M7 10l5 5 5-5M5 20h14",
  links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  empty: "M4 20V10M10 20v-6M16 20v-3M22 20H2M3 4l18 12",
  updown: "m8 9 4-4 4 4M8 15l4 4 4-4",
  plus: "M12 5v14M5 12h14",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
} as const;
export type IconName = keyof typeof PATHS;

/** A decorative stroke icon; the control around it carries the name. */
export const Icon = ({ name }: { name: IconName }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

/** A screen's page action: orange button, graphite circled plus and text (7.5:1 on the orange), shortcut letter. */
export function PrimaryButton({ label, shortcut, onClick, disabled }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn primary act" onClick={onClick} aria-keyshortcuts={shortcut} disabled={disabled}>
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
export const Switch = ({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; describedBy?: string }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} className={checked ? "sw on" : "sw"} disabled={disabled} onClick={() => onChange(!checked)} />
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
  <button type="button" className="btn ghost sm icon x-btn" aria-label={label} aria-keyshortcuts="Escape" onClick={onClick}>
    <Icon name="x" />
  </button>
);
