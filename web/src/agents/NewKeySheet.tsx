import { useRef, useState } from "react";
import { api, ApiError, type KeyItem } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { Chip, Seg } from "../shell/ui";
import { useApp } from "../state";

/** New API key sheet hotkeys and their text on the shortcuts sheet. */
export const NEW_KEY_KEYS = {
  "mod+enter": "Create the key, in the New API key sheet",
  c: "Copy the new key, once it is shown",
} as const;
const NAME = /^[a-z0-9-]{1,40}$/; // the server's rule (src/api/keys.ts)
const ACCESS: { value: "read" | "write"; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
];
const EXPIRES = [30, 90, 365].map((value) => ({ value, label: `${value} days` }));

/**
 * The secret lives only in this sheet's state: shown once after create, never put in the URL, app state or a log,
 * and dropped when the sheet unmounts.
 */
export function NewKeySheet() {
  const app = useApp();
  const { me, domains } = app;
  // Same rule as the server's usable domains (src/perm.ts); the server stays the authority.
  const usable = domains.filter(
    (d) => me.role === "owner" || (d.status !== "disabled" && (d.type === "main" || d.isMember || (d.type === "private" && d.ownerId === me.id))),
  );
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [del, setDel] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ask, setAsk] = useState(false);
  const busy = useRef(false);
  const nameError = (name !== "" && !NAME.test(name)) || error === "key_name";

  const submit = async () => {
    if (busy.current || secret !== null) return;
    if (!NAME.test(name)) return setError("key_name");
    busy.current = true;
    setError(null);
    try {
      const res = await api<{ key: KeyItem; secret: string }>("POST", "/api/keys", { name, write, del: write && del, domainIds: picked, expiresInDays: days });
      setSecret(res.secret);
      app.announce(`Created the key ${res.key.name}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal"); // typed values stay in the form
    } finally {
      busy.current = false;
    }
  };
  const copy = () => {
    if (secret === null) return;
    navigator.clipboard.writeText(secret).then(
      () => {
        setCopied(true);
        app.announce("Copied");
      },
      () => app.announce("Could not copy. Select the key and copy it."),
    );
  };
  // Closing before copying loses the key for good, so ask first.
  const dismiss = () => (secret !== null && !copied ? setAsk(true) : app.close());

  useHotkeys({ "mod+enter": () => void submit(), c: copy } satisfies Bindings<typeof NEW_KEY_KEYS>, !ask);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Sheet label="New API key" onClose={dismiss}>
      <div className="sh-head">
        <h2>New API key</h2>
        <span className="x">
          <kbd>Esc</kbd> {secret ? "close" : "cancel"}
        </span>
      </div>
      {secret !== null ? (
        <>
          <div className="sh-body">
            <p>Copy your key now. It is shown only once.</p>
            <div className="mcp">
              <span className="mono secret">{secret}</span>
              <button type="button" className="btn ghost" onClick={copy} aria-keyshortcuts="C">
                Copy <kbd>C</kbd>
              </button>
            </div>
          </div>
          <div className="sh-foot">
            <span className="left">Send it as a Bearer token to /api/v1</span>
            {/* Keyed: without it React reuses the form's Create button here and autoFocus never runs. */}
            <button key="done" type="button" className="btn primary" autoFocus onClick={dismiss}>
              Done<span className="k2">Enter</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sh-body">
            <div className="f">
              <label htmlFor="nk-name">Name</label>
              <div className={nameError ? "ctl bad" : "ctl"}>
                <input id="nk-name" className="mono" autoFocus value={name} spellCheck={false} autoComplete="off" aria-describedby="nk-name-h"
                  aria-invalid={nameError ? true : undefined} onChange={(e) => setName(e.target.value)} />
              </div>
              {nameError ? (
                <p className="err" role="alert">{errorText("key_name")}</p>
              ) : (
                <p className="hint" id="nk-name-h">Lowercase letters, digits and hyphens, for example print-shop-import</p>
              )}
            </div>
            <div className="f">
              <h3 className="lbl">Access</h3>
              <Seg label="Access" options={ACCESS} value={write ? "write" : "read"} onChange={(v) => {
                setWrite(v === "write");
                if (v === "read") setDel(false);
              }} />
              <label className="chk">
                <input type="checkbox" checked={del} disabled={!write} onChange={(e) => setDel(e.target.checked)} />
                Also allow deleting links
              </label>
            </div>
            <div className="f">
              <h3 className="lbl">Domains</h3>
              <div className="chips" role="group" aria-label="Domains">
                <Chip pressed={picked.length === 0} onClick={() => setPicked([])}>All domains I can use</Chip>
                {usable.map((d) => (
                  <Chip key={d.id} pressed={picked.includes(d.id)} onClick={() => toggle(d.id)}>
                    <span className="mono">{d.host}</span>
                  </Chip>
                ))}
              </div>
            </div>
            <div className="f">
              <h3 className="lbl">Expires</h3>
              <Seg label="Expires" options={EXPIRES} value={days} onChange={setDays} />
            </div>
            {error && error !== "key_name" && (
              <p className="err" role="alert">{errorText(error)}</p>
            )}
          </div>
          <div className="sh-foot">
            <span className="left">Works on /api/v1 only</span>
            <button type="button" className="btn primary" aria-keyshortcuts="Control+Enter" onClick={() => void submit()}>
              Create key<span className="k2">Ctrl Enter</span>
            </button>
          </div>
        </>
      )}
      {ask && (
        <Sheet label="Close without copying?" onClose={() => setAsk(false)}>
          <div className="sh-head">
            <h2>Close without copying?</h2>
          </div>
          <div className="sh-body">
            <p>The key is not shown again. If you lose it, revoke it and create a new one.</p>
            <div className="actions">
              <button type="button" className="btn primary" autoFocus onClick={() => app.close()} onKeyDown={(e) => e.repeat && e.preventDefault()}>
                Close <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={() => setAsk(false)}>
                Back <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </Sheet>
  );
}
