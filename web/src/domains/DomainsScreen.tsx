import { plural } from "../copy";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { Chip, Empty, PrimaryButton, ScreenHeader, SearchChip, Tag } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";
import { BackBar, useDetailView } from "../shell/narrow";
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

/** Domains screen hotkeys and their text on the shortcuts sheet. */
export const DOMAINS_KEYS = {
  n: "Add a domain",
  j: "Next domain",
  k: "Previous domain",
  escape: "Clear the selection",
} as const;

export function DomainsScreen() {
  const app = useApp();
  const { me, domains, users, overlay } = app;
  const admin = can(me, "domains.manage"); // domain administration (S8 R8), not only owners
  const canAdd = admin || can(me, "domains.own");
  const { query } = useRoute();
  const q = (query.get("q") ?? "").toLowerCase();
  const sel = query.get("sel");
  const { open, show, back } = useDetailView("/domains");
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
    else {
      p.delete("sel");
      p.delete("view"); // nothing selected: no detail view either
    }
    const s = p.toString();
    navigate(`/domains${s ? `?${s}` : ""}`, { replace: true });
  };
  // Esc or the panel close button: back to the list on narrow screens, else close the panel; focus goes to the row that was selected.
  const closeDetail = () => {
    if (open) return back();
    if (sel) rowRefs.current.get(sel)?.focus();
    select(null);
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

  useHotkeys(
    {
      n: () => app.open({ kind: "addDomain" }),
      j: () => move(1),
      k: () => move(-1),
      escape: (e) => {
        if (!isTypingTarget(e.target) && sel) closeDetail();
      },
    } satisfies Bindings<typeof DOMAINS_KEYS>,
    overlay === null && !modal,
  );

  return (
    <>
      <ScreenHeader
        title="Domains"
        count={plural(domains.length, "domain")}
        action={canAdd && <PrimaryButton label="Add domain" shortcut="N" onClick={() => app.open({ kind: "addDomain" })} />}
      >
        <div className="chips" role="group" aria-label="Filter domains">
          {FILTERS.map(([v, label]) => (
            <Chip key={v} pressed={filter === v} onClick={() => setFilter(v)}>
              {label}
            </Chip>
          ))}
        </div>
        {admin && waiting > 0 && <span className="note">{waiting} waiting for you</span>}
        <SearchChip q={query.get("q") ?? ""} onClear={() => navigate("/domains")} />
      </ScreenHeader>
      <div className={`body${open ? " open" : ""}${selected ? "" : " solo"}`}>
        <section className="list" aria-label="Domains">
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Status</th>
                <th>Owner</th>
                {admin && <th>Shared with</th>}
                <th className="num">Links</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d, i) => {
                const tag = statusTag(d, admin);
                return (
                  <tr
                    key={d.id}
                    ref={(el) => void (el ? rowRefs.current.set(d.id, el) : rowRefs.current.delete(d.id))}
                    aria-selected={d.id === sel}
                    tabIndex={d.id === sel || (!selected && i === 0) ? 0 : -1}
                    onClick={() => show(d.id) || select(d.id)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && (e.preventDefault(), show(d.id) || select(d.id))}
                  >
                    <td className="short">
                      <span className={`dot2 ${tag.tone}`} aria-hidden="true" />
                      <span className="mchip">
                        <span className="slug">{d.host}</span>
                      </span>
                    </td>
                    <td>{TYPE_LABEL[d.type]}</td>
                    <td>
                      <Tag tone={tag.tone}>{tag.label}</Tag>{d.canUse === false && <> <Tag tone="off">Admin only</Tag></>}
                    </td>
                    <td data-label="Owner">{ownerLabel(d, me, users)}</td>
                    {admin && <td data-label="Shared with">{sharedWith(d, users, me)}</td>}
                    <td className="num" data-label="Links">{d.linkCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && (
            <Empty title="No domains match." text="Try another filter or search, or add a domain.">
              {canAdd && (
                <button type="button" className="btn primary" onClick={() => app.open({ kind: "addDomain" })}>
                  Add a domain
                </button>
              )}
            </Empty>
          )}
        </section>
        {open && <BackBar label="All domains" onBack={back} />}
        {selected && <DomainDetail key={selected.id} domain={selected} onModal={setModal} onClose={closeDetail} />}
      </div>
    </>
  );
}
