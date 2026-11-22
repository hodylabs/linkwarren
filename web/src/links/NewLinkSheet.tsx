import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Domain, type Link, type Route } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { Sheet } from "../shell/Sheet";
import { Seg } from "../shell/ui";
import { useApp } from "../state";
import { fromLocalInput } from "../time";
import { checkDestination, checkSlugShape } from "../../../src/validate";
import { readUtm, suggestSlugs, withUtm, type Utm } from "./compose";
import { shortUrl } from "./linkView";
import { parseCountries, passwordProblem, routeSummary } from "./rules";
import { RoutesEditor } from "./RoutesEditor";

type Check = { status: "available" | "taken" | "locked" | "reserved" } | { status: "invalid"; reason: string };
type Field = "url" | "slug" | "schedule" | "password" | "form";
const SLUG_CODES = new Set(["taken", "locked", "reserved", "empty", "slug_too_long", "charset", "leading_dot", "too_long"]);
const URL_CODES = new Set(["not_url", "scheme", "userinfo", "url_too_long", "loop", "too_long"]);
const fieldOf = (code: string): Field => (code === "bad_window" ? "schedule" : code.startsWith("password_") ? "password" : SLUG_CODES.has(code) ? "slug" : URL_CODES.has(code) ? "url" : "form");
const DEBOUNCE_MS = 250;

/** New link sheet hotkeys and their text on the shortcuts sheet (the rule keys T S P R Q only outside text boxes). */
export const NEW_LINK_KEYS = {
  "mod+enter": "Create the link",
  "mod+shift+enter": "Create and copy the short link",
  "alt+d": "Change the domain",
  t: "Campaign tags",
  s: "Schedule and expiry",
  p: "Password",
  r: "Country and device routing",
  q: "QR code after creating",
} as const;
const blank = (r: Route) => !r.countries.length && !r.devices.length && !r.url.trim();

const isUrl = (s: string) => {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
};

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

export function NewLinkSheet({ slug: initialSlug }: { slug?: string }) {
  const app = useApp();
  const { me, domains, currentDomainId } = app;
  const usable = useMemo(
    () => domains.filter((d) => d.status !== "disabled" && (me.role === "owner" || d.type === "main" || d.isMember || d.ownerId === me.id)),
    [domains, me],
  );
  const [domainId, setDomainId] = useState(() => (usable.some((d) => d.id === currentDomainId) ? currentDomainId! : (usable.find((d) => d.type === "main") ?? usable[0])?.id ?? ""));
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState(initialSlug ?? "");
  const [code, setCode] = useState<301 | 302>(302);
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState(""); // never logged, announced or echoed; cleared after a save
  const [showPw, setShowPw] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeErrors, setRouteErrors] = useState<Record<number, string>>({});
  const [qr, setQr] = useState(false);
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

  const domain: Domain | undefined = usable.find((d) => d.id === domainId);
  const host = domain?.host ?? "";

  // Availability: debounced, one request in flight (the old one is aborted), and an answer from an older request is dropped.
  useEffect(() => {
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
  }, [slug, domainId, recheck]);

  const suggestions = useMemo(() => suggestSlugs(url), [url]);
  const utm = readUtm(url);
  const urlOk = isUrl(url);
  const startSec = fromLocalInput(starts);
  const endSec = fromLocalInput(ends);

  const filled = routes.filter((r) => !blank(r));

  const blocked = (): { field: Field; code: string } | null => {
    if (check && check.status !== "available") return { field: "slug", code: check.status === "invalid" ? check.reason : check.status };
    if (!slug) return { field: "slug", code: "empty" };
    const dest = checkDestination(url, usable.map((d) => d.host));
    if (!dest.ok) return { field: "url", code: dest.reason === "too_long" ? "url_too_long" : dest.reason };
    if (startSec !== null && endSec !== null && endSec <= startSec) return { field: "schedule", code: "bad_window" };
    if (pwOpen) {
      const p = passwordProblem(password);
      if (p) return { field: "password", code: p };
      if (code === 301) return { field: "password", code: "password_301" };
    }
    return null;
  };

  /** Countries normalized for the API, or the error text under each bad row (keyed by its index in `routes`). */
  const routeBody = (): { ok: true; routes: Route[] } | { ok: false; errors: Record<number, string> } => {
    const errors: Record<number, string> = {};
    const out = filled.map((r) => {
      const c = parseCountries(r.countries.join(" "));
      if (!c.ok) errors[routes.indexOf(r)] = errorText("route_country");
      return { ...r, countries: c.ok ? c.list : [] };
    });
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, routes: out };
  };

  const submit = async (copy: boolean) => {
    if (busy || releasing || !domainId) return;
    const stop = blocked();
    const rb = routeBody();
    setRouteErrors(rb.ok ? {} : rb.errors);
    if (!rb.ok) setRoutesOpen(true);
    if (stop || !rb.ok) {
      setError(stop);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { domainId, slug, url, redirectCode: code };
      if (startSec !== null) body.startsAt = startSec;
      if (endSec !== null) body.expiresAt = endSec;
      if (pwOpen) body.password = password;
      if (rb.routes.length) body.routes = rb.routes;
      const link = await api<Link>("POST", "/api/links", body);
      setPassword("");
      const short = shortUrl(host, link.slug);
      let copied = false;
      if (copy) copied = await navigator.clipboard.writeText(short).then(() => true, () => false);
      app.close();
      app.bumpLinks();
      app.reloadDomains().catch(() => undefined); // link counts
      navigate(`/links?sel=${encodeURIComponent(link.id)}${qr ? "&view=detail&qr=1" : ""}`);
      app.announce(`Created ${host}/${link.slug}${copy ? (copied ? " and copied" : ", could not copy") : ""}`);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "internal";
      const d = e instanceof ApiError ? (e.data as { index?: unknown; reason?: unknown } | undefined) : undefined;
      const row = c === "bad_route" && typeof d?.index === "number" ? filled[d.index] : undefined;
      if (row) {
        // the server's index counts the rows sent (the non-blank ones), so map it back to the editor row
        setRouteErrors({ [routes.indexOf(row)]: errorText(typeof d?.reason === "string" ? d.reason : "bad_route") });
        setRoutesOpen(true);
      } else setError({ field: fieldOf(c), code: c }); // typed values stay in the form
      if (c === "taken" || c === "locked" || c === "reserved") setCheck({ status: c }); // the availability line agrees with the error
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
  const togglePw = () => {
    focusPw.current = !pwOpen;
    setPwOpen(!pwOpen);
  };
  const toggleRoutes = () => {
    focusRoutes.current = !routesOpen;
    if (!routesOpen && !routes.length) setRoutes([{ countries: [], devices: [], url: "" }]);
    setRoutesOpen(!routesOpen);
  };
  // Opening a row from its key or button moves focus into it.
  useEffect(() => {
    if (pwOpen && focusPw.current) pwRef.current?.focus();
    focusPw.current = false;
  }, [pwOpen]);
  useEffect(() => {
    if (routesOpen && focusRoutes.current) routesRef.current?.querySelector("input")?.focus();
    focusRoutes.current = false;
  }, [routesOpen]);

  useHotkeys({
    "mod+enter": () => void submit(false),
    "mod+shift+enter": () => void submit(true),
    "alt+d": () => domainRef.current?.focus(),
    t: () => setTagsOpen((v) => !v),
    s: () => setSchedOpen((v) => !v),
    p: togglePw,
    r: toggleRoutes,
    q: () => setQr((v) => !v),
  } satisfies Bindings<typeof NEW_LINK_KEYS>, !releasing);

  const setTag = (k: keyof Utm, v: string) => setUrl((u) => withUtm(u, { ...readUtm(u), [k]: v }));
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
  const finalUrl = url.replace(/^https?:\/\//, "");

  return (
    <Sheet label={releasing ? "Release lock" : "New link"} onClose={() => (releasing ? setReleasing(false) : app.close())}>
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
              <button type="button" className="btn" onClick={() => setReleasing(false)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
      <div className="sh-head">
        <h2>New link</h2>
        <span className="x">
          <kbd>Esc</kbd> cancel
        </span>
      </div>
      <div className="sh-body">
        <div className="f">
          <label htmlFor="nl-dest">
            Goes to <span>paste a URL</span>
          </label>
          <div className={err("url") ? "ctl bad" : "ctl"}>
            <input id="nl-dest" autoFocus value={url} spellCheck={false} autoComplete="off" aria-invalid={err("url") ? true : undefined} onChange={(e) => setUrl(e.target.value)} />
          </div>
          {err("url") && (
            <p className="err" role="alert">
              {errorText(err("url")!)}
            </p>
          )}
        </div>
        <div className="f">
          <label htmlFor="nl-slug">
            Short link{" "}
            <span className="kh">
              <kbd>Alt</kbd> <kbd>D</kbd> change domain
            </span>
          </label>
          <div className={err("slug") ? "ctl bad" : "ctl"}>
            <select ref={domainRef} aria-label="Domain" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              {usable.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.host}
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
          {check?.status === "locked" && me.role === "owner" && (
            <p className="err">
              <button type="button" className="btn" onClick={() => {
                  setReleaseError(null);
                  setReleasing(true);
                }}>
                Release lock
              </button>
            </p>
          )}
          {suggestions.length > 0 && (
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
        <div className="rules" aria-label="Rules">
          <Rule
            icon="M4 20V10M10 20V4M16 20v-7M22 20H2"
            label="Campaign tags"
            note={[utm.source && `utm_source=${utm.source}`, utm.medium && `utm_medium=${utm.medium}`, utm.campaign && `utm_campaign=${utm.campaign}`].filter(Boolean).join(", ") || "Off"}
            keyName="T"
            open={tagsOpen}
            onClick={() => setTagsOpen((v) => !v)}
          />
          {tagsOpen && (
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
            note={starts || ends ? "Set" : "Off"}
            keyName="S"
            open={schedOpen}
            onClick={() => setSchedOpen((v) => !v)}
          />
          {schedOpen && (
            <div className="sched">
              <div>
                <label htmlFor="nl-starts">Starts</label>
                <div className="ctl">
                  <input id="nl-starts" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
                </div>
              </div>
              <div>
                <label htmlFor="nl-ends">Ends</label>
                <div className={err("schedule") ? "ctl bad" : "ctl"}>
                  <input id="nl-ends" type="datetime-local" value={ends} aria-invalid={err("schedule") ? true : undefined} onChange={(e) => setEnds(e.target.value)} />
                </div>
              </div>
            </div>
          )}
          <Rule
            icon="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z"
            label="Password"
            note={pwOpen && password ? "On" : "Off"}
            keyName="P"
            open={pwOpen}
            onClick={togglePw}
          />
          {pwOpen && (
            <div className="pw">
              <label htmlFor="nl-pw">Password</label>
              <div className={err("password") ? "ctl bad" : "ctl"}>
                <input
                  id="nl-pw"
                  ref={pwRef}
                  type={showPw ? "text" : "password"}
                  value={password}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="off"
                  aria-describedby="nl-pw-hint"
                  aria-invalid={err("password") ? true : undefined}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button type="button" className="btn ghost" aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)}>
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
              <p id="nl-pw-hint" className="utm-note">
                At least 8 characters. Visitors type it before the link opens.
              </p>
              {err("password") && (
                <p className="err" role="alert">
                  {errorText(err("password")!)}
                </p>
              )}
            </div>
          )}
          <Rule
            icon="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"
            label="Country and device routing"
            note={routeSummary(filled)}
            keyName="R"
            open={routesOpen}
            onClick={toggleRoutes}
          />
          {routesOpen && (
            <div ref={routesRef}>
              <RoutesEditor
                value={routes}
                errors={routeErrors}
                onChange={(r) => {
                  setRoutes(r);
                  setRouteErrors({});
                }}
              />
            </div>
          )}
          <Rule
            icon="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3M21 14v7h-4M14 21v-3"
            label="QR code"
            note={qr ? "Opens after creating" : "Make one after creating"}
            keyName="Q"
            open={qr}
            toggle
            onClick={() => setQr((v) => !v)}
          />
        </div>
        {err("schedule") && (
          <p className="err" role="alert">
            {errorText(err("schedule")!)}
          </p>
        )}
        <div className="redir">
          <span>Redirect</span>
          <Seg
            label="Redirect"
            value={code}
            onChange={setCode}
            options={[
              { value: 302, label: "302 editable" },
              { value: 301, label: "301 fixed" },
            ]}
          />
        </div>
        <div className="route">
          <span>
            {host}/<b>{slug}</b>
          </span>
          <span className="arr">{code}</span>
          <span>{finalUrl || "..."}</span>
        </div>
        {err("form") && (
          <p className="err" role="alert">
            {errorText(err("form")!)}
          </p>
        )}
        {usable.length === 0 && (
          <p className="err" role="alert">
            No domain is available to you yet. Ask the owner to give you access to one.
          </p>
        )}
      </div>
      <div className="sh-foot">
        <span className="left kh">Rule keys T S P R Q work outside text boxes</span>
        <button type="button" className="btn" disabled={busy || !domainId} aria-keyshortcuts="Control+Shift+Enter" onClick={() => void submit(true)}>
          Create and copy <span className="k2">Ctrl ⇧ Enter</span>
        </button>
        <button type="button" className="btn primary" disabled={busy || !domainId} aria-keyshortcuts="Control+Enter" onClick={() => void submit(false)}>
          Create link<span className="k2">Ctrl Enter</span>
        </button>
      </div>
        </>
      )}
    </Sheet>
  );
}
