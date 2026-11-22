import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Link, type LinkStats, type Page } from "../api";
import { errorText, plural } from "../copy";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { Sheet } from "../shell/Sheet";
import { Chip, Empty, PrimaryButton, ScreenHeader, SearchButton, Tag } from "../shell/ui";
import { useApp } from "../state";
import { BackBar, useDetailView } from "../shell/narrow";
import { LinkDetail, type DetailHandle } from "./LinkDetail";
import { Sparkline } from "./Sparkline";
import { creatorLabel, linkState, linksQuery, type LinksFilter, type StatsLive } from "./linkView";

const STATS_CHUNK = 50; // the server takes at most 50 ids per request

const STATUSES = ["all", "active", "scheduled", "expired"] as const;

/** Links screen hotkeys and their text on the shortcuts sheet. */
export const LINKS_KEYS = {
  n: "New link",
  j: "Next link",
  k: "Previous link",
  e: "Edit the selected link",
  c: "Copy the short link",
  "shift+d": "Delete the selected link",
  escape: "Clear the selection",
} as const;

export function LinksScreen() {
  const app = useApp();
  const { me, domains, users, currentDomainId, linksVersion, overlay } = app;
  const { query } = useRoute();
  const q = query.get("q") ?? "";
  const sel = query.get("sel");
  const { open, show, back } = useDetailView("/links");
  const [status, setStatus] = useState<LinksFilter["status"]>("all");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<Link[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Each link keeps the live state of the response that carried it, so one page never changes another page's cells.
  const [stats, setStats] = useState<Record<string, LinkStats & { live: StatsLive }>>({});
  const generation = useRef(0);
  const loading = useRef(false); // a next-page request is in flight
  const deleting = useRef(false);
  const lastScope = useRef<unknown>(null);
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

  // 7-day stats for a page of ids. An answer from an older generation (the list changed meanwhile) is dropped; a failure leaves the cells empty.
  const loadStats = useCallback(async (g: number, ids: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += STATS_CHUNK) chunks.push(ids.slice(i, i + STATS_CHUNK));
    const done = await Promise.allSettled(
      chunks.map((c) => api<{ items: LinkStats[]; live: StatsLive }>("GET", `/api/analytics/links?ids=${c.map(encodeURIComponent).join(",")}`)),
    );
    if (g !== generation.current) return;
    const ok = done.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length === 0) return;
    setStats((cur) => ({ ...cur, ...Object.fromEntries(ok.flatMap((r) => r.items.map((s) => [s.linkId, { ...s, live: r.live }] as const))) }));
  }, []);

  // New scope or an explicit reload: start over. A stale answer (older generation) is dropped.
  useEffect(() => {
    const g = ++generation.current;
    loading.current = false;
    // The cursor belongs to the old scope: drop it now, and the rows too when the scope itself changed.
    setNext(null);
    setStats({}); // a reload (same scope too) may change clicks, expiry or the live state: never show the old numbers
    if (lastScope.current !== scope) {
      setItems([]);
      setLoaded(false); // no "No links here yet." flash while the new scope loads
    }
    lastScope.current = scope;
    setLoadError(null);
    fetchPage(null).then(
      (p) => {
        if (g !== generation.current) return;
        setItems(p.items);
        setNext(p.next);
        setLoaded(true);
        void loadStats(g, p.items.map((l) => l.id));
      },
      (e: unknown) => {
        if (g !== generation.current) return;
        setLoaded(true);
        setLoadError(errorText(e instanceof ApiError ? e.code : "internal"));
      },
    );
  }, [fetchPage, scope, linksVersion, loadStats]);

  const loadMore = async (): Promise<Link[]> => {
    if (!next || loading.current) return [];
    const g = generation.current;
    loading.current = true;
    try {
      const p = await fetchPage(next);
      if (g !== generation.current) return [];
      setItems((cur) => [...cur, ...p.items]);
      setNext(p.next);
      void loadStats(g, p.items.map((l) => l.id));
      return p.items;
    } catch (e) {
      if (g === generation.current) setLoadError(errorText(e instanceof ApiError ? e.code : "internal"));
      return [];
    } finally {
      if (g === generation.current) loading.current = false;
    }
  };

  const select = (id: string | null, focus = false) => {
    focusRow.current = focus;
    const p = new URLSearchParams(location.search);
    if (id) p.set("sel", id);
    else {
      p.delete("sel");
      p.delete("view"); // nothing selected: no detail view either
    }
    const s = p.toString();
    navigate(`/links${s ? `?${s}` : ""}`, { replace: true });
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
    if (!selected || deleting.current) return;
    deleting.current = true;
    try {
      await api("DELETE", `/api/links/${encodeURIComponent(selected.id)}`);
    } catch (e) {
      setDeleteError(errorText(e instanceof ApiError ? e.code : "internal"));
      return;
    } finally {
      deleting.current = false;
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
      escape: (e) => {
        if (!isTypingTarget(e.target) && sel) closeDetail();
      },
    } satisfies Bindings<typeof LINKS_KEYS>,
    overlay === null && !confirming,
  );

  const total = (currentDomainId ? domains.filter((d) => d.id === currentDomainId) : domains).reduce((n, d) => n + d.linkCount, 0);
  const unfiltered = status === "all" && !mine && q === "";
  const now = Math.floor(Date.now() / 1000);

  return (
    <>
      <ScreenHeader
        title="Links"
        count={unfiltered ? plural(total, "link") : `${items.length} shown`}
        text={`Short links ${host ? `on ${host}` : "on every domain you can see"}. Pick one to edit its destination, schedule and rules.`}
      >
        <SearchButton q={q} placeholder="Search slugs and destinations" onOpen={() => app.open({ kind: "palette" })} />
        <div className="chips" role="group" aria-label="Filter links">
          {STATUSES.map((s) => (
            <Chip key={s} pressed={status === s} onClick={() => setStatus(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </Chip>
          ))}
          <Chip pressed={mine} onClick={() => setMine(!mine)}>
            Mine
          </Chip>
        </div>
        {q && (
          <button type="button" className="btn ghost" onClick={() => navigate("/links")}>
            Clear search
          </button>
        )}
        <PrimaryButton label="New link" shortcut="N" onClick={() => app.open({ kind: "newLink" })} />
      </ScreenHeader>
      <div className={`body${open ? " open" : ""}${selected ? "" : " solo"}`}>
        <section className="list" aria-label="Links">
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
                <th className="num">7 days</th>
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
                    onClick={() => show(l.id) || select(l.id)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && (e.preventDefault(), show(l.id) || select(l.id))}
                  >
                    <td className="short">
                      <span className={`dot2 ${st.tone}`} aria-hidden="true" />
                      <span className="mchip">
                        <span className="host">{domainOf(l.domainId)?.host}/</span>
                        <span className="slug">{l.slug}</span>
                      </span>
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
                    <td className="num spk" data-label="7 days">
                      {stats[l.id] && <Sparkline days={stats[l.id]!.days} clicks={stats[l.id]!.clicks} active={st.tone === "ok"} live={stats[l.id]!.live} />}
                    </td>
                    <td data-label="By">{creatorLabel(l.createdBy, me, users)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loaded && items.length === 0 && !loadError &&
            (unfiltered ? (
              <Empty title="No links here yet." text="Short links you make show up here, newest first.">
                <button type="button" className="btn primary" onClick={() => app.open({ kind: "newLink" })}>
                  Create a link
                </button>
              </Empty>
            ) : (
              <Empty title="No links match." text="Try another filter, or clear the search." />
            ))}
          {next && (
            <div className="pad">
              <button type="button" className="btn" onClick={() => void loadMore()}>
                Load more
              </button>
            </div>
          )}
        </section>
        {open && <BackBar label="All links" onBack={back} />}
        {selected && (
          <LinkDetail
            key={selected.id}
            ref={detailRef}
            link={selected}
            stats={stats[selected.id]}
            live={stats[selected.id]?.live ?? "ok"}
            domain={domainOf(selected.domainId)}
            canEdit={canEdit(selected)}
            onSaved={(l) => setItems((cur) => cur.map((x) => (x.id === l.id ? l : x)))}
            onClose={closeDetail}
            onDelete={() => {
              setDeleteError(null);
              setConfirming(true);
            }}
          />
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
