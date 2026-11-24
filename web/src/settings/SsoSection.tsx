import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, SSO_PROVIDERS, type EmailDomain, type RoleItem, type SsoPatch, type SsoProvider, type SsoSettings } from "../api";
import { errorText, ssoSettingsErrorText } from "../copy";
import { useRoles } from "../people/RolePicker";
import { isOwner } from "../perms";
import { Confirm } from "../shell/Sheet";
import { Kbd, Switch } from "../shell/ui";
import { useApp } from "../state";
import { useUnsaved } from "../unsaved";

const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
type Msg = { text: string; error: boolean } | null;
const Note = ({ msg }: { msg: Msg }) =>
  msg && <p className={msg.error ? "err" : "muted"} role={msg.error ? "alert" : "status"}>{msg.text}</p>;

const TITLE: Record<SsoProvider, string> = { google: "Google", github: "GitHub", oidc: "Single sign-on (OIDC)" };
const ON_HINT: Record<SsoProvider, string> = {
  google: "Shows Continue with Google on the sign-in page once the client ID and secret are set",
  github: "Shows Continue with GitHub on the sign-in page once the client ID and secret are set. Only a verified primary email counts",
  oidc: "Shows your button on the sign-in page once the issuer, client ID and secret are set. Works with Okta, Authentik, Google and others",
};

type Draft = { enabled: boolean; clientId: string; issuer: string; label: string };
type DraftKey = keyof Draft;
/** One write at a time for the whole section, so answers cannot land out of order. True when `fn` finished; a throw passes through. */
type Serial = (fn: () => Promise<void>) => Promise<boolean>;
const draftOf = (s: SsoSettings, p: SsoProvider): Draft => {
  const c = s[p];
  return { enabled: c.enabled, clientId: c.clientId, issuer: "issuer" in c ? c.issuer : "", label: "label" in c ? c.label : "" };
};

/** One provider: on/off, client ID, the write-only client secret, the OIDC issuer and button label, and its redirect URI. */
function ProviderCard({ p, s, owner, onSaved, serial, busy }: {
  p: SsoProvider; s: SsoSettings; owner: boolean; onSaved: (p: SsoProvider, n: SsoSettings) => void; serial: Serial; busy: boolean;
}) {
  const { announce } = useApp();
  const id = useId();
  // Only the fields the person edited: the rest always follow the saved settings, so a newer server value is never sent back as an edit.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [typed, setTyped] = useState(false); // a secret is in the field; its value never enters React state
  const secret = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [asking, setAsking] = useState(false);
  const base = draftOf(s, p);
  const draft: Draft = { ...base, ...edits };
  const keys: DraftKey[] = p === "oidc" ? ["enabled", "clientId", "issuer", "label"] : ["enabled", "clientId"];
  const changed = keys.filter((k) => edits[k] !== undefined && edits[k] !== base[k]);
  useUnsaved(changed.length > 0 || typed);

  // `keepEdits`: removing the secret leaves the other unsaved fields as they are.
  const put = async (body: SsoPatch, done: string, keepEdits = false) => {
    setMsg(null);
    try {
      await serial(async () => {
        const n = await api<SsoSettings>("PUT", `/api/settings/sso/${p}`, body);
        if (secret.current) secret.current.value = "";
        setTyped(false);
        if (!keepEdits) setEdits({});
        onSaved(p, n);
        setMsg({ text: done, error: false });
      });
    } catch (e) {
      setMsg({ text: ssoSettingsErrorText(code(e)), error: true });
    }
  };
  const save = () => {
    const value = secret.current?.value.trim() ?? "";
    const body: SsoPatch = Object.fromEntries(changed.map((k) => [k, typeof draft[k] === "string" ? (draft[k] as string).trim() : draft[k]]));
    if (value) body.clientSecret = value; // left out unless typed: an empty string would clear the saved one
    if (Object.keys(body).length === 0) return setMsg({ text: errorText("no_changes"), error: false });
    void put(body, "Saved.");
  };
  const revert = () => {
    setEdits({});
    if (secret.current) secret.current.value = "";
    setTyped(false);
    setMsg(null);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy) save();
    } else if (e.key === "Escape" && (changed.length > 0 || typed)) {
      e.preventDefault();
      revert();
    }
  };
  const set = (v: Partial<Draft>) => setEdits((d) => ({ ...d, ...v }));
  const uri = s.redirectUris[p];
  const copy = () =>
    Promise.resolve().then(() => navigator.clipboard.writeText(uri)).then(() => announce("Copied"), () => announce("Could not copy. Select the address and copy it."));
  const secretSet = s[p].secretSet;

  return (
    <div className="sso-card" role="group" aria-labelledby={`${id}-h`} onKeyDown={onKeyDown}>
      <h3 id={`${id}-h`}>
        {TITLE[p]}
        <Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={`Turn on ${TITLE[p]} sign-in`} disabled={busy} describedBy={`${id}-on`} />
      </h3>
      <small className="hint" id={`${id}-on`}>{ON_HINT[p]}</small>
      <div className="sfield">
        <div>
          <b>Redirect URI</b>
          <small>Paste this into the provider's app settings exactly</small>
        </div>
        <div className="sso-uri">
          <span className="mono">{uri}</span>
          <button type="button" className="btn" onClick={() => void copy()} aria-label={`Copy the ${TITLE[p]} redirect URI`}>Copy</button>
        </div>
      </div>
      {p === "oidc" && (
        <>
          <div className="sfield">
            <div><b><label htmlFor={`${id}-iss`}>Issuer</label></b><small>The https address your identity provider publishes</small></div>
            <div><input id={`${id}-iss`} className="input" type="url" inputMode="url" placeholder="https://login.example.com" spellCheck={false} autoComplete="off" disabled={busy} value={draft.issuer} onChange={(e) => set({ issuer: e.target.value })} /></div>
          </div>
          <div className="sfield">
            <div><b><label htmlFor={`${id}-lbl`}>Button label</label></b><small>The button text on the sign-in page</small></div>
            <div><input id={`${id}-lbl`} className="input sans" placeholder="Single sign-on" maxLength={40} autoComplete="off" disabled={busy} value={draft.label} onChange={(e) => set({ label: e.target.value })} /></div>
          </div>
        </>
      )}
      <div className="sfield">
        <div><b><label htmlFor={`${id}-cid`}>Client ID</label></b></div>
        <div><input id={`${id}-cid`} className="input" spellCheck={false} autoComplete="off" disabled={busy} value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} /></div>
      </div>
      <div className="sfield">
        <div>
          <b>{owner && s.secretsReady ? <label htmlFor={`${id}-sec`}>Client secret</label> : "Client secret"}</b>
          <small>{secretSet ? "Set" : "Not set"}</small>
        </div>
        {!owner ? (
          <p className="muted hint">Only an owner can change the client secret.</p>
        ) : !s.secretsReady ? (
          <p className="muted hint">Saving a client secret needs the SECRETS_KEY Worker secret.</p>
        ) : (
          <div className="row-actions secret">
            {/* Uncontrolled on purpose: the value never enters React state, and browsers neither autofill nor offer to save it. */}
            <input ref={secret} id={`${id}-sec`} name={`lw-sso-${p}-secret`} className="input" type="password" autoComplete="new-password" spellCheck={false}
              placeholder={secretSet ? "Paste a new secret to replace it" : ""} disabled={busy} onInput={(e) => setTyped(e.currentTarget.value !== "")} />
            {secretSet && <button type="button" className="btn ghost danger" disabled={busy} onClick={() => setAsking(true)}>Remove</button>}
          </div>
        )}
      </div>
      <div className="row-actions save-row">
        <button type="button" className="btn primary" disabled={busy} onClick={save} aria-keyshortcuts="Control+Enter">Save<Kbd>Ctrl Enter</Kbd></button>
      </div>
      <Note msg={msg} />
      {asking && (
        <Confirm title={`Remove the ${TITLE[p]} client secret`} ok="Remove"
          text={p === "oidc"
            ? "Single sign-on (OIDC) stops working until a new secret is saved. People at an enforced email domain cannot sign in until then, except owners; everyone else can still use email links and passkeys."
            : `${TITLE[p]} sign-in stops working until a new secret is saved. People can still use email links and passkeys, unless their email domain enforces single sign-on.`}
          onCancel={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            void put({ clientSecret: "" }, "Removed the client secret.", true);
          }} />
      )}
    </div>
  );
}

/** The roles auto-join may give: never Owner. Without the role list (it needs people.manage) only Member and the roles already in use. */
function joinRoles(roles: RoleItem[] | null, rows: EmailDomain[]): { id: string; name: string }[] {
  const list = roles ? roles.filter((r) => r.builtin !== "owner" && r.id !== "owner") : [{ id: "member", name: "Member" }];
  const extra = rows.map((r) => r.joinRoleId).filter((x): x is string => !!x && x !== "owner" && !list.some((r) => r.id === x));
  return [...list, ...[...new Set(extra)].map((x) => ({ id: x, name: x }))];
}

function RoleSelect({ value, onChange, options, label, disabled, id }: {
  value: string | null; onChange: (v: string | null) => void; options: { id: string; name: string }[]; label: string; disabled?: boolean; id?: string;
}) {
  return (
    <select id={id} className="input" aria-label={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No auto-join</option>
      {options.map((r) => <option key={r.id} value={r.id}>Join as {r.name}</option>)}
    </select>
  );
}

/** Email domains: auto-join on first sign-in with a role, and enforce single sign-on (R7, R8). Each change saves at once. */
function EmailDomains({ s, onChange, serial, busy }: { s: SsoSettings; onChange: (f: (rows: EmailDomain[]) => EmailDomain[]) => void; serial: Serial; busy: boolean }) {
  const { roles } = useRoles();
  const options = joinRoles(roles, s.emailDomains);
  const [domain, setDomain] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [enforce, setEnforce] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const addId = useId();

  /** True when `fn` finished. */
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setMsg(null);
    try {
      return await serial(fn);
    } catch (e) {
      setMsg({ text: ssoSettingsErrorText(code(e)), error: true });
      return false;
    }
  };
  const put = (row: EmailDomain) =>
    run(async () => {
      await api("PUT", `/api/settings/email-domains/${encodeURIComponent(row.domain)}`, { joinRoleId: row.joinRoleId, enforceSso: row.enforceSso });
      onChange((rows) => (rows.some((r) => r.domain === row.domain) ? rows.map((r) => (r.domain === row.domain ? row : r)) : [...rows, row]));
    });
  const add = (e: FormEvent) => {
    e.preventDefault();
    const d = domain.trim().toLowerCase().replace(/^@/, "");
    if (!d) return;
    // Add never overwrites: an existing row keeps its role and enforcement until changed in that row.
    if (s.emailDomains.some((r) => r.domain === d)) return setMsg({ text: ssoSettingsErrorText("domain_listed"), error: true });
    void put({ domain: d, joinRoleId: role, enforceSso: enforce }).then((ok) => {
      if (!ok) return;
      setDomain("");
      setRole(null);
      setEnforce(false);
    });
  };
  const remove = (d: string) =>
    run(async () => {
      await api("DELETE", `/api/settings/email-domains/${encodeURIComponent(d)}`);
      onChange((rows) => rows.filter((r) => r.domain !== d));
    });
  // OIDC can start only when it is on and has its issuer, client ID and secret (the server's ready check).
  const oidcReady = s.oidc.enabled && s.oidc.secretSet && s.oidc.clientId !== "" && s.oidc.issuer !== "";
  const unguarded = !oidcReady && s.emailDomains.some((r) => r.enforceSso);

  return (
    <>
      <h3 className="sso-sub">Email domains</h3>
      <p className="hint">People with an address at these domains can join on their first sign-in with the role you pick. Enforcing single sign-on stops email links, passkeys, Google and GitHub for them; owners can always sign in.</p>
      {unguarded && <p className="callout wait" role="status">Single sign-on (OIDC) is not ready: it is off, or its issuer, client ID or secret is missing. People at an enforced domain cannot sign in until it is, except owners.</p>}
      <div className="sso-doms">
        <table aria-label="Email domains">
          <thead>
            <tr><th>Domain</th><th>Auto-join</th><th>Enforce single sign-on</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {s.emailDomains.map((r) => (
              <tr key={r.domain}>
                <td className="mono">{r.domain}</td>
                <td><RoleSelect value={r.joinRoleId} options={options} disabled={busy} label={`Auto-join role for ${r.domain}`} onChange={(v) => void put({ ...r, joinRoleId: v })} /></td>
                <td><Switch checked={r.enforceSso} disabled={busy} label={`Enforce single sign-on for ${r.domain}`} onChange={(v) => void put({ ...r, enforceSso: v })} /></td>
                <td><button type="button" className="btn ghost danger" disabled={busy} aria-label={`Remove ${r.domain}`} onClick={() => setRemoving(r.domain)}>Remove</button></td>
              </tr>
            ))}
            <tr>
              <td>
                <form id={addId} onSubmit={add}>
                  <input className="input" aria-label="New email domain" placeholder="example.com" spellCheck={false} autoComplete="off" autoCapitalize="none" maxLength={253} disabled={busy}
                    value={domain} onChange={(e) => setDomain(e.target.value)} />
                </form>
              </td>
              <td><RoleSelect value={role} options={options} disabled={busy} label="Auto-join role for the new domain" onChange={setRole} /></td>
              <td><Switch checked={enforce} disabled={busy} label="Enforce single sign-on for the new domain" onChange={setEnforce} /></td>
              <td><button type="submit" form={addId} className="btn" disabled={busy || !domain.trim()}>Add domain</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <Note msg={msg} />
      {removing && (
        <Confirm title={`Remove ${removing}`} ok="Remove" text="People at this domain no longer join by themselves, and single sign-on is no longer enforced for them."
          onCancel={() => setRemoving(null)}
          onOk={() => {
            const d = removing;
            setRemoving(null);
            void remove(d);
          }} />
      )}
    </>
  );
}

/** Settings > Sign-in, app mode: the three providers and the email domains (S14). Needs the settings permission; secrets stay owner only. */
export function SsoSettingsBlock() {
  const { me } = useApp();
  const [s, setS] = useState<SsoSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const serial = useCallback<Serial>(async (fn) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
      return true;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api<SsoSettings>("GET", "/api/settings/sso", undefined, ac.signal).then(setS, (e: unknown) => !ac.signal.aborted && setError(code(e)));
    return () => ac.abort();
  }, [tries]);

  if (!s)
    return error ? (
      <p className="err" role="alert">
        {ssoSettingsErrorText(error)}
        <button type="button" className="btn" onClick={() => setTries((n) => n + 1)}>Retry</button>
      </p>
    ) : <p className="muted" role="status">Loading</p>;
  const owner = isOwner(me);
  return (
    <div className="sso">
      <h3 className="sso-sub">Single sign-on</h3>
      {!owner && <p className="muted hint">Only an owner can change sign-in settings.</p>}
      {/* Non-owners read only: every write here is owner only on the server (R14). */}
      {SSO_PROVIDERS.map((p) => <ProviderCard key={p} p={p} s={s} owner={owner} serial={serial} busy={busy || !owner}
        onSaved={(q, n) => setS((cur) => cur && { ...cur, [q]: n[q], redirectUris: n.redirectUris, secretsReady: n.secretsReady })} />)}
      <EmailDomains s={s} serial={serial} busy={busy || !owner} onChange={(f) => setS((cur) => cur && { ...cur, emailDomains: f(cur.emailDomains) })} />
    </div>
  );
}
