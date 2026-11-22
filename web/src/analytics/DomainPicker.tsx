import { useState, type KeyboardEvent } from "react";
import type { Domain } from "../api";
import { Kbd } from "../shell/ui";

const TYPE = { main: "Main", shared: "Shared", private: "Private" } as const;

/**
 * Multi-select domain dropdown (mockup `.dd-pop`). Focus stays in the filter box: ArrowUp/Down move, Space (box empty)
 * or Enter toggles, Esc closes (the caller returns focus to its chip). The caller closes it on a mousedown outside.
 */
export function DomainPicker({ domains, selected, onToggle, onAll, onClose }: {
  /** Already in display order. */
  domains: Domain[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const shown = domains.filter((d) => d.host.toLowerCase().includes(q.toLowerCase()));
  const at = Math.min(cur, Math.max(shown.length - 1, 0));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setCur((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if ((e.key === " " && !q) || e.key === "Enter") {
      e.preventDefault();
      if (shown[at]) onToggle(shown[at].id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="dd-pop">
      <div className="dd-s">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="an-dlist"
          aria-activedescendant={shown[at] ? `an-d-${shown[at].id}` : undefined}
          aria-label="Find a domain"
          placeholder="Find a domain"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCur(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="dd-list" id="an-dlist" role="listbox" aria-multiselectable="true" aria-label="Domains">
        {shown.map((d, i) => {
          const on = selected.includes(d.id);
          return (
            <div
              key={d.id}
              id={`an-d-${d.id}`}
              className="dd-it"
              role="option"
              aria-selected={on}
              aria-current={i === at}
              // Keep focus in the filter box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setCur(i);
                onToggle(d.id);
              }}
            >
              <span className="cb" aria-hidden="true">{on ? "✓" : ""}</span>
              {d.host}
              <span className="ty">{TYPE[d.type]}</span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty">No domain matches</div>}
      </div>
      <div className="dd-f">
        <button type="button" className="btn ghost" onClick={onAll}>
          All domains
        </button>
        <span>
          <Kbd>Space</Kbd> pick <Kbd>Esc</Kbd> done
        </span>
      </div>
    </div>
  );
}
