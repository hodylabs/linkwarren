import { useEffect, useRef, useState } from "react";
import { api, ApiError, type NewShare, type ShareItem } from "../api";
import { errorText } from "../copy";
import { Icon } from "../shell/ui";
import { useApp } from "../state";
import { shortDate } from "../time";

/**
 * S13 share pages of one link or one domain: a read-only page of totals at an unguessable URL. The URL is shown once, right
 * after it is made (only its hash is kept); the list shows when each active one was made, with Revoke. Rendered only for people
 * who may edit the link or manage the domain (the server checks again).
 */
export function SharePanel({ scope, id }: { scope: "link" | "domain"; id: string }) {
  const app = useApp();
  const [items, setItems] = useState<ShareItem[] | null>(null);
  const [made, setMade] = useState<NewShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const fail = (e: unknown) => setError(errorText(e instanceof ApiError ? e.code : "internal"));

  useEffect(() => {
    setItems(null);
    setMade(null);
    setError(null);
    const ac = new AbortController();
    api<{ items: ShareItem[] }>("GET", `/api/shares?${scope}=${encodeURIComponent(id)}`, undefined, ac.signal).then((r) => setItems(r.items), (e: unknown) => {
      if (!ac.signal.aborted) fail(e);
    });
    return () => ac.abort();
  }, [scope, id]);

  const once = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
    busy.current = false;
  };
  const create = () => once(async () => {
    const s = await api<NewShare>("POST", "/api/shares", { scope, id });
    setMade(s);
    setItems((cur) => [s, ...(cur ?? [])]);
  });
  const revoke = (s: ShareItem) => once(async () => {
    await api<void>("DELETE", `/api/shares/${encodeURIComponent(s.id)}`);
    setItems((cur) => (cur ?? []).filter((x) => x.id !== s.id));
    if (made?.id === s.id) setMade(null);
    app.announce("Share page turned off");
  });
  const copy = (url: string) => navigator.clipboard.writeText(url).then(() => app.announce("Copied"), () => app.announce("Could not copy"));

  return (
    <div className="sect">
      <h3>
        Share page{items && items.length > 0 && <span className="muted">{items.length}</span>}
        <button type="button" className="btn sm end" onClick={() => void create()} disabled={!items}>
          <Icon name="plus" />New share link
        </button>
      </h3>
      {made && (
        <div className="share-url">
          <input className="input" readOnly value={made.url} aria-label="Share page URL" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn sm" onClick={() => void copy(made.url)}>
            <Icon name="copy" />Copy
          </button>
        </div>
      )}
      {made && <p className="hint">Copy it now: it is shown only once. Anyone with it sees totals for the last 30 days, never who clicked.</p>}
      {items && items.length > 0 && (
        <ul className="rows" aria-label="Active share pages">
          {items.map((s) => (
            <li key={s.id}>
              <Icon name="globe" />Made {shortDate(s.createdAt)}
              <button type="button" className="btn sm end" onClick={() => void revoke(s)} aria-label={`Turn off the share page made ${shortDate(s.createdAt)}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {items && items.length === 0 && !made && <p className="hint">A read-only page of click totals for a client, at a link you can turn off.</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
