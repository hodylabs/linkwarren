import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type Domain, type Link, type LinkStats, type Route } from "../api";
import { errorText } from "../copy";
import { rebase } from "../draft";
import { useUnsaved } from "../unsaved";
import { CloseButton, Seg, Switch, Tag } from "../shell/ui";
import { useApp } from "../state";
import { clock, fromLocalInput, shortDate, toLocalInput } from "../time";
import { QrPanel } from "./QrPanel";
import { readUtm } from "./compose";
import { creatorLabel, forwardTarget, linkState, shortUrl, type StatsLive } from "./linkView";
import { RoutesEditor } from "./RoutesEditor";
import { parseCountries, passwordProblem, routeSummary } from "./rules";

export type DetailHandle = { focusUrl(): void; copy(): void; focusQr(): void };

type Draft = { url: string; starts: string; ends: string; code: 301 | 302; pass: boolean; password: string; passwordOn: boolean; routes: Route[] };
const draftOf = (l: Link): Draft => ({
  url: l.url, starts: toLocalInput(l.startsAt), ends: toLocalInput(l.expiresAt), code: l.redirectCode, pass: l.passQuery,
  password: "", passwordOn: l.hasPassword, routes: l.routes,
});
const blank = (r: Route) => !r.countries.length && !r.devices.length && !r.url.trim();

/** The routes to send: blank rows dropped, countries upper-cased. `errors` is keyed by editor row. */
function routesOf(d: Draft): { routes: Route[]; errors: Record<number, string> } {
  const errors: Record<number, string> = {};
  const routes: Route[] = [];
  d.routes.forEach((r, i) => {
    if (blank(r)) return;
    const c = parseCountries(r.countries.join(" "));
    if (!c.ok) errors[i] = errorText("route_country");
    routes.push({ ...r, countries: c.ok ? c.list : [] });
  });
  return { routes, errors };
}

/** Only the fields that differ from the loaded link. */
function diff(l: Link, d: Draft): Record<string, unknown> {
  const base = draftOf(l);
  const out: Record<string, unknown> = {};
  if (d.url !== base.url) out.url = d.url;
  if (d.code !== base.code) out.redirectCode = d.code;
  if (d.pass !== base.pass) out.passQuery = d.pass;
  if (d.starts !== base.starts) out.startsAt = fromLocalInput(d.starts);
  if (d.ends !== base.ends) out.expiresAt = fromLocalInput(d.ends);
  if (d.passwordOn && d.password) out.password = d.password;
  else if (!d.passwordOn && l.hasPassword) out.password = null;
  const { routes } = routesOf(d);
  if (JSON.stringify(routes) !== JSON.stringify(l.routes)) out.routes = routes;
  return out;
}

const LIVE_HINT = { off: "Live clicks are off on this instance.", unavailable: "Recent clicks could not be loaded." } as const;

export const LinkDetail = forwardRef<DetailHandle, { link: Link; stats: LinkStats | undefined; live: StatsLive; domain: Domain | undefined; canEdit: boolean; onSaved(l: Link): void; onDelete(): void; onClose(): void; onOpenTarget(): void }>(
  function LinkDetail({ link, stats, live, domain, canEdit, onSaved, onDelete, onClose, onOpenTarget }, ref) {
    const app = useApp();
    const [draft, setDraft] = useState(() => draftOf(link));
    const [error, setError] = useState<{ code: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [routeErrors, setRouteErrors] = useState<Record<number, string>>({});
    const [changePw, setChangePw] = useState(false); // the new-password input of a link that already has one
    const urlRef = useRef<HTMLInputElement>(null);
    const qrRef = useRef<HTMLButtonElement>(null);
    const sent = useRef<{ id: string; draft: Draft } | null>(null); // the draft a finished save sent
    const host = domain?.host ?? "";
    useUnsaved(canEdit && !link.forwardTo && Object.keys(diff(link, draft)).length > 0);

    // A new revision (after a save or a reload) replaces the form; typing never triggers this.
    // After this form's own save, fields edited while it was pending keep what was typed.
    // The revision the form last took; the first render already did (useState), so an edit made before this effect runs is kept.
    const revision = useRef(`${link.id}:${link.updatedAt}`);
    useEffect(() => {
      const rev = `${link.id}:${link.updatedAt}`;
      if (revision.current === rev) return;
      revision.current = rev;
      const s = sent.current;
      sent.current = null;
      setDraft((now) => (s?.id === link.id ? rebase(draftOf(link), s.draft, now) : draftOf(link)));
      setError(null);
      setRouteErrors({});
      setChangePw(false);
    }, [link.id, link.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const copy = () => {
      if (!host) return app.announce("Cannot copy: this link's domain is unknown");
      navigator.clipboard.writeText(shortUrl(host, link.slug)).then(
        () => app.announce("Copied"),
        () => app.announce("Could not copy"),
      );
    };
    useImperativeHandle(ref, () => ({ focusUrl: () => urlRef.current?.focus(), copy, focusQr: () => qrRef.current?.focus() }));

    const save = async () => {
      if (!canEdit || busy) return;
      // Password switched on with nothing stored and nothing typed: refuse, never save the link as if it were protected.
      if (draft.passwordOn && !link.hasPassword && draft.password === "") return setError({ code: "password_short" });
      // Route errors first: a bad country in a device-only rule leaves the diff empty and would otherwise be ignored silently.
      const re = routesOf(draft).errors;
      setRouteErrors(re);
      const body = diff(link, draft);
      if (Object.keys(re).length === 0 && Object.keys(body).length === 0) return;
      const pwSet = draft.passwordOn && (draft.password !== "" || link.hasPassword);
      const bad = (typeof body.password === "string" && passwordProblem(body.password)) || (pwSet && draft.code === 301 && "password_301");
      if (bad || Object.keys(re).length) return setError(bad ? { code: bad } : null);
      setBusy(true);
      setError(null);
      try {
        const saved = await api<Link>("PATCH", `/api/links/${encodeURIComponent(link.id)}`, body);
        sent.current = { id: link.id, draft };
        onSaved(saved);
        app.announce("Saved");
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "internal";
        const d = e instanceof ApiError ? (e.data as { index?: unknown; reason?: unknown } | undefined) : undefined;
        const row = code === "bad_route" && typeof d?.index === "number" ? draft.routes.filter((r) => !blank(r))[d.index] : undefined;
        if (row) setRouteErrors({ [draft.routes.indexOf(row)]: errorText(typeof d?.reason === "string" ? d.reason : "bad_route") });
        else setError({ code }); // typed values stay in the form
      } finally {
        setBusy(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDraft(draftOf(link));
        setError(null);
        setRouteErrors({});
        setChangePw(false);
      }
    };

    const state = linkState(link, domain, Math.floor(Date.now() / 1000));
    // A forwarder is never edited (R5): its target and Delete only.
    if (link.forwardTo)
      return (
        <aside className="detail" aria-label="Selected link">
          <div className="d-head">
            <CloseButton label="Close link details" onClick={onClose} />
            <div className="short">
              <span className="host">{host}/</span>
              <span className="slug">{link.slug}</span>
            </div>
            <div className="row">
              <Tag tone={state.tone}>{state.label}</Tag>
              <button type="button" className="btn ghost" onClick={copy} disabled={!host} aria-keyshortcuts="C">
                Copy <kbd>C</kbd>
              </button>
            </div>
          </div>
          <div className="sect">
            <p className="hint">This old address was kept when its link moved. Visitors are forwarded to {forwardTarget(link)}, where the click is counted.</p>
            <button type="button" className="btn" onClick={onOpenTarget}>
              Open the link it forwards to
            </button>
          </div>
          {canEdit && (
            <div className="actions">
              <button type="button" className="btn" onClick={onDelete} aria-keyshortcuts="Shift+D">
                Delete <kbd>Shift D</kbd>
              </button>
            </div>
          )}
        </aside>
      );
    const who = (id: string) => creatorLabel(id, app.me, app.users);
    const created = who(link.createdBy);
    const utm = readUtm(draft.url);
    const tags = (["source", "medium", "campaign"] as const).filter((k) => utm[k]).map((k) => `utm_${k}=${utm[k]}`).join(" · ");
    const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
    // Password codes show next to the password field, the rest next to the URL.
    const pwError = !!error && draft.passwordOn && error.code.startsWith("password_");

    return (
      <aside className="detail" aria-label="Selected link" onKeyDown={onKeyDown}>
        <div className="d-head">
          <CloseButton label="Close link details" onClick={onClose} />
          <div className="short">
            <span className="host">{host}/</span>
            <span className="slug">{link.slug}</span>
          </div>
          <div className="row">
            <Tag tone={state.tone}>{state.label}</Tag>
            <button type="button" className="btn ghost" onClick={copy} disabled={!host} aria-keyshortcuts="C">
              Copy <kbd>C</kbd>
            </button>
            {canEdit && (
              <button type="button" className="btn ghost" onClick={() => urlRef.current?.focus()} aria-keyshortcuts="E">
                Edit <kbd>E</kbd>
              </button>
            )}
          </div>
        </div>
        <div className="sect">
          <div className="route">
            <span>
              {host}/<b>{link.slug}</b>
            </span>
            <span>&rarr;</span>
            <span className="arr">{link.redirectCode}</span>
            <span>&rarr;</span>
            <span>{link.url}</span>
          </div>
        </div>
        {stats && (
          <div className="sect">
            <h3>Last 7 days</h3>
            <div className="stats">
              <div className="stat"><b>{stats.clicks.toLocaleString("en-US")}</b><small>clicks</small></div>
              <div className="stat"><b>{stats.clicks > 0 ? Math.round((100 * stats.qr) / stats.clicks) : 0}%</b><small>from QR</small></div>
              <div className="stat"><b>{stats.topCountry ?? "None"}</b><small>top country</small></div>
            </div>
            {live !== "ok" && <p className="hint">{LIVE_HINT[live]} These counts leave out yesterday and today.</p>}
          </div>
        )}
        <fieldset className="plain" disabled={!canEdit}>
          <div className="sect">
            <h3>Destination</h3>
            <div className="field">
              <label htmlFor="ld-url">URL</label>
              <input id="ld-url" className="input" ref={urlRef} value={draft.url} readOnly={!canEdit} spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
            </div>
            {tags && (
              <p className="hint" data-testid="campaign-tags">
                Campaign tags: {tags}
              </p>
            )}
            {error && !pwError && (
              <p className="err" role="alert">
                {errorText(error.code)}
                {error.code === "conflict" && (
                  <button type="button" className="btn" onClick={() => app.bumpLinks()}>
                    Reload
                  </button>
                )}
              </p>
            )}
            <div className="field">
              <label id="ld-redirect">Redirect</label>
              <Seg<301 | 302>
                label="Redirect"
                value={draft.code}
                onChange={(code) => set({ code })}
                options={[{ value: 302, label: "302 editable" }, { value: 301, label: "301 fixed" }]}
              />
            </div>
          </div>
          <div className="sect">
            <h3>Rules</h3>
            <div className="field">
              <label htmlFor="ld-starts">Starts</label>
              <input id="ld-starts" className="input" type="datetime-local" value={draft.starts} readOnly={!canEdit} onChange={(e) => set({ starts: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ld-ends">Ends</label>
              <input id="ld-ends" className="input" type="datetime-local" value={draft.ends} readOnly={!canEdit} onChange={(e) => set({ ends: e.target.value })} />
            </div>
            <div className="toggle">
              <div>
                Password<small>Visitors enter a password first</small>
              </div>
              <Switch
                checked={draft.passwordOn}
                onChange={(on) => {
                  set({ passwordOn: on, password: "" });
                  setChangePw(false);
                  setError(null);
                }}
                label="Password"
              />
            </div>
            {draft.passwordOn && (
              <div className="pw">
                <p className="utm-note">{link.hasPassword ? "Password set" : "No password"}</p>
                {link.hasPassword && !changePw && draft.password === "" ? (
                  <button type="button" className="btn" onClick={() => setChangePw(true)}>
                    Change password
                  </button>
                ) : (
                  <>
                    <label htmlFor="ld-pw">New password</label>
                    <input
                      id="ld-pw" className="input" type="password" value={draft.password} autoComplete="new-password" spellCheck={false} autoCapitalize="off"
                      aria-invalid={pwError || undefined} aria-describedby={pwError ? "ld-pw-err" : undefined}
                      onChange={(e) => set({ password: e.target.value })}
                    />
                  </>
                )}
                <p className="utm-note">Applies everywhere within a few minutes.</p>
                {draft.code === 301 && <p className="utm-note">{errorText("password_301")}</p>}
                {pwError && (
                  <p className="err" role="alert" id="ld-pw-err">
                    {errorText(error!.code)}
                  </p>
                )}
              </div>
            )}
            <div className="toggle">
              <div>
                Country and device routing<small>{routeSummary(draft.routes.filter((r) => !blank(r)))}</small>
              </div>
              <Switch
                checked={draft.routes.length > 0}
                onChange={(on) => {
                  set({ routes: on ? [{ countries: [], devices: [], url: "" }] : [] });
                  setRouteErrors({});
                }}
                label="Country and device routing"
              />
            </div>
            {draft.routes.length > 0 && (
              <RoutesEditor
                value={draft.routes}
                errors={routeErrors}
                onChange={(routes) => {
                  set({ routes });
                  setRouteErrors({});
                }}
              />
            )}
            <div className="toggle">
              <div>
                Pass query string through<small>Extra parameters reach the destination</small>
              </div>
              <Switch checked={draft.pass} onChange={(pass) => set({ pass })} label="Pass query string through" />
            </div>
          </div>
        </fieldset>
        {host && <QrPanel ref={qrRef} host={host} slug={link.slug} />}
        {canEdit && (
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy} aria-keyshortcuts="Control+Enter">
              Save <span className="k">Ctrl Enter</span>
            </button>
            <button type="button" className="btn" onClick={onDelete} aria-keyshortcuts="Shift+D">
              Delete <kbd>Shift D</kbd>
            </button>
          </div>
        )}
        <div className="foot">
          <span>
            Created by {created === "You" ? "you" : created}, {shortDate(link.createdAt)}
          </span>
          <span>
            Last change: {who(link.updatedBy)}, {clock(link.updatedAt)}
          </span>
        </div>
      </aside>
    );
  },
);
