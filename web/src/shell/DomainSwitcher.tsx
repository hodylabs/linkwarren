import { useState, type KeyboardEvent } from "react";
import type { Domain } from "../api";
import { useApp } from "../state";
import { Kbd } from "./ui";
import { switcherDomains } from "./palette";
import { Sheet } from "./Sheet";

const DOT = { active: "ok", pending: "wait", disabled: "bad" } as const;

function sub(d: Domain): string {
  return d.status === "pending" ? "waiting for approval" : d.status === "disabled" ? "disabled" : `${d.linkCount} links`;
}

export function DomainSwitcher() {
  const { me, domains, currentDomainId, setCurrentDomain, close } = useApp();
  const ordered = switcherDomains(domains);
  // null id = every domain; the number shown is the jump key (1 to 9, 0 for all).
  const all = [
    ...ordered.map((d, i) => ({ id: d.id as string | null, d, key: i < 9 ? String(i + 1) : "" })),
    { id: null as string | null, d: null as Domain | null, key: "0" },
  ];
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(() => Math.max(all.findIndex((x) => x.id === currentDomainId), 0));
  const shown = all.filter((x) => !q || (x.d ? x.d.host.toLowerCase().includes(q.toLowerCase()) : "every domain you can see".includes(q.toLowerCase())));
  const at = Math.min(sel, Math.max(shown.length - 1, 0));
  const pick = (id: string | null) => {
    setCurrentDomain(id);
    close();
  };
  const sharedTitle = me.role === "owner" ? "Shared" : "Shared with you";
  const title = (x: (typeof all)[number]) => (!x.d ? "All domains" : x.d.type === "main" ? "Main" : x.d.type === "shared" ? sharedTitle : "Private");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setSel((at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[at] && !e.nativeEvent.isComposing) pick(shown[at].id);
    } else if (!q && /^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
      const hit = all.find((x) => x.key === e.key);
      if (hit) {
        e.preventDefault();
        pick(hit.id);
      }
    }
  };

  return (
    <Sheet label="Switch domain" onClose={close} cls="palette narrow">
      <div className="p-in">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="dsw-list"
          aria-activedescendant={shown[at] ? `dsw-${shown[at].id ?? "all"}` : undefined}
          aria-label="Find a domain"
          placeholder="Switch domain"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="p-list" id="dsw-list" role="listbox">
        {shown.map((x, i) => (
          <div key={x.id ?? "all"}>
            {(i === 0 || title(shown[i - 1]!) !== title(x)) && <div className="p-sec">{title(x)}</div>}
            <div id={`dsw-${x.id ?? "all"}`} role="option" className="p-item" aria-selected={i === at} onMouseMove={() => setSel(i)} onClick={() => pick(x.id)}>
              <span className={`dot2 ${x.d ? DOT[x.d.status] : "off"}`} />
              <span className={x.d ? "lbl mono" : "lbl"}>{x.d ? x.d.host : "Every domain you can see"}</span>
              {x.d && <span className="sub">{sub(x.d)}</span>}
              {x.key && <span className="keys"><kbd>{x.key}</kbd></span>}
            </div>
          </div>
        ))}
      </div>
      <div className="p-foot">
        <span><Kbd>1</Kbd>–<Kbd>9</Kbd> jump</span>
        <span><Kbd>Enter</Kbd> switch</span>
        <span>also <Kbd>Ctrl K</Kbd> <Kbd>G</Kbd> <Kbd>1</Kbd>–<Kbd>9</Kbd></span>
        <span className="end"><Kbd>Esc</Kbd> close</span>
      </div>
    </Sheet>
  );
}
