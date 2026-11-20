import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Link, type Page } from "../api";
import { errorText } from "../copy";
import { useHotkeys } from "../keys";
import { navigate, useRoute } from "../router";
import { Sheet } from "../shell/Sheet";
import { Chip, Kbd, PrimaryButton, Tag } from "../shell/ui";
import { useApp } from "../state";
import { LinkDetail, type DetailHandle } from "./LinkDetail";
import { creatorLabel, linkState, linksQuery, type LinksFilter } from "./linkView";

const STATUSES = ["all", "active", "scheduled", "expired"] as const;

export function LinksScreen() {
  const app = useApp();
  const { me, domains, users, currentDomainId, linksVersion, overlay } = app;
  const { query } = useRoute();
  const q = query.get("q") ?? "";
  const sel = query.get("sel");
  const [status, setStatus] = useState<LinksFilter["status"]>("all");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<Link[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const generation = useRef(0);
  const detailRef = useRef<DetailHandle>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = useRef(false);

  const scope = useMemo(() => ({ domain: currentDomainId, q, status, mine }), [currentDomainId, q, status, mine]);
  const domainOf = (id: string) => domains.find((d) => d.id === id);
  const host = currentDomainId ? domainOf(currentDomainId)?.host : undefined;

  const fetchPage = useCallback(async (cursor: string | null) => {
    const qs = linksQuery({ ...scope, cursor });
    return api<Page<Link>>("GET", `/api/links${qs ? `?${qs}` : ""}`);
  }, [scope]);

  // New scope or an explicit reload: start over. A stale answer (older generation) is dropped.
  useEffect(() => {
    const g = ++generation.current;
    setLoadError(null);
    fetchPage(null).then(
      (p) => {
        if (g !== generation.current) return;
        setItems(p.items);
        setNext(p.next);
        setLoaded(true);
      },
      (e: unknown) => {
        if (g !== generation.current) return;
        setLoaded(true);
        setLoadError(errorText(e instanceof ApiError ? e.code : "internal"));
      },
    );
  }, [fetchPage, linksVersion]);

  const loadMore = async (): Promise<Link[]> => {
    if (!next) return [];
    const g = generation.current;
    try {
      const p = await fetchPage(next);
      if (g !== generation.current) return [];
      setItems((cur) => [...cur, ...p.items]);
      setNext(p.next);
      return p.items;
    } catch (e) {
      if (g === generation.current) setLoadError(errorText(e instanceof ApiError ? e.code : "internal"));
      return [];
    }
  };

  const select = (id: string | null, focus = false) => {
    focusRow.current = focus;
    const p = new URLSearchParams(location.search);
    if (id) p.set("sel", id);
    else p.delete("sel");
    const s = p.toString();
    navigate(`/links${s ? `?${s}` : ""}`, { replace: true });
  };

  useEffect(() => {
    if (focusRow.current && sel) rowRefs.current.get(sel)?.focus();
    focusRow.current = false;
  }, [sel, items]);

  const at = items.findIndex((l) => l.id === sel);
  const selected = at >= 0 ? items[at]! : null;
  const canEdit = (l: Link) => me.role === "owner" || l.createdBy === me.id || domainOf(l.domainId)?.ownerId === me.id;

  const move = async (step: 1 | -1) => {
    if (items.length === 0) return;
    if (at < 0) return select(items[step === 1 ? 0 : items.length - 1]!.id, true);
    const to = items[at + step];
    if (to) return select(to.id, true);
    if (step === 1 && next) {
      const more = await loadMore();
      if (more[0]) select(more[0].id, true);
    }
  };

  const confirmDelete = async () => {
    if (!selected) return;
    try {
      await api("DELETE", `/api/links/${encodeURIComponent(selected.id)}`);
    } catch (e) {
      setDeleteError(errorText(e instanceof ApiError ? e.code : "internal"));
      return;
    }
    const neighbour = items[at + 1] ?? items[at - 1];
    setItems((cur) => cur.filter((l) => l.id !== selected.id));
    setConfirming(false);
    select(neighbour?.id ?? null);
    app.announce("Deleted. The slug stays locked.");
    app.reloadDomains().catch(() => undefined); // link counts
  };

  useHotkeys(
    {
      j: () => void move(1),
      k: () => void move(-1),
      c: () => detailRef.current?.copy(),
      e: () => detailRef.current?.focusUrl(),
      "shift+d": () => {
        if (selected && canEdit(selected)) {
          setDeleteError(null);
          setConfirming(true);
        }
      },
      n: () => app.open({ kind: "newLink" }),
    },
    overlay === null && !confirming,
  );

  const total = (currentDomainId ? domains.filter((d) => d.id === currentDomainId) : domains).reduce((n, d) => n + d.linkCount, 0);
  const unfiltered = status === "all" && !mine && q === "";
  const now = Math.floor(Date.now() / 1000);

  return (
    <>
      <header className="top">
        <h1>Links</h1>
        <span className="crumb">{host ? `on ${host}` : "on every domain you can see"}</span>
        <button type="button" className="search" onClick={() => app.open({ kind: "palette" })} aria-keyshortcuts="Control+K">
          <span>{q || "Search slugs and destinations"}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <PrimaryButton label="New link" shortcut="N" onClick={() => app.open({ kind: "newLink" })} />
      </header>
      <div className="body">
        <section className="list" aria-label="Links">
          <div className="filters">
            {STATUSES.map((s) => (
              <Chip key={s} pressed={status === s} onClick={() => setStatus(s)}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </Chip>
            ))}
            <Chip pressed={mine} onClick={() => setMine(!mine)}>
              Mine
            </Chip>
            {q && (
              <button type="button" className="btn ghost" onClick={() => navigate("/links")}>
                Clear search
              </button>
            )}
            <span className="count">{unfiltered ? `${total} links` : `${items.length} shown`}</span>
          </div>
          {loadError && (
            <p className="err pad" role="alert">
              {loadError}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Short link</th>
                <th>Goes to</th>
                <th>Rules</th>
                <th>Status</th>
                <th>Created by</th>
              </tr>
            </thead>
            <tbody>
              {items.map((l, i) => {
                const st = linkState(l, domainOf(l.domainId), now);
                const isSel = l.id === sel;
                return (
                  <tr
                    key={l.id}
                    ref={(el) => void (el ? rowRefs.current.set(l.id, el) : rowRefs.current.delete(l.id))}
                    aria-selected={isSel}
                    tabIndex={isSel || (!selected && i === 0) ? 0 : -1}
                    onClick={() => select(l.id)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && select(l.id)}
                  >
                    <td className="short">
                      <span className="host">{domainOf(l.domainId)?.host}/</span>
                      <span className="slug">{l.slug}</span>
                    </td>
                    <td className="dest">{l.url}</td>
                    <td>
                      {(l.startsAt !== null || l.expiresAt !== null) && (
                        <span className="icons" role="img" aria-label="Has a schedule">
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7v5l3 2" />
                          </svg>
                        </span>
                      )}
                    </td>
                    <td>
                      <Tag tone={st.tone}>{st.label}</Tag>
                    </td>
                    <td>{creatorLabel(l.createdBy, me, users)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loaded && items.length === 0 && !loadError && <p className="empty pad">No links here yet.</p>}
          {next && (
            <div className="pad">
              <button type="button" className="btn" onClick={() => void loadMore()}>
                Load more
              </button>
            </div>
          )}
        </section>
        {selected ? (
          <LinkDetail
            key={selected.id}
            ref={detailRef}
            link={selected}
            domain={domainOf(selected.domainId)}
            canEdit={canEdit(selected)}
            onSaved={(l) => setItems((cur) => cur.map((x) => (x.id === l.id ? l : x)))}
            onDelete={() => {
              setDeleteError(null);
              setConfirming(true);
            }}
          />
        ) : (
          <aside className="detail" aria-label="Selected link">
            <p className="empty pad">Select a link to see it here.</p>
          </aside>
        )}
      </div>
      {confirming && selected && (
        <Sheet label="Delete link" onClose={() => setConfirming(false)}>
          <div className="sh-head">
            <h2>Delete link</h2>
          </div>
          <div className="sh-body">
            <p>
              Delete {domainOf(selected.domainId)?.host}/{selected.slug}? Visits go to the domain's not-found page, and the slug stays locked so nobody
              else can take it. Printed QR codes keep failing rather than being taken over.
            </p>
            {deleteError && (
              <p className="err" role="alert">
                {deleteError}
              </p>
            )}
            <div className="actions">
              <button type="button" className="btn primary" autoFocus onClick={() => void confirmDelete()}>
                Delete <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
