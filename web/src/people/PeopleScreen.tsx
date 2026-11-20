import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AuditItem, type Page, type UserItem } from "../api";
import { errorText } from "../copy";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { Chip, Kbd, Tag } from "../shell/ui";
import { useApp } from "../state";
import { clock } from "../time";
import { describeAudit } from "./auditText";

const FILTERS = ["everyone", "invited", "disabled"] as const;

/** People screen hotkeys and their text on the shortcuts sheet. */
export const PEOPLE_KEYS = {
  j: "Next person",
  k: "Previous person",
  escape: "Clear the selected person",
} as const;
const KINDS = [
  ["all", "All"],
  ["via", "Via agents"],
  ["domain", "Domains"],
  ["user", "People"],
  ["link", "Links"],
] as const;
type Kind = (typeof KINDS)[number][0];

const label = (u: UserItem) => u.name || u.email;
const initials = (u: UserItem) => (u.status === "invited" ? "?" : (u.name ?? u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join(""));

function domainsCell(u: UserItem, total: number): string {
  if (u.role === "owner") return `All ${total}`;
  const hosts = u.domains.filter((d) => d.via === "member").map((d) => d.host);
  const own = u.domains.filter((d) => d.via === "owner").length;
  const parts = [...hosts, ...(own ? [`${own} own`] : [])];
  return parts.length ? parts.join(", ") : "Main only";
}

function auditQuery(actor: string | null, kind: Kind, cursor: string | null): string {
  const p = new URLSearchParams();
  if (actor) p.set("actor", actor);
  if (kind === "via") p.set("via", "present");
  else if (kind !== "all") p.set("target", kind);
  if (cursor) p.set("cursor", cursor); // an empty cursor is omitted, the server rejects it
  const s = p.toString();
  return `/api/audit${s ? `?${s}` : ""}`;
}

export function PeopleScreen() {
  const app = useApp();
  // Link counts change on other screens; refresh them each time People opens.
  useEffect(() => { app.reloadUsers().catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { me, users, domains, overlay } = app;
  const { query } = useRoute();
  const q = (query.get("q") ?? "").toLowerCase();
  const sel = query.get("sel");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("everyone");
  const [kind, setKind] = useState<Kind>("all");
  const [items, setItems] = useState<AuditItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loading = useRef(false); // a next-page request is in flight
  const lastScope = useRef<unknown>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = useRef(false);

  const all = users ?? [];
  const list = useMemo(
    () =>
      all.filter(
        (u) => (filter === "everyone" || u.status === filter) && (q === "" || label(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
      ),
    [all, filter, q],
  );
  const selected = all.find((u) => u.id === sel) ?? null;
  const actor = selected?.id ?? null;
  const pending = all.filter((u) => u.status === "invited").length;
  const at = list.findIndex((u) => u.id === sel);

  const scope = useMemo(() => ({ actor, kind }), [actor, kind]);

  // New scope: start over with the first page. A stale answer (older generation) is dropped.
  useEffect(() => {
    const g = ++generation.current;
    loading.current = false;
    setNext(null);
    if (lastScope.current !== scope) {
      setItems([]);
      setLoaded(false);
    }
    lastScope.current = scope;
    setError(null);
    api<Page<AuditItem>>("GET", auditQuery(scope.actor, scope.kind, null)).then(
      (p) => {
        if (g !== generation.current) return;
        setItems(p.items);
        setNext(p.next);
        setLoaded(true);
      },
      (e: unknown) => {
        if (g !== generation.current) return;
        setLoaded(true);
        setError(errorText(e instanceof ApiError ? e.code : "internal"));
      },
    );
  }, [scope]);

  const loadMore = useCallback(async () => {
    if (!next || loading.current) return;
    const g = generation.current;
    loading.current = true;
    try {
      const p = await api<Page<AuditItem>>("GET", auditQuery(scope.actor, scope.kind, next));
      if (g !== generation.current) return;
      setItems((cur) => [...cur, ...p.items]);
      setNext(p.next);
      setError(null);
    } catch (e) {
      if (g === generation.current) setError(errorText(e instanceof ApiError ? e.code : "internal"));
    } finally {
      if (g === generation.current) loading.current = false;
    }
  }, [next, scope]);

  const select = (id: string | null, focus = false) => {
    focusRow.current = focus;
    const p = new URLSearchParams(location.search);
    if (id) p.set("sel", id);
    else p.delete("sel");
    const s = p.toString();
    navigate(`/people${s ? `?${s}` : ""}`, { replace: true });
  };
  useEffect(() => {
    if (focusRow.current && sel) rowRefs.current.get(sel)?.focus();
    focusRow.current = false;
  }, [sel, list]);

  const move = (step: 1 | -1) => {
    if (list.length === 0) return;
    const to = at < 0 ? list[step === 1 ? 0 : list.length - 1] : list[at + step];
    if (to) select(to.id, true);
  };

  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      escape: (e) => {
        if (isTypingTarget(e.target)) return;
        if (sel) select(null);
      },
    } satisfies Bindings<typeof PEOPLE_KEYS>,
    overlay === null,
  );

  return (
    <>
      <header className="top">
        <h1>People &amp; audit log</h1>
        <span className="crumb">Owner only</span>
        <button type="button" className="search" onClick={() => app.open({ kind: "palette" })} aria-keyshortcuts="Control+K">
          <span>{q || "Search people and activity"}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
      </header>
      <div className="body people">
        <section className="list" aria-label="People">
          <div className="filters">
            {FILTERS.map((f) => (
              <Chip key={f} pressed={filter === f} onClick={() => setFilter(f)}>
                {f[0]!.toUpperCase() + f.slice(1)}
              </Chip>
            ))}
            <span className="count">
              {all.length - pending} people, {pending} {pending === 1 ? "invite" : "invites"} pending
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Domains</th>
                <th className="num">Links</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u, i) => (
                <tr
                  key={u.id}
                  ref={(el) => void (el ? rowRefs.current.set(u.id, el) : rowRefs.current.delete(u.id))}
                  aria-selected={u.id === sel}
                  tabIndex={u.id === sel || (at < 0 && i === 0) ? 0 : -1}
                  onClick={() => select(u.id)}
                  onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && select(u.id)}
                >
                  <td>
                    <span className={u.id === me.id ? "who me" : "who"}>
                      <span className={u.status === "invited" ? "avatar plain" : "avatar"} aria-hidden="true">
                        {initials(u)}
                      </span>
                      {u.id === me.id ? "You" : label(u)}
                    </span>
                  </td>
                  <td>
                    {u.role === "owner" ? "Owner" : "Member"}{" "}
                    {u.status === "invited" && <Tag tone="wait">Invited</Tag>}
                    {u.status === "disabled" && <Tag tone="off">Disabled</Tag>}
                  </td>
                  <td>{domainsCell(u, domains.length)}</td>
                  <td className="num">{u.linkCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {users !== null && list.length === 0 && <p className="empty pad">No people match.</p>}
        </section>
        <aside className="detail" aria-label="Audit log">
          <div className="d-head">
            <div className="title">Activity across every domain</div>
            <div className="row">
              {KINDS.map(([k, text]) => (
                <Chip key={k} pressed={kind === k} onClick={() => setKind(k)}>
                  {text}
                </Chip>
              ))}
              {selected && (
                <span className="chip only">
                  Only {label(selected)}
                  <button type="button" className="btn ghost" aria-label="Clear person filter" onClick={() => select(null)}>
                    ×
                  </button>
                </span>
              )}
            </div>
          </div>
          {error && (
            <p className="err pad" role="alert">
              {error}
            </p>
          )}
          <ul className="log">
            {items.map((a) => {
              const d = describeAudit(a, me.id, domains);
              return (
                <li key={a.id}>
                  <time dateTime={new Date(a.at * 1000).toISOString()}>{clock(a.at)}</time>
                  <div>
                    <b>{d.who}</b>
                    {d.via && <> <span className="via">{d.via}</span></>} {d.text}
                    {d.code && <> <code>{d.code}</code></>}
                    {d.suffix}
                  </div>
                </li>
              );
            })}
          </ul>
          {loaded && items.length === 0 && !error && <p className="empty pad">No activity matches.</p>}
          {next && (
            <div className="pad">
              <button type="button" className="btn" onClick={() => void loadMore()}>
                Load more
              </button>
            </div>
          )}
          <div className="foot">
            <span>Every change, by every person and agent</span>
          </div>
        </aside>
      </div>
    </>
  );
}
