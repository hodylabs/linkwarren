import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { api, ApiError, type BulkOp, type Link, type LinkStats, type Page } from "../api";
import { errorText, plural } from "../copy";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { hasUnsaved, UNSAVED } from "../unsaved";
import { navigate, useRoute, withoutQ } from "../router";
import { Sheet, useOpenSheets } from "../shell/Sheet";
import { Chip, Empty, Icon, PrimaryButton, ScreenHeader, SearchChip } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";
import { BackBar, PHONE, useDetailView, useMedia } from "../shell/narrow";
import { BULK_KEYS, BulkBar, type BulkAction } from "./BulkBar";
import { csvName, downloadCsv, shortUrls, toCsv } from "./bulk";
import { BulkSheet, type BulkMode, type BulkRun } from "./BulkSheet";
import { LinkDetail, type DetailHandle } from "./LinkDetail";
import { NewLinkSheet } from "./NewLinkSheet";
import { QrPanel } from "./QrPanel";
import { linkPage } from "../analytics/Breakdowns";
import { shortDate } from "../time";
import { DestText } from "./DestText";
import { needsFullCard } from "./VcardForm";
import { Sparkline } from "./Sparkline";
import { creatorLabel, linkState, linksQuery, type LinksFilter, type StatsLive } from "./linkView";
import { all, EMPTY_SEL, extend, keepOnly, range, toggle, type Sel } from "./selection";

const STATS_CHUNK = 50; // the server takes at most 50 ids per request

const STATUSES = ["all", "active", "scheduled", "expired"] as const;
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 10; // more movement than this is a scroll, not a press

/** A row's schedule chip: the next change, or the last one. */
function when(l: Link, now: number): string {
  if (l.startsAt !== null && l.startsAt > now) return `Starts ${shortDate(l.startsAt)}`;
  if (l.expiresAt !== null) return `${l.expiresAt <= now ? "Ended" : "Ends"} ${shortDate(l.expiresAt)}`;
  return `Started ${shortDate(l.startsAt!)}`;
}

/** Links screen hotkeys and their text on the shortcuts sheet. */
export const LINKS_KEYS = {
  n: "New link",
  j: "Next link",
  k: "Previous link",
  e: "Edit the selected link",
  c: "Copy the short link",
  q: "Show the QR code",
  a: "Open the link's analytics",
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
  // The generation whose first page is on screen (state, so the selected-link read below reruns for every new list), and the
  // id of a link that list shows first only because ?sel= named it past the loaded pages.
  const [listGen, setListGen] = useState(0);
  const extraId = useRef<string | null>(null);
  const deleted = useRef(new Set<string>()); // deleted here: a read still out for one of them never brings it back
  const selRef = useRef<string | null>(null);
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
      extraId.current = null; // a new scope reads the selected link again if it needs to
    }
    lastScope.current = scope;
    setLoadError(null);
    fetchPage(null).then(
      (p) => {
        if (g !== generation.current) return;
        // A same-scope reload keeps the row read by id while it is still selected and off the page, so its panel stays open;
        // the read below then refreshes it (or drops it when the link is gone or no longer visible).
        const keepId = extraId.current === selRef.current && !p.items.some((l) => l.id === extraId.current) ? extraId.current : null;
        if (!keepId) extraId.current = null;
        setItems((cur) => {
          const kept = keepId ? cur.find((l) => l.id === keepId) : undefined;
          return kept ? [kept, ...p.items] : p.items;
        });
        setPicked((s) => keepOnly(s, new Set([...p.items.map((l) => l.id), ...(keepId ? [keepId] : [])])));
        setNext(p.next);
        setLoaded(true);
        setListGen(g);
        void loadStats(g, p.items.map((l) => l.id));
      },
      (e: unknown) => {
        if (g !== generation.current) return;
        setLoaded(true);
        setListGen(g);
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
      // A link read by id (?sel= past the first page) is already listed first: never twice. The rows really added are what
      // the caller gets (J moves to the first of them; a page of nothing new moves nowhere).
      const have = new Set(latest.current.items.map((l) => l.id));
      const added = p.items.filter((x) => !have.has(x.id));
      setItems((cur) => [...cur, ...added.filter((x) => !cur.some((c) => c.id === x.id))]);
      setNext(p.next);
      void loadStats(g, added.map((l) => l.id));
      return added;
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
  // ?sel= naming a link past the loaded pages (a palette pick among many matches): read it by id and list it first, so the jump
  // always lands on its panel. Once per id and list generation: a reload, a filter change or a domain switch reads it again
  // (a kept row is refreshed). A link that is gone or no longer visible to this person is dropped and stays unselected.
  selRef.current = sel;
  const fetchedSel = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !sel) return;
    const listed = items.some((l) => l.id === sel);
    if (listed && extraId.current !== sel) return; // on a page: nothing to read
    const key = `${listGen}:${sel}`;
    if (fetchedSel.current === key) return;
    fetchedSel.current = key;
    const g = generation.current;
    api<Link>("GET", `/api/links/${encodeURIComponent(sel)}`).then(
      (l) => {
        // Only for the selection that asked: a selection moved (or the row deleted, which selects its neighbour) drops the answer.
        if (g !== generation.current || selRef.current !== sel || deleted.current.has(l.id)) return;
        extraId.current = l.id;
        // A row loaded meanwhile at a newer revision (a later page, a save) wins over an older answer.
        setItems((cur) => (cur.some((x) => x.id === l.id) ? cur.map((x) => (x.id === l.id && l.updatedAt >= x.updatedAt ? l : x)) : [l, ...cur]));
        void loadStats(g, [l.id]);
      },
      (e: unknown) => {
        // Only a link that is gone (404) or no longer visible (403) is dropped; a dropped connection keeps what is shown.
        const gone = e instanceof ApiError && (e.status === 404 || e.status === 403);
        if (!gone || g !== generation.current || extraId.current !== sel) return;
        extraId.current = null;
        setItems((cur) => cur.filter((x) => x.id !== sel));
      },
    );
  }, [loaded, sel, items, listGen, loadStats]);
  // A contact card with a photo comes from the list without it (hasPhoto): the detail waits for the single-link read.
  const loadCard = selected && needsFullCard(selected) ? selected.id : null;
  const [cardFailed, setCardFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!loadCard) return;
    let live = true;
    setCardFailed(null);
    api<Link>("GET", `/api/links/${encodeURIComponent(loadCard)}`).then(
      (l) => live && setItems((cur) => cur.map((x) => (x.id === l.id ? l : x))),
      () => live && setCardFailed(loadCard),
    );
    return () => {
      live = false;
    };
  }, [loadCard]);
  // R9: an owner, anyone's with links.editAny, their own with links.create, or any on a domain they own.
  const canEdit = (l: Link) =>
    can(me, "links.editAny") || (l.createdBy === me.id && can(me, "links.create")) || domainOf(l.domainId)?.ownerId === me.id;
  const canCreate = can(me, "links.create");
  const canBulk = can(me, "links.bulk");

  // S12: the panel is a summary. Edit (E) opens the link sheet and QR code (Q) a sheet with the downloads; both are for
  // the selected link only and close if a reload drops it. A card still loading its photo is neither edited nor shown yet,
  // or a save would send the card without its photo.
  const [editing, setEditing] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const startEdit = () => {
    if (selected && loadCard !== selected.id && canEdit(selected) && !selected.forwardTo) setEditing(selected.id);
  };
  const showQr = () => {
    if (selected && loadCard !== selected.id && !selected.forwardTo && domainOf(selected.domainId)) setQrFor(selected.id);
  };
  useEffect(() => {
    if (editing && editing !== selectedId) setEditing(null);
    if (qrFor && qrFor !== selectedId) setQrFor(null);
  }, [editing, qrFor, selectedId]);

  useEffect(() => {
    // A card still loading has no detail panel yet: wait (a failed load keeps qr=1, so a reload tries again).
    // The QR sheet also needs the row's domain, which can load after the links.
    if (!wantQr || !selected || loadCard || !domainOf(selected.domainId)) return;
    showQr();
    // Once only: later selections (J, K, clicks) focus their row, not this panel.
    const p = new URLSearchParams(location.search);
    p.delete("qr");
    navigate(`/links?${p}`, { replace: true });
  }, [wantQr, selectedId, loadCard, domains]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = async (step: 1 | -1) => {
    if (items.length === 0) return;
    if (at < 0) return select(items[step === 1 ? 0 : items.length - 1]!.id, true);
    const to = items[at + step];
    if (to) return select(to.id, true);
    if (step === 1 && next) {
      const more = await loadMore();
      // The form may have become dirty while the page loaded.
      if (hasUnsaved()) return app.announce(UNSAVED);
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
    deleted.current.add(selected.id);
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
  // Without links.bulk nothing can be selected, whatever starts it (X, Shift+click, a long press, Ctrl+A).
  const pick = (next: Sel) => {
    if (!canBulk && next.ids.size > 0) return;
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
    if (op.action === "delete") for (const id of r.ok.keys()) deleted.current.add(id);
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
      j: () => (hasUnsaved() ? app.announce(UNSAVED) : void move(1)),
      k: () => (hasUnsaved() ? app.announce(UNSAVED) : void move(-1)),
      c: () => detailRef.current?.copy(),
      q: showQr,
      e: startEdit,
      a: () => selected && !selected.forwardTo && navigate(linkPage(selected.id)),
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
        if (hasUnsaved()) return app.announce(UNSAVED);
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
        action={canCreate && <PrimaryButton label="New link" shortcut="N" onClick={() => app.open({ kind: "newLink" })} />}
      >
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
        <SearchChip q={q} onClear={() => navigate(withoutQ("/links"), { replace: true })} />
      </ScreenHeader>
      {app.instance && !app.instance.mainDomainId && can(me, "domains.manage") && (
        <div className="callout wait pad" role="status" aria-label="No main domain">
          <p>
            No main domain is set. Add a domain to make short links on, then pick it as the main domain in Settings so new links use it by default.
          </p>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => app.open({ kind: "addDomain" })}>Add a domain</button>
            {can(me, "settings") && <button type="button" className="btn ghost" onClick={() => navigate("/settings/instance")}>Settings</button>}
          </div>
        </div>
      )}
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
                {canBulk && (!phone || picking) && (
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
                <th className="num col-clicks">Clicks, 7 days</th>
              </tr>
            </thead>
            <tbody>
              {items.map((l, i) => {
                const st = linkState(l, domainOf(l.domainId), now);
                const isSel = l.id === sel;
                const short = (
                  <span className="mchip">
                    <span className="host">{domainOf(l.domainId)?.host}/</span>
                    <span className="slug">{l.slug}</span>
                  </span>
                );
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
                    {canBulk && (!phone || picking) && (
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
                    {/* S12: one cell for the link, its state and who made it; only a state that is not Active is written out. */}
                    <td className="short">
                      <div className="two">
                        <span className={`dot2 ${st.tone}`} aria-hidden="true" />
                        <div className="t">
                          {/* S12: a named link reads by its name; its short link moves to the second line. Unnamed rows are unchanged. */}
                          {l.name ? <span className="lname">{l.name}</span> : short}
                          <small>
                            {st.tone === "ok" ? <span className="sr-only">{st.label}. </span> : <><span className={`st-${st.tone}`}>{st.label}</span>, </>}
                            {l.name && <>{short}, </>}
                            {creatorLabel(l.createdBy, me, users)}, {shortDate(l.createdAt)}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td className="dest">
                      {l.forwardTo ? <span className="fact"><Icon name="fwd" />Forwards</span> : <DestText url={l.url} link={l} />}
                    </td>
                    <td>
                      {(l.startsAt !== null || l.expiresAt !== null || l.hasPassword || l.routes.length > 0) && (
                        <span className="icons">
                          {(l.startsAt !== null || l.expiresAt !== null) && <span className="fact"><Icon name="clock" />{when(l, now)}</span>}
                          {l.hasPassword && <span className="fact"><Icon name="lock" />Password</span>}
                          {l.routes.length > 0 && <span className="fact"><Icon name="route" />{plural(l.routes.length, "route")}</span>}
                        </span>
                      )}
                    </td>
                    <td className="num spk col-clicks" data-label="7 days">
                      {stats[l.id] && !l.forwardTo && (
                        <div className="sp">
                          <Sparkline days={stats[l.id]!.days} clicks={stats[l.id]!.clicks} active={st.tone === "ok"} live={stats[l.id]!.live} />
                          <span aria-hidden="true">{stats[l.id]!.clicks.toLocaleString("en-US")}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loaded && items.length === 0 && !loadError &&
            (unfiltered ? (
              <Empty title="No links here yet." text="Short links you make show up here, newest first.">
                {canCreate && (
                  <button type="button" className="btn primary" onClick={() => app.open({ kind: "newLink" })}>
                    Create a link
                  </button>
                )}
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
        {selected && loadCard === selected.id && (
          <aside className="detail" aria-label="Selected link">
            <p className="hint" role="status">
              {cardFailed === selected.id ? "The contact card could not be loaded. Reload the page to try again." : "Loading the contact card..."}
            </p>
          </aside>
        )}
        {selected && loadCard !== selected.id && (
          <LinkDetail
            key={selected.id}
            ref={detailRef}
            link={selected}
            stats={stats[selected.id]}
            live={stats[selected.id]?.live ?? "ok"}
            domain={domainOf(selected.domainId)}
            canEdit={canEdit(selected)}
            onEdit={startEdit}
            onQr={showQr}
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
      {editing && selected?.id === editing && loadCard !== selected.id && (
        <NewLinkSheet link={selected} onSaved={(l) => setItems((cur) => cur.map((x) => (x.id === l.id ? l : x)))} onClose={() => setEditing(null)} />
      )}
      {qrFor && selected?.id === qrFor && domainOf(selected.domainId) && (
        <Sheet label="QR code" onClose={() => setQrFor(null)}>
          <div className="sh-head">
            <h2>QR code</h2>
            <span className="x">
              <kbd>Esc</kbd> close
            </span>
          </div>
          <div className="sh-body">
            <QrPanel host={domainOf(selected.domainId)!.host} slug={selected.slug} />
          </div>
        </Sheet>
      )}
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
              <button type="button" className="btn danger solid" autoFocus onClick={() => void confirmDelete()}>
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
