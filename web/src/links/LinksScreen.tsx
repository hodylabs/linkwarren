import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { api, ApiError, type BulkOp, type Link, type LinkStats, type Page } from "../api";
import { errorText, plural } from "../copy";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { Sheet, useOpenSheets } from "../shell/Sheet";
import { Chip, Empty, PrimaryButton, ScreenHeader, SearchButton, Tag } from "../shell/ui";
import { useApp } from "../state";
import { BackBar, PHONE, useDetailView, useMedia } from "../shell/narrow";
import { BULK_KEYS, BulkBar, type BulkAction } from "./BulkBar";
import { csvName, downloadCsv, shortUrls, toCsv } from "./bulk";
import { BulkSheet, type BulkMode, type BulkRun } from "./BulkSheet";
import { LinkDetail, type DetailHandle } from "./LinkDetail";
import { Sparkline } from "./Sparkline";
import { creatorLabel, linkState, linksQuery, type LinksFilter, type StatsLive } from "./linkView";
import { all, EMPTY_SEL, extend, keepOnly, range, toggle, type Sel } from "./selection";

const STATS_CHUNK = 50; // the server takes at most 50 ids per request

const STATUSES = ["all", "active", "scheduled", "expired"] as const;
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 10; // more movement than this is a scroll, not a press

/** Links screen hotkeys and their text on the shortcuts sheet. */
export const LINKS_KEYS = {
  n: "New link",
  j: "Next link",
  k: "Previous link",
  e: "Edit the selected link",
  c: "Copy the short link",
  q: "Focus the QR code download",
  "shift+d": "Delete the selected link",
  x: "Select or unselect the link",
  "shift+j": "Extend the selection down",
  "shift+k": "Extend the selection up",
  "mod+a": "Select every loaded link",
  escape: "Clear the selection, then close the link",
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
  const phone = useMedia(PHONE);
  const sheets = useOpenSheets();
  // Many-link selection (R12: loaded rows only, cleared on a scope change). Separate from `sel`, the row the detail shows.
  const [picked, setPicked] = useState<Sel>(EMPTY_SEL);
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const press = useRef<{ x: number; y: number; t: number } | null>(null); // a touch held on a row
  const pressed = useRef(false); // a long-press just fired: swallow the click that ends it

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
      setPicked(EMPTY_SEL);
      setItems([]);
      setLoaded(false); // no "No links here yet." flash while the new scope loads
    }
    lastScope.current = scope;
    setLoadError(null);
    fetchPage(null).then(
      (p) => {
        if (g !== generation.current) return;
        setItems(p.items);
        setPicked((s) => keepOnly(s, new Set(p.items.map((l) => l.id))));
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

  const wantQr = query.get("qr") === "1"; // after create: land on the QR download
  const at = items.findIndex((l) => l.id === sel);
  const selected = at >= 0 ? items[at]! : null;
  const selectedId = selected?.id ?? null;
  const canEdit = (l: Link) => me.role === "owner" || l.createdBy === me.id || domainOf(l.domainId)?.ownerId === me.id;

  useEffect(() => {
    if (!wantQr || !selectedId) return;
    detailRef.current?.focusQr();
    // Once only: later selections (J, K, clicks) focus their row, not this panel.
    const p = new URLSearchParams(location.search);
    p.delete("qr");
    navigate(`/links?${p}`, { replace: true });
  }, [wantQr, selectedId]);

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
    setPicked((s) => keepOnly(s, new Set(order.filter((id) => id !== selected.id))));
    setConfirming(false);
    select(neighbour?.id ?? null);
    app.announce("Deleted. The slug stays locked.");
    app.reloadDomains().catch(() => undefined); // link counts
  };

  const order = items.map((l) => l.id);
  const pickedLinks = items.filter((l) => picked.ids.has(l.id));
  const latest = useRef({ picked, items });
  latest.current = { picked, items };
  // Every change the person makes goes through here, so the count is announced (the bar's text is not a live region).
  const pick = (next: Sel) => {
    setPicked(next);
    const n = latest.current.items.filter((l) => next.ids.has(l.id)).length;
    app.announce(n > 0 ? `${n} selected` : "Selection cleared");
  };
  const clearPick = () => {
    pick(EMPTY_SEL);
    rowRefs.current.get(cursor() ?? order[0] ?? "")?.focus(); // focus stays on the list, not on the removed bar
  };
  const picking = pickedLinks.length > 0;
  const allPicked = picking && pickedLinks.length === items.length;
  // The row X and Shift+J/K act on: the focused row, else the detail's row.
  const cursor = () => [...rowRefs.current].find(([, el]) => el.contains(document.activeElement))?.[0] ?? selectedId;
  const extendBy = (step: 1 | -1) => {
    const r = extend(picked, order, cursor() ?? "", step);
    pick(r.sel);
    select(r.cursor, true);
  };

  const hostOf = (domainId: string) => domainOf(domainId)?.host ?? "";
  const onAction = (a: BulkAction) => {
    if (a === "export") {
      downloadCsv(toCsv(pickedLinks, hostOf, (id) => creatorLabel(id, me, users)), csvName());
      return app.announce(`Exported ${plural(pickedLinks.length, "link")}`);
    }
    if (a !== "copy") return setBulk(a);
    const text = shortUrls(pickedLinks, hostOf);
    if (!text) return app.announce("Cannot copy: these links' domains are unknown");
    // A missing clipboard (plain http) throws; the promise turns that into "Could not copy".
    Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(
      () => app.announce(`Copied ${plural(text ? text.split("\n").length : 0, "short link")}`),
      () => app.announce("Could not copy"),
    );
  };

  // After a run: changed rows patched (a copy leaves its source as it was), deleted rows removed, and the selection becomes the
  // failed links that are still loaded (R12), so Retry or another action works on exactly those.
  const afterRun = (op: BulkOp, r: BulkRun) => {
    const copy = op.action === "move" && op.oldAddress === "copy";
    // The rows as they are now (a page may have loaded during the run), never the ones from when the sheet opened.
    const left = latest.current.items.flatMap((l) => {
      if (!r.ok.has(l.id)) return [l];
      if (op.action === "delete") return [];
      const fresh = r.ok.get(l.id);
      return [fresh && !copy ? fresh : l];
    });
    setItems(left);
    const loadedIds = new Set(left.map((l) => l.id));
    setPicked({ ids: new Set([...r.failed.keys()].filter((id) => loadedIds.has(id))), anchor: null });
    app.reloadDomains().catch(() => undefined); // link counts
    // A move adds rows the list does not hold (copies, forwarders) or takes them out of this scope; a dropped connection leaves
    // the outcome unknown. Reload the current scope; the reload keeps the selection to loaded ids.
    // A schedule change under a status filter may take rows out of it (End now under Active) or bring others in.
    if ((op.action === "move" && r.ok.size > 0) || (op.action === "schedule" && r.ok.size > 0 && status !== "all") || r.stop === "lost_connection") app.bumpLinks();
    app.announce(`${plural(r.ok.size, "link")} changed, ${r.failed.size} not changed`);
  };

  const endPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  useEffect(() => endPress, []);
  // Phones: a still 500 ms press starts selection mode with that row.
  const startPress = (id: string, e: PointerEvent) => {
    pressed.current = false;
    endPress();
    // A hold on the checkbox is left to the checkbox's own click, or the press would add the row and the click undo it.
    if (!phone || (e.target as HTMLElement).closest(".pick")) return;
    const t = window.setTimeout(() => {
      press.current = null;
      pressed.current = true;
      // Rows stay text-selectable outside selection mode (copying a destination): drop any text the hold selected.
      window.getSelection()?.removeAllRanges();
      const s = latest.current.picked;
      if (!s.ids.has(id)) pick(toggle(s, id));
    }, LONG_PRESS_MS);
    press.current = { x: e.clientX, y: e.clientY, t };
  };
  const movePress = (e: PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) endPress();
  };
  const rowClick = (id: string, e: MouseEvent) => {
    if (pressed.current) return void (pressed.current = false);
    if (e.shiftKey) return pick(range(picked, order, id));
    if (phone && picking) return pick(toggle(picked, id));
    show(id) || select(id);
  };

  const bulkKeys = {
    "shift+d": () => onAction("delete"),
    s: () => onAction("schedule"),
    m: () => onAction("move"),
    r: () => onAction("redirect"),
    p: () => onAction("password"),
    c: () => onAction("copy"),
    "shift+e": () => onAction("export"),
  } satisfies Bindings<typeof BULK_KEYS>;
  const linkKeys = {
      j: () => void move(1),
      k: () => void move(-1),
      c: () => detailRef.current?.copy(),
      q: () => detailRef.current?.focusQr(),
      e: () => detailRef.current?.focusUrl(),
      "shift+d": () => {
        if (selected && canEdit(selected)) {
          setDeleteError(null);
          setConfirming(true);
        }
      },
      n: () => app.open({ kind: "newLink" }),
      x: () => {
        const id = cursor();
        if (id) pick(toggle(picked, id));
      },
      "shift+j": () => extendBy(1),
      "shift+k": () => extendBy(-1),
      "mod+a": () => pick(all(order)),
      escape: (e) => {
        if (isTypingTarget(e.target)) return;
        if (open || !picking) {
          if (sel) closeDetail(); // the pushed detail first: the selection behind it is not on screen
        } else clearPick();
      },
    } satisfies Bindings<typeof LINKS_KEYS>;
  // While links are selected C and Shift+D act on all of them.
  useHotkeys(picking ? { ...linkKeys, ...bulkKeys } : linkKeys, overlay === null && sheets === 0);

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
      {picking && !open && (
        <BulkBar count={pickedLinks.length} cannot={pickedLinks.filter((l) => !canEdit(l)).length} onAction={onAction} onClear={clearPick} />
      )}
      <div className={`body${open ? " open" : ""}${selected ? "" : " solo"}`}>
        <section className={`list${picking ? " picking" : ""}`} aria-label="Links">
          {loadError && (
            <p className="err pad" role="alert">
              {loadError}
            </p>
          )}
          <table>
            <thead>
              <tr>
                {(!phone || picking) && (
                  <th className="pick">
                    <input
                      type="checkbox"
                      aria-label="Select every loaded link"
                      checked={allPicked}
                      tabIndex={phone ? -1 : 0} // the phone header row is visually hidden
                      ref={(el) => void (el && (el.indeterminate = picking && !allPicked))}
                      onChange={() => pick(allPicked ? EMPTY_SEL : all(order))}
                    />
                  </th>
                )}
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
                    onClick={(e) => rowClick(l.id, e)}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()} // Shift+click picks a range, never a text selection
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && (e.preventDefault(), show(l.id) || select(l.id))}
                    onPointerDown={(e) => startPress(l.id, e)}
                    onPointerMove={movePress}
                    onPointerUp={endPress}
                    onPointerCancel={endPress}
                    onContextMenu={(e) => phone && e.preventDefault()}
                  >
                    {(!phone || picking) && (
                      <td className="pick">
                        <input
                          type="checkbox"
                          aria-label={`Select ${domainOf(l.domainId) ? `${domainOf(l.domainId)!.host}/` : ""}${l.slug}`}
                          checked={picked.ids.has(l.id)}
                          tabIndex={-1} // the row is the Tab stop (roving tabindex); X and clicks toggle
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => pick((e.nativeEvent as globalThis.MouseEvent).shiftKey ? range(picked, order, l.id) : toggle(picked, l.id))}
                        />
                      </td>
                    )}
                    <td className="short">
                      <span className={`dot2 ${st.tone}`} aria-hidden="true" />
                      <span className="mchip">
                        <span className="host">{domainOf(l.domainId)?.host}/</span>
                        <span className="slug">{l.slug}</span>
                      </span>
                    </td>
                    <td className="dest">{l.url}</td>
                    <td>
                      {(l.forwardTo || l.startsAt !== null || l.expiresAt !== null || l.hasPassword || l.routes.length > 0) && (
                        <span className="icons">
                          {l.forwardTo && (
                            <svg role="img" aria-label="Forwards to another link" viewBox="0 0 24 24">
                              <path d="M4 12h14M13 6l6 6-6 6" />
                            </svg>
                          )}
                          {(l.startsAt !== null || l.expiresAt !== null) && (
                            <svg role="img" aria-label="Has a schedule" viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="9" />
                              <path d="M12 7v5l3 2" />
                            </svg>
                          )}
                          {l.hasPassword && (
                            <svg role="img" aria-label="Password" viewBox="0 0 24 24">
                              <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />
                            </svg>
                          )}
                          {l.routes.length > 0 && (
                            <svg role="img" aria-label="Country and device routing" viewBox="0 0 24 24">
                              <path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
                            </svg>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      <Tag tone={st.tone}>{st.label}</Tag>
                    </td>
                    <td className="num spk" data-label="7 days">
                      {stats[l.id] && !l.forwardTo && <Sparkline days={stats[l.id]!.days} clicks={stats[l.id]!.clicks} active={st.tone === "ok"} live={stats[l.id]!.live} />}
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
            onOpenTarget={() => {
              const to = selected.forwardTo;
              if (to && items.some((x) => x.id === to)) select(to, true);
              else navigate(`/links?q=${encodeURIComponent(selected.url.slice(selected.url.lastIndexOf("/") + 1))}`);
            }}
            onClose={closeDetail}
            onDelete={() => {
              setDeleteError(null);
              setConfirming(true);
            }}
          />
        )}
      </div>
      {bulk && <BulkSheet mode={bulk} links={pickedLinks} onRun={afterRun} onClose={() => setBulk(null)} />}
      {confirming && selected && (
        <Sheet label="Delete link" onClose={() => setConfirming(false)}>
          <div className="sh-head">
            <h2>Delete link</h2>
          </div>
          <div className="sh-body">
            <p>
              Delete {domainOf(selected.domainId)?.host}/{selected.slug}? Visits go to the domain's not-found page, and the slug stays locked so nobody
              else can take it. Printed QR codes keep failing rather than being taken over. Old addresses that forward to it are deleted and locked
              too.
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
