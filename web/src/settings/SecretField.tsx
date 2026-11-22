import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../api";
import { Kbd } from "../shell/ui";
import { deleteSecret, putSecret, type SecretSource, type SecretStatus } from "./api";
import { settingsError } from "./copy";

const NAMES = { cf: { env: "CF_API_TOKEN", label: "Cloudflare API token" }, resend: { env: "RESEND_API_KEY", label: "Resend API key" } } as const;
const STATUS: Record<SecretSource, string> = { secret: "Set via Worker secret", dashboard: "Set in dashboard", missing: "Missing" };
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");

/**
 * A write-only secret (R2). The status line always; a paste field only when no Worker secret sets it and SECRETS_KEY exists,
 * otherwise the wrangler command. The typed value lives only in the input: it is cleared after a save and never kept in state.
 * Reused by the setup wizard.
 */
export function SecretField({ name, status, pasteAvailable, onSaved, hint }: {
  name: "cf" | "resend"; status: SecretSource; pasteAvailable: boolean; onSaved: (s: SecretStatus) => void; hint?: string;
}) {
  const { env, label } = NAMES[name];
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const run = async (fn: () => Promise<SecretStatus>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (input.current) input.current.value = "";
      onSaved(s);
    } catch (e) {
      setError(code(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const save = () => {
    const value = input.current?.value.trim() ?? "";
    if (value) void run(() => putSecret(name, value));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape" && input.current?.value) {
      e.preventDefault();
      input.current.value = "";
    }
  };

  const paste = status !== "secret" && pasteAvailable;
  return (
    <div className="secret" onKeyDown={onKeyDown}>
      <div className="sfield">
        <div>
          <b>{paste ? <label htmlFor={id}>{label}</label> : label}</b>
          <small>{STATUS[status]}</small>
        </div>
        {paste ? (
          <div className="row-actions">
            {/* Uncontrolled on purpose: the value never enters React state. */}
            <input ref={input} id={id} className="input" type="password" autoComplete="off" spellCheck={false} disabled={busy} />
            <button type="button" className="btn" onClick={save} disabled={busy} aria-keyshortcuts="Control+Enter">Save<Kbd>Ctrl Enter</Kbd></button>
            {status === "dashboard" && <button type="button" className="btn ghost" onClick={() => void run(() => deleteSecret(name))} disabled={busy}>Remove</button>}
          </div>
        ) : status !== "secret" ? (
          <code className="cmd">{`npx wrangler secret put ${env}`}</code>
        ) : null}
      </div>
      {paste && <p className="muted hint">Stored encrypted with this instance's secret key. It is never shown again.{hint ? ` ${hint}` : ""}</p>}
      {error && <p className="err" role="alert">{settingsError(error)}</p>}
    </div>
  );
}
