import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "../keys";
import { navigate, useRoute } from "../router";
import { Chip, Kbd, PrimaryButton, Tag } from "../shell/ui";
import { useApp } from "../state";
import { DomainDetail } from "./DomainDetail";
import { ownerLabel, sharedWith, statusTag } from "./domainView";

const FILTERS = [
  ["all", "All"],
  ["main", "Main"],
  ["shared", "Shared"],
  ["private", "Private"],
  ["pending", "Needs approval"],
] as const;
const TYPE_LABEL = { main: "Main", shared: "Shared", private: "Private" } as const;

export function DomainsScreen() {
  const app = useApp();
  const { me, domains, users, overlay } = app;
  const isOwner = me.role === "owner";
  const { query } = useRoute();
  const q = (query.get("q") ?? "").toLowerCase();
  const sel = query.get("sel");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [modal, setModal] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = useRef(false);

  const items = useMemo(
    () => domains.filter((d) => d.host.includes(q) && (filter === "all" ? true : filter === "pending" ? d.status === "pending" : d.type === filter)),
    [domains, q, filter],
  );
  const waiting = domains.filter((d) => d.status === "pending").length;
  const at = items.findIndex((d) => d.id === sel);
  const selected = at >= 0 ? items[at]! : null;

  const select = (id: string | null, focus = false) => {
    focusRow.current = focus;
    const p = new URLSearchParams(location.search);
    if (id) p.set("sel", id);
    else p.delete("sel");
    const s = p.toString();
    navigate(`/domains${s ? `?${s}` : ""}`, { replace: true });
  };
  useEffect(() => {
    if (focusRow.current && sel) rowRefs.current.get(sel)?.focus();
    focusRow.current = false;
  }, [sel, items]);

  const move = (step: 1 | -1) => {
    if (items.length === 0) return;
    const to = at < 0 ? items[step === 1 ? 0 : items.length - 1] : items[at + step];
    if (to) select(to.id, true);
  };

  useHotkeys({ j: () => move(1), k: () => move(-1), n: () => app.open({ kind: "addDomain" }) }, overlay === null && !modal);

  return (
    <>
      <header className="top">
        <h1>Domains</h1>
        <span className="crumb">{domains.length} domains</span>
        <button type="button" className="search" onClick={() => app.open({ kind: "palette" })} aria-keyshortcuts="Control+K">
          <span>{q || "Search domains"}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <PrimaryButton label="Add domain" shortcut="N" onClick={() => app.open({ kind: "addDomain" })} />
      </header>
      <div className="body">
        <section className="list" aria-label="Domains">
          <div className="filters">
            {FILTERS.map(([v, label]) => (
              <Chip key={v} pressed={filter === v} onClick={() => setFilter(v)}>
                {label}
              </Chip>
            ))}
            {isOwner && waiting > 0 && <span className="count">{waiting} waiting for you</span>}
          </div>
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Status</th>
                <th>Owner</th>
                {isOwner && <th>Shared with</th>}
                <th className="num">Links</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d, i) => {
                const tag = statusTag(d, isOwner);
                return (
                  <tr
                    key={d.id}
                    ref={(el) => void (el ? rowRefs.current.set(d.id, el) : rowRefs.current.delete(d.id))}
                    aria-selected={d.id === sel}
                    tabIndex={d.id === sel || (!selected && i === 0) ? 0 : -1}
                    onClick={() => select(d.id)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && select(d.id)}
                  >
                    <td className="short">
                      <span className="slug">{d.host}</span>
                    </td>
                    <td>{TYPE_LABEL[d.type]}</td>
                    <td>
                      <Tag tone={tag.tone}>{tag.label}</Tag>
                    </td>
                    <td>{ownerLabel(d, me, users)}</td>
                    {isOwner && <td>{sharedWith(d, users, me)}</td>}
                    <td className="num">{d.linkCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && <p className="empty pad">No domains match.</p>}
        </section>
        {selected ? (
          <DomainDetail key={selected.id} domain={selected} onModal={setModal} />
        ) : (
          <aside className="detail" aria-label="Selected domain">
            <p className="empty pad">Select a domain to see it here.</p>
          </aside>
        )}
      </div>
    </>
  );
}
