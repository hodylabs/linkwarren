import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type PasskeyItem, type SessionItem } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { Tag } from "../shell/ui";
import { clock, shortDate } from "../time";
import { addPasskey, passkeysSupported } from "../signin/passkey";
import { withBase } from "../base";

/** Sign-in and security hotkeys and their text on the shortcuts sheet. */
export const ACCOUNT_KEYS = {
  j: "Next passkey or session",
  k: "Previous passkey or session",
  a: "Add a passkey",
  r: "Rename the selected passkey",
  "shift+d": "Remove the selected passkey, or end the selected session",
} as const;

type Data = { passkeys: PasskeyItem[]; sessions: SessionItem[] };
type Confirm = { kind: "remove"; passkey: PasskeyItem } | { kind: "end"; session: SessionItem } | { kind: "all" };

const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
/** Where the page goes after this device is signed out. */
const goHome = () => location.assign(withBase("/"));

/** Passkeys and sessions of the signed-in person (app mode). Reused by the account sheet and by Settings. */
export function AccountPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [renaming, setRenaming] = useState<PasskeyItem | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false); // a write is in flight: a second Enter or click does nothing
  const supported = passkeysSupported();

  const loadGen = useRef(0); // only the newest refresh may write: an older, slower answer is dropped
  const renameGen = useRef(0); // which rename dialog a pending save belongs to

  const load = useCallback(async () => {
    const g = ++loadGen.current;
    try {
      const d = await api<Data>("GET", "/api/account");
      if (g === loadGen.current) setData(d);
    } catch (e) {
      if (g === loadGen.current) setError(code(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const ids = data ? [...data.passkeys.map((p) => p.id), ...data.sessions.map((s) => s.id)] : [];
  const passkey = data?.passkeys.find((p) => p.id === sel) ?? null;
  const session = data?.sessions.find((s) => s.id === sel) ?? null;
  const endable = session && !session.current ? session : null;

  // `final`: success ends the page (sign out), so the guard stays shut and a repeated Enter cannot post again.
  const run = async (fn: () => Promise<unknown>, after?: () => void, final = false) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      if (final) return;
    } catch (e) {
      setError(code(e));
    }
    working.current = false;
    setBusy(false);
  };

  const move = (step: 1 | -1) => {
    if (ids.length === 0) return;
    const i = sel === null ? (step === 1 ? 0 : ids.length - 1) : Math.min(Math.max(ids.indexOf(sel) + step, 0), ids.length - 1);
    setSel(ids[i]!);
  };
  // Enter or Space on a focused row selects it, which reveals its actions.
  const rowKey = (id: string) => (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setSel(id);
  };
  const add = () => run(() => addPasskey(), () => void load());
  const startRename = () => {
    if (!passkey) return;
    renameGen.current++;
    setName(passkey.name);
    setRenaming(passkey);
  };
  const ask = () => {
    if (passkey) setConfirm({ kind: "remove", passkey });
    else if (endable) setConfirm({ kind: "end", session: endable });
  };
  const doConfirm = () => {
    const c = confirm;
    if (!c) return;
    if (c.kind === "all") return run(() => api("POST", "/api/account/sign-out-everywhere", {}), goHome, true);
    const path = c.kind === "remove" ? `/api/account/passkeys/${c.passkey.id}` : `/api/account/sessions/${c.session.id}`;
    return run(() => api("DELETE", path), () => {
      setConfirm(null);
      setSel(null);
      void load();
    });
  };
  const doRename = () => {
    const r = renaming;
    if (!r) return;
    const mine = renameGen.current;
    void run(() => api("PATCH", `/api/account/passkeys/${r.id}`, { name }), () => {
      if (renameGen.current === mine) setRenaming(null); // a late answer must not close a newer dialog
      void load();
    });
  };

  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      a: () => void (supported && add()),
      r: startRename,
      "shift+d": ask,
    } satisfies Bindings<typeof ACCOUNT_KEYS>,
    confirm === null && renaming === null,
  );

  if (!data) return error ? <p className="err" role="alert">{errorText(error)}</p> : <p className="muted">Loading</p>;

  const method = (m: SessionItem["method"]) => (m === "passkey" ? "a passkey" : "an email link");
  return (
    <div className="acct">
      {error && !confirm && !renaming && <p className="err" role="alert">{errorText(error)}</p>}
      <div className="p-sec">Passkeys</div>
      {data.passkeys.length === 0 && <p className="muted acct-empty">No passkeys yet. You sign in with an email link.</p>}
      <ul className="acct-list" aria-label="Passkeys">
        {data.passkeys.map((p) => (
          <li key={p.id} className="acct-row" aria-current={p.id === sel ? "true" : undefined} tabIndex={0} onClick={() => setSel(p.id)} onKeyDown={rowKey(p.id)}>
            <div className="acct-main">
              <b>{p.name}</b> {p.backedUp && <Tag tone="off">Synced</Tag>}
              <br />
              <small className="muted">
                Added {shortDate(p.createdAt)}, {p.lastUsedAt === null ? "Never used" : `Last used ${shortDate(p.lastUsedAt)}`}
              </small>
            </div>
            {p.id === sel && (
              <div className="row-actions">
                <button type="button" className="btn" aria-keyshortcuts="R" onClick={startRename}>
                  Rename <span className="k">R</span>
                </button>
                <button type="button" className="btn" aria-keyshortcuts="Shift+D" onClick={ask}>
                  Remove <span className="k">Shift D</span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {supported && (
        <button type="button" className="btn" disabled={busy} aria-keyshortcuts="A" onClick={() => void add()}>
          Add a passkey <span className="k">A</span>
        </button>
      )}
      <div className="p-sec">Sessions</div>
      <ul className="acct-list" aria-label="Sessions">
        {data.sessions.map((s) => (
          <li key={s.id} className="acct-row" aria-current={s.id === sel ? "true" : undefined} tabIndex={0} onClick={() => setSel(s.id)} onKeyDown={rowKey(s.id)}>
            <div className="acct-main">
              <b>{s.device ?? "Unknown device"}</b> {s.current && <Tag tone="ok">This device</Tag>}
              <br />
              <small className="muted">
                Signed in {shortDate(s.createdAt)} with {method(s.method)}, Last active {clock(s.lastSeenAt)}
                {s.ipPrefix && <> <span className="mono">{s.ipPrefix}</span></>}
              </small>
            </div>
            {s.id === sel && !s.current && (
              <div className="row-actions">
                <button type="button" className="btn" aria-keyshortcuts="Shift+D" onClick={ask}>
                  End <span className="k">Shift D</span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={busy} onClick={() => setConfirm({ kind: "all" })}>
        Sign out everywhere
      </button>
      {confirm && (
        <Sheet label={confirm.kind === "all" ? "Sign out everywhere" : confirm.kind === "remove" ? "Remove passkey" : "End session"} onClose={() => { setConfirm(null); setError(null); }}>
          <div className="sh-head">
            <h2>{confirm.kind === "all" ? "Sign out everywhere" : confirm.kind === "remove" ? "Remove passkey" : "End session"}</h2>
          </div>
          <div className="sh-body">
            <p>
              {confirm.kind === "all" && "Sign out on every device, including this one?"}
              {confirm.kind === "remove" && `Remove ${confirm.passkey.name}? You can still sign in with an email link.`}
              {confirm.kind === "end" && `Sign out ${confirm.session.device ?? "Unknown device"}?`}
            </p>
            {error && <p className="err" role="alert">{errorText(error)}</p>}
            <div className="actions">
              <button type="button" className="btn primary" autoFocus disabled={busy} onClick={() => void doConfirm()}>
                {confirm.kind === "remove" ? "Remove" : confirm.kind === "end" ? "Sign out" : "Sign out everywhere"} <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={() => { setConfirm(null); setError(null); }}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
      {renaming && (
        // A sheet of its own so Esc cancels only the rename, not the sheet this panel sits in.
        <Sheet label="Rename passkey" onClose={() => { setRenaming(null); setError(null); }}>
          <div className="sh-head">
            <h2>Rename passkey</h2>
          </div>
          <div className="sh-body">
            <div className="field stack">
              <label htmlFor="acct-name">Name</label>
              <input
                id="acct-name"
                className="input sans"
                autoFocus
                maxLength={40}
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    doRename();
                  }
                }}
              />
            </div>
            {error && <p className="err" role="alert">{errorText(error)}</p>}
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={doRename}>
                Save <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={() => { setRenaming(null); setError(null); }}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
