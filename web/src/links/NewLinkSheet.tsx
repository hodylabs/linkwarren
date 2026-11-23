import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Domain, type Link, type Route } from "../api";
import { errorText } from "../copy";
import { rebase } from "../draft";
import { useUnsaved } from "../unsaved";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { Sheet } from "../shell/Sheet";
import { Icon, Seg, Switch } from "../shell/ui";
import { can, canUseDomain, mayOpen } from "../perms";
import { useApp } from "../state";
import { fromLocalInput, toLocalInput } from "../time";
import { checkDestination, checkSlugShape } from "../../../src/validate";
import { checkVcard, emptyVcard, type VCard } from "../../../src/vcard";
import { cleanVcard, formField, fullCard, VcardForm } from "./VcardForm";
import { readUtm, suggestSlugs, withUtm, type Utm } from "./compose";
import { shortUrl } from "./linkView";
import { parseCountries, passwordProblem, routeSummary } from "./rules";
import { RoutesEditor } from "./RoutesEditor";

type Check = { status: "available" | "taken" | "locked" | "reserved" } | { status: "invalid"; reason: string };
type Field = "url" | "slug" | "schedule" | "password" | "form";
const SLUG_CODES = new Set(["taken", "locked", "reserved", "empty", "slug_too_long", "charset", "leading_dot", "too_long"]);
const URL_CODES = new Set(["not_url", "scheme", "userinfo", "url_too_long", "loop", "too_long", "bad_tel", "bad_mailto"]);
const fieldOf = (code: string): Field => (code === "bad_window" ? "schedule" : code.startsWith("password_") ? "password" : SLUG_CODES.has(code) ? "slug" : URL_CODES.has(code) ? "url" : "form");
const DEBOUNCE_MS = 250;

/** New and edit link sheet hotkeys and their text on the shortcuts sheet (the rule keys T S P R Q only outside text boxes). */
export const NEW_LINK_KEYS = {
  "mod+enter": "Create the link, or save the edit",
  "mod+shift+enter": "Create and copy the short link",
  "alt+d": "Change the domain",
  t: "Campaign tags",
  s: "Schedule and expiry",
  p: "Password",
  r: "Country and device routing",
  q: "QR code after creating",
} as const;
const blank = (r: Route) => !r.countries.length && !r.devices.length && !r.url.trim();
const NEW_ROUTE: Route = { countries: [], devices: [], url: "" };

const isUrl = (s: string) => {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
};

/** Everything the form edits. `passwordOn` is the open Password rule; `routes` are the editor rows (none = routing off). */
type Draft = { url: string; starts: string; ends: string; code: 301 | 302; pass: boolean; password: string; passwordOn: boolean; routes: Route[]; vcard: VCard };
const NEW_DRAFT: Draft = { url: "", starts: "", ends: "", code: 302, pass: true, password: "", passwordOn: false, routes: [], vcard: emptyVcard() };
const draftOf = (l: Link): Draft => ({
  url: l.url, starts: toLocalInput(l.startsAt), ends: toLocalInput(l.expiresAt), code: l.redirectCode, pass: l.passQuery,
  password: "", passwordOn: l.hasPassword, routes: l.routes, vcard: l.kind === "vcard" ? fullCard(l) : emptyVcard(),
});

/** Edit: only the fields that differ from the loaded link. `routes` are the rows to send (blank ones dropped, countries upper-cased). */
function diff(l: Link, d: Draft, routes: Route[]): Record<string, unknown> {
  const base = draftOf(l);
  const out: Record<string, unknown> = {};
  if (d.url !== base.url) out.url = d.url;
  if (d.code !== base.code) out.redirectCode = d.code;
  if (d.pass !== base.pass) out.passQuery = d.pass;
  if (d.starts !== base.starts) out.startsAt = fromLocalInput(d.starts);
  if (d.ends !== base.ends) out.expiresAt = fromLocalInput(d.ends);
  if (d.passwordOn && d.password) out.password = d.password;
  else if (!d.passwordOn && l.hasPassword) out.password = null;
  if (JSON.stringify(routes) !== JSON.stringify(l.routes)) out.routes = routes;
  // A card is sent whole when it differs (blank rows never count as a change).
  if (l.kind === "vcard" && JSON.stringify(cleanVcard(d.vcard)) !== JSON.stringify(base.vcard)) out.vcard = cleanVcard(d.vcard);
  return out;
}

/** A rule row. `toggle` rows (QR) are on/off buttons (aria-pressed); the others expand a panel (aria-expanded). */
function Rule({ icon, label, note, keyName, open, onClick, toggle }: { icon: string; label: string; note: string; keyName: string; open: boolean; onClick(): void; toggle?: boolean }) {
  return (
    <button type="button" className={open ? "rule open" : "rule"} aria-expanded={toggle ? undefined : open} aria-pressed={toggle ? open : undefined} aria-keyshortcuts={keyName} onClick={onClick}>
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d={icon} />
      </svg>
      <span className="lbl">
        {label}
        <small>{note}</small>
      </span>
      <kbd>{keyName}</kbd>
    </button>
  );
}

/**
 * One form for a new link and for editing one (S12): `link` set means edit. Create picks the type, domain and slug; edit keeps
 * them and sends only what changed (PATCH), with the conflict, password, routing and card rules of the old detail panel.
 * A save that lands while the person kept typing rebases: the fields typed since stay, the rest take the saved revision.
 */
export function NewLinkSheet({ slug: initialSlug, link, onSaved, onClose }: { slug?: string; link?: Link; onSaved?(l: Link): void; onClose?(): void }) {
  const app = useApp();
  const { me, domains, currentDomainId } = app;
  const editing = link !== undefined;
  const close = onClose ?? app.close;
  const usable = useMemo(
    () => domains.filter((d) => canUseDomain(me, d)),
    [domains, me],
  );
  const [domainId, setDomainId] = useState(() =>
    link ? link.domainId : usable.some((d) => d.id === currentDomainId) ? currentDomainId! : (usable.find((d) => d.type === "main") ?? usable[0])?.id ?? "",
  );
  const [slug, setSlug] = useState(link?.slug ?? initialSlug ?? "");
  const [d, setDraft] = useState<Draft>(() => (link ? draftOf(link) : NEW_DRAFT));
  const set = (p: Partial<Draft>) => setDraft((x) => ({ ...x, ...p }));
  const latest = useRef(d);
  latest.current = d;
  const [tagsOpen, setTagsOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(() => !!link && (link.startsAt !== null || link.expiresAt !== null));
  const [showPw, setShowPw] = useState(false);
  const [changePw, setChangePw] = useState(false); // the new-password input of a link that already has one
  const [routeErrors, setRouteErrors] = useState<Record<number, string>>({});
  const [qr, setQr] = useState(false);
  // S9: a plain link, or a contact card the short link downloads. An edit keeps the link's kind.
  const [kind, setKind] = useState<"url" | "vcard">(link?.kind === "vcard" ? "vcard" : "url");
  const [cardField, setCardField] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false); // a picked photo is still being resized: Create and Save wait
  const isCard = kind === "vcard";
  const cardWait = isCard && photoBusy;
  const photoBusyNow = useRef(photoBusy);
  photoBusyNow.current = photoBusy;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const pwRef = useRef<HTMLInputElement>(null);
  const routesRef = useRef<HTMLDivElement>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<{ field: Field; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const domainRef = useRef<HTMLSelectElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [recheck, setRecheck] = useState(0);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const wasReleasing = useRef(false);
  const releaseBusy = useRef(false); // double Enter sends one DELETE
  const sent = useRef<{ id: string; draft: Draft } | null>(null); // the draft a finished save sent
  const vcId = editing ? "ld-vc" : "nl-vc";
  // An edit with changes holds the Links keys that would change the selection under it (S2 ruling), as the panel form did.
  useUnsaved(editing && JSON.stringify(d) !== JSON.stringify(draftOf(link)));

  const domain: Domain | undefined = editing ? domains.find((x) => x.id === link.domainId) : usable.find((x) => x.id === domainId);
  const host = domain?.host ?? "";

  // Edit: a new revision (after a save or a reload) replaces the form; typing never triggers this. After this form's own save,
  // fields edited while it was pending keep what was typed. The first render already took the current revision.
  const revision = useRef(link ? `${link.id}:${link.updatedAt}` : "");
  useEffect(() => {
    if (!link) return;
    const rev = `${link.id}:${link.updatedAt}`;
    if (revision.current === rev) return;
    revision.current = rev;
    const s = sent.current;
    sent.current = null;
    setDraft(s?.id === link.id ? rebase(draftOf(link), s.draft, latest.current) : draftOf(link));
    setError(null);
    setRouteErrors({});
    setChangePw(false);
    setCardField(null);
  }, [link?.id, link?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edit of a contact card: focus goes to its first field (E on a card used to do the same in the panel).
  useEffect(() => {
    if (editing && isCard) document.getElementById(`${vcId}-firstName`)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Availability (create only): debounced, one request in flight (the old one is aborted), and an older answer is dropped.
  useEffect(() => {
    if (editing) return;
    const n = ++seq.current;
    setError((e) => (e?.field === "slug" ? null : e));
    if (!slug || !domainId) return setCheck(null);
    const shape = checkSlugShape(slug);
    if (!shape.ok) return setCheck({ status: "invalid", reason: shape.reason === "too_long" ? "slug_too_long" : shape.reason });
    setCheck(null);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<Check>("GET", `/api/links/check?domain=${encodeURIComponent(domainId)}&slug=${encodeURIComponent(slug)}`, undefined, ctl.signal).then(
        (c) => n === seq.current && setCheck(c),
        () => undefined, // aborted, or signed out (the shell shows that); the form just has no status
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [slug, domainId, recheck, editing]);

  const suggestions = useMemo(() => (editing ? [] : suggestSlugs(d.url)), [d.url, editing]);
  const utm = readUtm(d.url);
  const urlOk = isUrl(d.url);
  const startSec = fromLocalInput(d.starts);
  const endSec = fromLocalInput(d.ends);
  const filled = d.routes.filter((r) => !blank(r));

  const blocked = (): { field: Field; code: string } | null => {
    if (!editing) {
      if (check && check.status !== "available") return { field: "slug", code: check.status === "invalid" ? check.reason : check.status };
      if (!slug) return { field: "slug", code: "empty" };
      const dest = isCard ? null : checkDestination(d.url, usable.map((x) => x.host));
      if (dest && !dest.ok) return { field: "url", code: dest.reason === "too_long" ? "url_too_long" : dest.reason };
    }
    if (startSec !== null && endSec !== null && endSec <= startSec) return { field: "schedule", code: "bad_window" };
    if (d.passwordOn && !isCard) {
      // Edit: a link that already has a password keeps it when nothing is typed.
      if (!(editing && link.hasPassword && d.password === "")) {
        const p = passwordProblem(d.password);
        if (p) return { field: "password", code: p };
      }
      if (d.code === 301) return { field: "password", code: "password_301" };
    }
    return null;
  };

  /** Countries normalized for the API, or the error text under each bad row (keyed by its index in the editor). */
  const routeBody = (): { ok: true; routes: Route[] } | { ok: false; errors: Record<number, string> } => {
    if (isCard) return { ok: true, routes: [] }; // a card has no routing
    const errors: Record<number, string> = {};
    const out = filled.map((r) => {
      const c = parseCountries(r.countries.join(" "));
      if (!c.ok) errors[d.routes.indexOf(r)] = errorText("route_country");
      return { ...r, countries: c.ok ? c.list : [] };
    });
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, routes: out };
  };

  /** A failed create or save: the field the server names, the route row or card field it points at, else the form. */
  const fail = (e: unknown) => {
    const c = e instanceof ApiError ? e.code : "internal";
    const data = e instanceof ApiError ? (e.data as { index?: unknown; reason?: unknown; field?: unknown } | undefined) : undefined;
    const row = c === "bad_route" && typeof data?.index === "number" ? filled[data.index] : undefined;
    if (c === "bad_vcard") setCardField(typeof data?.field === "string" ? formField(d.vcard, data.field) : "vcard");
    // the server's index counts the rows sent (the non-blank ones), so map it back to the editor row
    else if (row) setRouteErrors({ [d.routes.indexOf(row)]: errorText(typeof data?.reason === "string" ? data.reason : "bad_route") });
    else setError({ field: fieldOf(c), code: c }); // typed values stay in the form
    if (c === "taken" || c === "locked" || c === "reserved") setCheck({ status: c }); // the availability line agrees with the error
  };

  const create = async (copy: boolean) => {
    if (busy || releasing || !domainId || cardWait) return;
    const stop = blocked();
    const rb = routeBody();
    setRouteErrors(rb.ok ? {} : rb.errors);
    const cv = isCard ? checkVcard(cleanVcard(d.vcard)) : null;
    setCardField(cv && !cv.ok ? formField(d.vcard, cv.field) : null);
    if (stop || !rb.ok || (cv && !cv.ok)) {
      setError(stop);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = cv?.ok ? { domainId, slug, kind: "vcard", vcard: cv.vcard } : { domainId, slug, url: d.url, redirectCode: d.code };
      if (startSec !== null) body.startsAt = startSec;
      if (endSec !== null) body.expiresAt = endSec;
      if (d.passwordOn && !isCard) body.password = d.password;
      if (rb.routes.length) body.routes = rb.routes;
      const created = await api<Link>("POST", "/api/links", body);
      set({ password: "" });
      const short = shortUrl(host, created.slug);
      let copied = false;
      if (copy) copied = await navigator.clipboard.writeText(short).then(() => true, () => false);
      app.close();
      app.bumpLinks();
      app.reloadDomains().catch(() => undefined); // link counts
      navigate(`/links?sel=${encodeURIComponent(created.id)}${qr ? "&view=detail&qr=1" : ""}`);
      app.announce(`Created ${host}/${created.slug}${copy ? (copied ? " and copied" : ", could not copy") : ""}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!link || busy || cardWait) return;
    // Password switched on with nothing stored and nothing typed: refuse, never save the link as if it were protected.
    if (d.passwordOn && !isCard && !link.hasPassword && d.password === "") return setError({ field: "password", code: "password_short" });
    // Route errors first: a bad country in a device-only rule would otherwise leave nothing to save, silently.
    const rb = routeBody();
    setRouteErrors(rb.ok ? {} : rb.errors);
    if (!rb.ok) return;
    const body = diff(link, d, rb.routes);
    const cv = body.vcard ? checkVcard(body.vcard as VCard) : null;
    setCardField(cv && !cv.ok ? formField(d.vcard, cv.field) : null);
    if (cv && !cv.ok) return;
    const stop = blocked();
    setError(stop);
    if (stop) return;
    if (Object.keys(body).length === 0) return close(); // nothing changed
    setBusy(true);
    try {
      const saved = await api<Link>("PATCH", `/api/links/${encodeURIComponent(link.id)}`, body);
      sent.current = { id: link.id, draft: d };
      onSaved?.(saved);
      app.announce("Saved");
      // Typed on while it saved: stay open, and the new revision keeps those fields. Otherwise the sheet is done.
      // A photo still resizing is a newer edit too; a sheet closed (and maybe reopened) meanwhile is not this one to close.
      if (mounted.current && !photoBusyNow.current && JSON.stringify(latest.current) === JSON.stringify(d)) close();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (releaseBusy.current) return;
    releaseBusy.current = true;
    setReleaseError(null);
    try {
      await api("DELETE", `/api/locks/${encodeURIComponent(domainId)}/${encodeURIComponent(slug)}`);
      setReleasing(false);
      setRecheck((n) => n + 1);
    } catch (e) {
      setReleaseError(errorText(e instanceof ApiError ? e.code : "internal"));
    } finally {
      releaseBusy.current = false;
    }
  };

  // Back from the confirm: focus returns to the slug (the form was unmounted while confirming).
  useEffect(() => {
    if (wasReleasing.current && !releasing) slugRef.current?.focus();
    wasReleasing.current = releasing;
  }, [releasing]);

  const focusPw = useRef(false);
  const focusRoutes = useRef(false);
  const routesOpen = d.routes.length > 0;
  // Opening or closing a rule starts it over: the password is cleared, routing gets one empty row (closed: none).
  const togglePw = () => {
    focusPw.current = !d.passwordOn;
    set({ passwordOn: !d.passwordOn, password: "" });
    setChangePw(false);
    setError((e) => (e?.field === "password" ? null : e));
  };
  const toggleRoutes = () => {
    focusRoutes.current = !routesOpen;
    set({ routes: routesOpen ? [] : [NEW_ROUTE] });
    setRouteErrors({});
  };
  // Opening a row from its key or button moves focus into it.
  useEffect(() => {
    if (d.passwordOn && focusPw.current) pwRef.current?.focus();
    focusPw.current = false;
  }, [d.passwordOn]);
  useEffect(() => {
    if (routesOpen && focusRoutes.current) routesRef.current?.querySelector("input")?.focus();
    focusRoutes.current = false;
  }, [routesOpen]);
  useEffect(() => {
    if (changePw) pwRef.current?.focus();
  }, [changePw]);

  useHotkeys({
    "mod+enter": () => void (editing ? save() : create(false)),
    "mod+shift+enter": () => void (editing ? save() : create(true)),
    "alt+d": () => !editing && domainRef.current?.focus(),
    t: () => !isCard && setTagsOpen((v) => !v),
    s: () => setSchedOpen((v) => !v),
    p: () => !isCard && togglePw(),
    r: () => !isCard && toggleRoutes(),
    q: () => !editing && setQr((v) => !v),
  } satisfies Bindings<typeof NEW_LINK_KEYS>, !releasing);

  const setTag = (k: keyof Utm, v: string) => setDraft((x) => ({ ...x, url: withUtm(x.url, { ...readUtm(x.url), [k]: v }) }));
  const err = (f: Field) => (error?.field === f ? error.code : null);
  const line = (() => {
    if (!check) return null;
    switch (check.status) {
      case "available": return <span className="ok">● Available</span>;
      case "taken": return <span className="bad-t">Taken on this domain</span>;
      case "locked": return <span className="bad-t">Locked: this slug was deleted. Only the owner can release it</span>;
      case "reserved": return <span className="bad-t">Reserved on this domain</span>;
      default: return <span className="bad-t">{errorText(check.reason)}</span>;
    }
  })();
  const finalUrl = d.url.replace(/^https?:\/\//, "");
  const title = editing ? "Edit link" : "New link";
  const keysHint = editing ? (isCard ? "Rule key S works outside text boxes" : "Rule keys T S P R work outside text boxes") : isCard ? "Rule keys S Q work outside text boxes" : "Rule keys T S P R Q work outside text boxes";
  // Edit: a stored password is kept until Change password is picked.
  const keepPw = editing && link.hasPassword && !changePw && d.password === "";

  return (
    <Sheet label={releasing ? "Release lock" : title} onClose={() => (releasing ? setReleasing(false) : close())}>
      {releasing ? (
        <>
          <div className="sh-head">
            <h2>Release lock</h2>
          </div>
          <div className="sh-body">
            <p>
              Release the lock on {host}/{slug}? Anyone who can use this domain can then take this slug. Old printed links to it would reach their new destination.
            </p>
            {releaseError && (
              <p className="err" role="alert">
                {releaseError}
              </p>
            )}
            <div className="actions">
              <button type="button" className="btn primary" autoFocus onClick={() => void release()}>
                Release lock <span className="k">Enter</span>
              </button>
              <button type="button" className="btn ghost" onClick={() => setReleasing(false)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
      <div className="sh-head">
        <h2>{title}</h2>
        <span className="x">
          <kbd>Esc</kbd> cancel
        </span>
      </div>
      <div className="sh-body">
        {!editing && (
          <div className="f">
            <span className="lbl" id="nl-kind">Type</span>
            <Seg
              label="Type"
              value={kind}
              onChange={(k) => {
                if (busy) return; // the answer of a pending create belongs to the type it was sent as
                setKind(k);
                setError(null);
                setCardField(null);
              }}
              options={[
                { value: "url", label: "Web address" },
                { value: "vcard", label: "Contact card" },
              ]}
            />
            {isCard && <p className="hint">Opening or scanning the short link saves this card to the phone's contacts.</p>}
          </div>
        )}
        {!isCard && (
          <div className="f">
            <label htmlFor="nl-dest">
              Goes to <span>a URL, tel: or mailto:</span>
            </label>
            <div className={err("url") ? "ctl bad" : "ctl"}>
              <input id="nl-dest" autoFocus value={d.url} spellCheck={false} autoComplete="off" aria-invalid={err("url") ? true : undefined} onChange={(e) => set({ url: e.target.value })} />
            </div>
            {err("url") && (
              <p className="err" role="alert">
                {errorText(err("url")!)}
              </p>
            )}
          </div>
        )}
        {editing ? (
          <div className="f">
            <span className="lbl">Short link</span>
            <div className="fixed-slug">
              {host}/<b>{slug}</b>
            </div>
          </div>
        ) : (
          <div className="f">
            <label htmlFor="nl-slug">
              Short link{" "}
              <span className="kh">
                <kbd>Alt</kbd> <kbd>D</kbd> change domain
              </span>
            </label>
            <div className={err("slug") ? "ctl bad" : "ctl"}>
              <select ref={domainRef} aria-label="Domain" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {usable.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.host}
                  </option>
                ))}
              </select>
              <span className="pre">/</span>
              <input id="nl-slug" ref={slugRef} className="slug" value={slug} spellCheck={false} autoComplete="off" aria-invalid={err("slug") ? true : undefined} onChange={(e) => setSlug(e.target.value)} />
              <span aria-live="polite">{line}</span>
            </div>
            {err("slug") && (
              <p className="err" role="alert">
                {errorText(err("slug")!)}
              </p>
            )}
            {check?.status === "locked" && can(me, "links.editAny") && (
              <p className="err">
                <button type="button" className="btn sm" onClick={() => {
                    setReleaseError(null);
                    setReleasing(true);
                  }}>
                  Release lock
                </button>
              </p>
            )}
            {!isCard && suggestions.length > 0 && (
              <div className="sugs">
                <span>Suggestions</span>
                {suggestions.map((s) => (
                  <button key={s} type="button" className="sug" onClick={() => setSlug(s)}>
                    {s}
                  </button>
                ))}
                <span className="kh">
                  <kbd>Tab</kbd> to pick
                </span>
              </div>
            )}
          </div>
        )}
        {isCard && (
          <VcardForm id={vcId} value={d.vcard} field={cardField} onBusy={setPhotoBusy} onChange={(vcard) => {
              set({ vcard });
              setCardField(null);
            }} />
        )}
        <div className="rules" aria-label="Rules">
          {!isCard && (
          <Rule
            icon="M4 20V10M10 20V4M16 20v-7M22 20H2"
            label="Campaign tags"
            note={[utm.source && `utm_source=${utm.source}`, utm.medium && `utm_medium=${utm.medium}`, utm.campaign && `utm_campaign=${utm.campaign}`].filter(Boolean).join(", ") || "Off"}
            keyName="T"
            open={tagsOpen}
            onClick={() => setTagsOpen((v) => !v)}
          />
          )}
          {!isCard && tagsOpen && (
            <div className="utm">
              {(["source", "medium", "campaign"] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`nl-utm-${k}`}>{k[0]!.toUpperCase() + k.slice(1)}</label>
                  <div className="ctl">
                    <input id={`nl-utm-${k}`} value={utm[k]} disabled={!urlOk} autoComplete="off" onChange={(e) => setTag(k, e.target.value)} />
                  </div>
                </div>
              ))}
              {!urlOk && <p className="utm-note">Enter a full URL first</p>}
            </div>
          )}
          <Rule
            icon="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2"
            label="Schedule and expiry"
            note={d.starts || d.ends ? "Set" : "Off"}
            keyName="S"
            open={schedOpen}
            onClick={() => setSchedOpen((v) => !v)}
          />
          {schedOpen && (
            <div className="sched">
              <div>
                <label htmlFor="nl-starts">Starts</label>
                <div className="ctl">
                  <input id="nl-starts" type="datetime-local" value={d.starts} onChange={(e) => set({ starts: e.target.value })} />
                </div>
              </div>
              <div>
                <label htmlFor="nl-ends">Ends</label>
                <div className={err("schedule") ? "ctl bad" : "ctl"}>
                  <input id="nl-ends" type="datetime-local" value={d.ends} aria-invalid={err("schedule") ? true : undefined} onChange={(e) => set({ ends: e.target.value })} />
                </div>
              </div>
            </div>
          )}
          {!isCard && (
          <Rule
            icon="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z"
            label="Password"
            note={d.passwordOn && (d.password || keepPw) ? "On" : "Off"}
            keyName="P"
            open={d.passwordOn}
            onClick={togglePw}
          />
          )}
          {!isCard && d.passwordOn && (
            <div className="pw">
              {keepPw ? (
                <div className="row-actions">
                  <span className="muted">Password set</span>
                  <button type="button" className="btn sm" onClick={() => setChangePw(true)}>
                    Change password
                  </button>
                </div>
              ) : (
                <>
                  <label htmlFor="nl-pw">{editing && link.hasPassword ? "New password" : "Password"}</label>
                  <div className={err("password") ? "ctl bad" : "ctl"}>
                    <input
                      id="nl-pw"
                      ref={pwRef}
                      type={showPw ? "text" : "password"}
                      value={d.password}
                      autoComplete="new-password"
                      spellCheck={false}
                      autoCapitalize="off"
                      aria-describedby={err("password") ? "nl-pw-hint nl-pw-err" : "nl-pw-hint"}
                      aria-invalid={err("password") ? true : undefined}
                      onChange={(e) => set({ password: e.target.value })}
                    />
                    <button type="button" className="btn sm ghost icon" aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)}>
                      <Icon name="eye" />
                    </button>
                  </div>
                </>
              )}
              <p id="nl-pw-hint" className="utm-note">
                At least 8 characters. Visitors type it before the link opens.{editing ? " Applies everywhere within a few minutes." : ""}
              </p>
              {d.code === 301 && editing && <p className="utm-note">{errorText("password_301")}</p>}
              {err("password") && (
                <p className="err" role="alert" id="nl-pw-err">
                  {errorText(err("password")!)}
                </p>
              )}
            </div>
          )}
          {!isCard && (
          <Rule
            icon="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"
            label="Country and device routing"
            note={routeSummary(filled)}
            keyName="R"
            open={routesOpen}
            onClick={toggleRoutes}
          />
          )}
          {!isCard && routesOpen && (
            <div ref={routesRef}>
              <RoutesEditor
                value={d.routes}
                errors={routeErrors}
                onChange={(routes) => {
                  set({ routes });
                  setRouteErrors({});
                }}
              />
            </div>
          )}
          {!editing && (
          <Rule
            icon="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3M21 14v7h-4M14 21v-3"
            label="QR code"
            note={qr ? "Opens after creating" : "Make one after creating"}
            keyName="Q"
            open={qr}
            toggle
            onClick={() => setQr((v) => !v)}
          />
          )}
        </div>
        {err("schedule") && (
          <p className="err" role="alert">
            {errorText(err("schedule")!)}
          </p>
        )}
        {!isCard && (
        <div className="redir">
          <span>Redirect</span>
          <Seg
            label="Redirect"
            value={d.code}
            onChange={(code) => set({ code })}
            options={[
              { value: 302, label: "302 editable" },
              { value: 301, label: "301 fixed" },
            ]}
          />
        </div>
        )}
        {!isCard && editing && (
          <div className="toggle">
            <div>
              Pass query string through<small>Extra parameters reach the destination</small>
            </div>
            <Switch checked={d.pass} onChange={(pass) => set({ pass })} label="Pass query string through" />
          </div>
        )}
        <div className="route">
          <span>
            {host}/<b>{slug}</b>
          </span>
          <span className="arr">{isCard ? "200" : d.code}</span>
          <span>{isCard ? "downloads the contact card" : finalUrl || "..."}</span>
        </div>
        {err("form") && (
          <p className="err" role="alert">
            {errorText(err("form")!)}
            {err("form") === "conflict" && (
              <button type="button" className="btn sm" onClick={() => app.bumpLinks()}>
                Reload
              </button>
            )}
          </p>
        )}
        {!editing && usable.length === 0 && (
          <p className="err" role="alert">
            {mayOpen(app.me, { kind: "addDomain" }) ? "No domain yet. Add one in Domains first." : "No domain is available to you yet. Ask the owner to give you access to one."}
          </p>
        )}
      </div>
      <div className="sh-foot">
        <span className="left kh">{keysHint}</span>
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        {editing ? (
          <button type="button" className="btn primary" disabled={busy || cardWait} aria-keyshortcuts="Control+Enter" onClick={() => void save()}>
            Save<span className="k2">Ctrl Enter</span>
          </button>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy || !domainId || cardWait} aria-keyshortcuts="Control+Shift+Enter" onClick={() => void create(true)}>
              Create and copy <span className="k2">Ctrl ⇧ Enter</span>
            </button>
            <button type="button" className="btn primary" disabled={busy || !domainId || cardWait} aria-keyshortcuts="Control+Enter" onClick={() => void create(false)}>
              Create link<span className="k2">Ctrl Enter</span>
            </button>
          </>
        )}
      </div>
        </>
      )}
    </Sheet>
  );
}
