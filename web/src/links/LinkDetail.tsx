import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type Domain, type Link, type LinkStats } from "../api";
import { errorText } from "../copy";
import { rebase } from "../draft";
import { CloseButton, Seg, Switch, Tag } from "../shell/ui";
import { useApp } from "../state";
import { clock, fromLocalInput, shortDate, toLocalInput } from "../time";
import { creatorLabel, linkState, shortUrl, type StatsLive } from "./linkView";

export type DetailHandle = { focusUrl(): void; copy(): void };

type Draft = { url: string; starts: string; ends: string; code: 301 | 302; pass: boolean };
const draftOf = (l: Link): Draft => ({ url: l.url, starts: toLocalInput(l.startsAt), ends: toLocalInput(l.expiresAt), code: l.redirectCode, pass: l.passQuery });

/** Only the fields that differ from the loaded link. */
function diff(l: Link, d: Draft): Record<string, unknown> {
  const base = draftOf(l);
  const out: Record<string, unknown> = {};
  if (d.url !== base.url) out.url = d.url;
  if (d.code !== base.code) out.redirectCode = d.code;
  if (d.pass !== base.pass) out.passQuery = d.pass;
  if (d.starts !== base.starts) out.startsAt = fromLocalInput(d.starts);
  if (d.ends !== base.ends) out.expiresAt = fromLocalInput(d.ends);
  return out;
}

const LIVE_HINT = { off: "Live clicks are off on this instance.", unavailable: "Recent clicks could not be loaded." } as const;

export const LinkDetail = forwardRef<DetailHandle, { link: Link; stats: LinkStats | undefined; live: StatsLive; domain: Domain | undefined; canEdit: boolean; onSaved(l: Link): void; onDelete(): void; onClose(): void }>(
  function LinkDetail({ link, stats, live, domain, canEdit, onSaved, onDelete, onClose }, ref) {
    const app = useApp();
    const [draft, setDraft] = useState(() => draftOf(link));
    const [error, setError] = useState<{ code: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const urlRef = useRef<HTMLInputElement>(null);
    const sent = useRef<{ id: string; draft: Draft } | null>(null); // the draft a finished save sent
    const host = domain?.host ?? "";

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
    }, [link.id, link.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const copy = () => {
      if (!host) return app.announce("Cannot copy: this link's domain is unknown");
      navigator.clipboard.writeText(shortUrl(host, link.slug)).then(
        () => app.announce("Copied"),
        () => app.announce("Could not copy"),
      );
    };
    useImperativeHandle(ref, () => ({ focusUrl: () => urlRef.current?.focus(), copy }));

    const save = async () => {
      if (!canEdit || busy) return;
      const body = diff(link, draft);
      if (Object.keys(body).length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const saved = await api<Link>("PATCH", `/api/links/${encodeURIComponent(link.id)}`, body);
        sent.current = { id: link.id, draft };
        onSaved(saved);
        app.announce("Saved");
      } catch (e) {
        setError({ code: e instanceof ApiError ? e.code : "internal" }); // typed values stay in the form
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
      }
    };

    const state = linkState(link, domain, Math.floor(Date.now() / 1000));
    const who = (id: string) => creatorLabel(id, app.me, app.users);
    const created = who(link.createdBy);
    const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

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
            {live !== "on" && <p className="hint">{LIVE_HINT[live]} These counts leave out yesterday and today.</p>}
          </div>
        )}
        <fieldset className="plain" disabled={!canEdit}>
          <div className="sect">
            <h3>Destination</h3>
            <div className="field">
              <label htmlFor="ld-url">URL</label>
              <input id="ld-url" className="input" ref={urlRef} value={draft.url} readOnly={!canEdit} spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
            </div>
            {error && (
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
                Pass query string through<small>Extra parameters reach the destination</small>
              </div>
              <Switch checked={draft.pass} onChange={(pass) => set({ pass })} label="Pass query string through" />
            </div>
          </div>
        </fieldset>
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
