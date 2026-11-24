import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../api";
import { Confirm } from "../shell/Sheet";
import { Kbd } from "../shell/ui";
import { deleteSecret, putSecret, type SecretSource, type SecretStatus } from "./api";
import { settingsError } from "./copy";

const NAMES = {
  cf: { env: "CF_API_TOKEN", label: "Cloudflare API token", remove: "Remove the Cloudflare token? Adding, attaching and checking domains stops until a new token is set." },
  resend: {
    env: "RESEND_API_KEY", label: "Resend API key",
    remove: "Remove the email key? Sign-in links and invites stop until a new key is pasted or set with wrangler secret put. People without a passkey cannot sign in meanwhile.",
  },
} as const;
const STATUS: Record<SecretSource, string> = { secret: "Set via Worker secret", dashboard: "Set in dashboard", missing: "Missing" };
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
// On a paste this code means the account variables are missing, not the token (the shared text says to add the token).
const errorFor = (c: string) => (c === "cloudflare_not_configured" ? "Set the Cloudflare account variables in the Worker config first, then paste the token." : settingsError(c));

/**
 * A write-only secret (R2). The status line always; a paste field only when no Worker secret sets it and SECRETS_KEY exists,
 * otherwise the wrangler command. The typed value lives only in the input: it is cleared after a save and never kept in state.
 * Reused by the setup wizard.
 */
/** `readOnly`: the status line only, for a settings role that is not an owner (secret writes stay owner only, S8 R5). */
export function SecretField({ name, status, pasteAvailable, onSaved, hint, readOnly = false }: {
  name: "cf" | "resend"; status: SecretSource; pasteAvailable: boolean; onSaved: (s: SecretStatus) => void; hint?: string; readOnly?: boolean;
}) {
  const { env, label, remove } = NAMES[name];
  const [asking, setAsking] = useState(false);
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
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (!input.current?.value.trim()) return; // nothing typed: Ctrl+Enter keeps the page's meaning (the wizard's Continue)
      e.preventDefault();
      save();
    } else if (e.key === "Escape" && input.current?.value) {
      e.preventDefault();
      input.current.value = "";
    }
  };

  if (readOnly)
    return (
      <div className="sfield">
        <div>
          <b>{label}</b>
          <small>{STATUS[status]}</small>
        </div>
      </div>
    );
  const paste = status !== "secret" && pasteAvailable;
  // A dashboard value is the only one in use (no Worker secret), so removing it always asks first.
  const removeBtn = status === "dashboard" && <button type="button" className="btn ghost danger" onClick={() => setAsking(true)} disabled={busy}>Remove</button>;
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
            {/* new-password and a non-login name: browsers neither autofill a saved password here nor offer to save the value. */}
            <input ref={input} id={id} name={`lw-${name}-secret`} className="input" type="password" autoComplete="new-password" spellCheck={false} disabled={busy} />
            <button type="button" className="btn" onClick={save} disabled={busy} aria-keyshortcuts="Control+Enter">Save<Kbd>Ctrl Enter</Kbd></button>
            {removeBtn}
          </div>
        ) : status !== "secret" ? (
          <div>
            <p className="muted hint">Pasting here needs the SECRETS_KEY Worker secret. Without it, set this as a Worker secret from the project folder:</p>
            <code className="cmd">{`npx wrangler secret put ${env} -c wrangler.instance.jsonc`}</code>
            {removeBtn && <div className="row-actions">{removeBtn}</div>}
          </div>
        ) : null}
      </div>
      {paste && <p className="muted hint">Stored encrypted with this instance's secret key. It is never shown again.{hint ? ` ${hint}` : ""}</p>}
      {error && <p className="err" role="alert">{errorFor(error)}</p>}
      {asking && (
        <Confirm title={`Remove the ${label}`} text={remove} ok="Remove" onCancel={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            void run(() => deleteSecret(name));
          }} />
      )}
    </div>
  );
}
