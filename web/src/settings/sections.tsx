import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AccountPanel } from "../account/AccountPanel";
import { api, ApiError } from "../api";
import { errorText, plural } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Kbd, Seg, Switch } from "../shell/ui";
import { useApp } from "../state";
import { useUnsaved } from "../unsaved";
import { deleteLogo, logoUrl, patchSettings, putLogo, sendTestEmail, type SecretStatus, type SettingsBody, type SettingsPatch } from "./api";
import { settingsError } from "./copy";
import { exportEstimate, exportFileName, runExport, saveBlob, startExport, type ExportStart } from "./exportRun";
import { LOGO_ACCEPT, readLogoFile } from "./logoFile";
import { SecretField } from "./SecretField";

/** Backups and export hotkeys and their text on the shortcuts sheet. */
export const EXPORT_KEYS = { escape: "Cancel the running export" } as const;

const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
type Msg = { text: string; error: boolean } | null;
const Note = ({ msg }: { msg: Msg }) =>
  msg && <p className={msg.error ? "err" : "muted"} role={msg.error ? "alert" : "status"}>{msg.text}</p>;

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="sfield">
      <div>
        <b>{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div>{children}</div>
    </div>
  );
}

type Key = keyof SettingsPatch;
const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

/** A section's own draft: Ctrl+Enter sends only the changed keys, Esc reverts them. */
function useEdit<K extends Key>(s: SettingsBody, keys: readonly K[], onSaved: (b: SettingsBody) => void) {
  const pick = (b: SettingsBody) => Object.fromEntries(keys.map((k) => [k, b[k]])) as Pick<SettingsBody, K>;
  const [draft, setDraft] = useState(() => pick(s));
  const [msg, setMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const changed = keys.filter((k) => !same(draft[k], s[k]));
  useUnsaved(changed.length > 0);
  const save = async () => {
    if (busy.current) return;
    if (!changed.length) return setMsg({ text: errorText("no_changes"), error: false });
    busy.current = true;
    setSaving(true);
    setMsg(null);
    const sent = draft;
    try {
      const b = await patchSettings(Object.fromEntries(changed.map((k) => [k, draft[k]])) as SettingsPatch);
      onSaved(b);
      // A field edited while the save was on its way keeps the new edit; the rest adopt the server's value.
      setDraft((d) => Object.fromEntries(keys.map((k) => [k, d[k] === sent[k] ? b[k] : d[k]])) as Pick<SettingsBody, K>);
      setMsg({ text: "Saved.", error: false });
    } catch (e) {
      setMsg({ text: settingsError(code(e)), error: true });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape" && changed.length) {
      e.preventDefault();
      setDraft(pick(s));
      setMsg(null);
    }
  };
  const set = (p: Partial<Pick<SettingsBody, K>>) => setDraft((d) => ({ ...d, ...p }));
  return { draft, set, save, onKeyDown, msg, saving };
}

const SaveButton = ({ onClick, disabled }: { onClick: () => void; disabled: boolean }) => (
  <div className="row-actions save-row">
    <button type="button" className="btn primary" onClick={onClick} disabled={disabled} aria-keyshortcuts="Control+Enter">Save<Kbd>Ctrl Enter</Kbd></button>
  </div>
);

export function InstanceSection({ s, onSaved }: { s: SettingsBody; onSaved: (b: SettingsBody) => void }) {
  const { domains, instance, reloadInstance } = useApp();
  const e = useEdit(s, ["name", "mainDomainId"] as const, (b) => {
    onSaved(b);
    void reloadInstance().catch(() => undefined);
  });
  const file = useRef<HTMLInputElement>(null);
  const [logoMsg, setLogoMsg] = useState<Msg>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const mains = domains.filter((d) => d.type === "main" && d.status !== "disabled");
  const logo = async (fn: () => Promise<unknown>) => {
    setLogoBusy(true);
    setLogoMsg(null);
    try {
      await fn();
      await reloadInstance().catch(() => undefined);
    } catch (err) {
      setLogoMsg({ text: settingsError(code(err)), error: true });
    } finally {
      setLogoBusy(false);
    }
  };
  const upload = async (f: File | undefined) => {
    if (file.current) file.current.value = ""; // the same file can be picked again after a fix
    if (!f) return;
    await logo(async () => {
      const r = await readLogoFile(f);
      if ("error" in r) throw new ApiError(400, r.error); // shown like the server's own refusal
      await putLogo(r);
    });
  };
  return (
    <section className="sblock" aria-labelledby="st-instance" onKeyDown={e.onKeyDown}>
      <h2 id="st-instance">This instance</h2>
      <Field label="Name" hint="Shown in the sidebar and in emails" htmlFor="st-name">
        <input id="st-name" className="input sans" value={e.draft.name ?? ""} spellCheck={false} autoComplete="off" onChange={(ev) => e.set({ name: ev.target.value })} />
      </Field>
      <Field label="Logo" hint="PNG, WebP or JPEG, square, up to 1024 px and 64 KB. Falls back to the linkwarren rabbit">
        <div className="logo-up">
          <img src={logoUrl(instance?.logoVersion ?? null)} alt="" />
          <input ref={file} type="file" accept={LOGO_ACCEPT} hidden aria-label="Logo file" onChange={(ev) => void upload(ev.target.files?.[0])} />
          <button type="button" className="btn" disabled={logoBusy} onClick={() => file.current?.click()}>Replace</button>
          {instance?.logoVersion != null && <button type="button" className="btn ghost" disabled={logoBusy} onClick={() => void logo(deleteLogo)}>Remove</button>}
        </div>
        <Note msg={logoMsg} />
      </Field>
      <Field label="Dashboard address" hint="Where you and your team sign in. Short links never use it">
        <span className="mono">{s.dashboardHost}</span>
      </Field>
      <Field label="Main domain" hint="Every person can create links here" htmlFor="st-main">
        <select id="st-main" className="input" value={e.draft.mainDomainId ?? ""} onChange={(ev) => e.set({ mainDomainId: ev.target.value })}>
          {!mains.some((d) => d.id === e.draft.mainDomainId) && <option value="" disabled>Pick a main domain</option>}
          {mains.map((d) => <option key={d.id} value={d.id}>{d.host}</option>)}
        </select>
      </Field>
      <SaveButton onClick={() => void e.save()} disabled={e.saving} />
      <Note msg={e.msg} />
    </section>
  );
}

export function SignInSection({ s }: { s: SettingsBody }) {
  return (
    <section className="sblock" aria-labelledby="st-signin">
      <h2 id="st-signin">Sign-in</h2>
      {s.authMode === "access" ? (
        <Field label="Sign-in" hint="Proves who people are. Who gets in is decided by People in this app">
          <span>Cloudflare Access</span>
          {s.teamDomain && <small className="mono block">{s.teamDomain}</small>}
        </Field>
      ) : (
        <>
          <p>linkwarren sign-in: email link and passkeys</p>
          <AccountPanel />
        </>
      )}
    </section>
  );
}

const RESEND_HINT =
  "A fresh instance needs the RESEND_API_KEY Worker secret, because the owner signs in by email. A key pasted here is used only when no Worker secret is set; a Worker secret always wins.";

export function EmailSection({ s, onSecrets }: { s: SettingsBody; onSecrets: (st: SecretStatus) => void }) {
  const { me } = useApp();
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false); // a double click sends one test email
  const test = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMsg(null);
    try {
      await sendTestEmail();
      setMsg({ text: `Sent to ${me.email}.`, error: false });
    } catch (e) {
      setMsg({ text: settingsError(code(e)), error: true });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="sblock" aria-labelledby="st-email">
      <h2 id="st-email">Email</h2>
      <Field label="Sender" hint="The EMAIL_FROM variable in the Worker config">
        <span className={s.emailFrom ? "mono" : "muted"}>{s.emailFrom ?? "Not set. Add EMAIL_FROM to the Worker config."}</span>
      </Field>
      <SecretField name="resend" status={s.secrets.resend} pasteAvailable={s.secrets.pasteAvailable} onSaved={onSecrets} hint={s.authMode === "app" ? RESEND_HINT : undefined} />
      <Field label="Test email" hint="Sends a short message to you">
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => void test()} disabled={busy}>Send test email</button>
        </div>
      </Field>
      <Note msg={msg} />
    </section>
  );
}

export function LinkDefaultsSection({ s, onSaved }: { s: SettingsBody; onSaved: (b: SettingsBody) => void }) {
  const { reloadInstance } = useApp();
  const e = useEdit(s, ["linkRedirectCode", "linkPassQuery"] as const, (b) => {
    onSaved(b);
    void reloadInstance().catch(() => undefined);
  });
  return (
    <section className="sblock" aria-labelledby="st-links" onKeyDown={e.onKeyDown}>
      <h2 id="st-links">Link defaults</h2>
      <Field label="Redirect" hint="New links start with this. Browsers remember a 301, so it cannot be changed later">
        <Seg options={[{ value: 302, label: "302 editable" }, { value: 301, label: "301 fixed" }]} value={e.draft.linkRedirectCode} onChange={(v) => e.set({ linkRedirectCode: v })} label="Redirect" />
      </Field>
      <div className="toggle sfield">
        <div>
          <b>Pass query string through</b>
          <small>Adds the visitor's ?utm_ and other parameters to the destination</small>
        </div>
        <Switch checked={e.draft.linkPassQuery} onChange={(v) => e.set({ linkPassQuery: v })} label="Pass query string through" />
      </div>
      <SaveButton onClick={() => void e.save()} disabled={e.saving} />
      <Note msg={e.msg} />
    </section>
  );
}

export function DataSection({ s }: { s: SettingsBody }) {
  const years = Math.round(s.retention.auditDays / 365);
  return (
    <section className="sblock" aria-labelledby="st-data">
      <h2 id="st-data">Data and retention</h2>
      <Field label="Audit log" hint="Every change by every person and agent"><span>Keep {plural(years, "year")}</span></Field>
      <Field label="Click details" hint="Totals are kept as long as the link exists"><span>Keep {s.retention.clickDetailDays} days, then daily totals</span></Field>
      <Field label="Deleted slugs" hint="Stops a printed QR code being taken over"><span>Locked until the owner releases them</span></Field>
    </section>
  );
}

type Progress = Record<string, number>;
type Run = { phase: "idle" | "starting" } | { phase: "confirm"; start: ExportStart } | { phase: "running" | "done"; start: ExportStart; progress: Progress };

/** "About N rows to read, X% of the free daily D1 reads for the whole Cloudflare account." */
function estimateText(start: ExportStart) {
  const est = exportEstimate(start);
  return `About ${est.reads.toLocaleString("en-US")} ${est.reads === 1 ? "row" : "rows"} to read, ${Math.round(est.share * 100)}% of the free daily D1 reads for the whole Cloudflare account.`;
}

export function BackupsSection() {
  const { overlay } = useApp();
  const [analytics, setAnalytics] = useState(false);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const starting = run.phase === "starting";
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []); // leaving the section cancels a running export

  const page = async (start: ExportStart, ac: AbortController) => {
    const progress: Progress = {};
    setRun({ phase: "running", start, progress });
    try {
      const blob = await runExport(api, start, (p) => {
        progress[p.table] = p.rows;
        setRun({ phase: "running", start, progress: { ...progress } });
      }, ac.signal);
      if (ac.signal.aborted) return;
      saveBlob(blob, exportFileName(new Date()));
      setRun({ phase: "done", start, progress: { ...progress } });
    } catch (e) {
      setRun({ phase: "idle" });
      if (!ac.signal.aborted) setError(code(e));
    } finally {
      if (abort.current === ac) abort.current = null;
    }
  };
  const begin = async () => {
    if (abort.current) return;
    const ac = (abort.current = new AbortController());
    setError(null);
    setRun({ phase: "starting" });
    try {
      const start = await startExport(api, { includeAnalytics: analytics }, ac.signal);
      if (ac.signal.aborted) return; // cancelled while /start was on its way
      if (exportEstimate(start).confirm) {
        abort.current = null;
        return setRun({ phase: "confirm", start });
      }
      await page(start, ac);
    } catch (e) {
      if (abort.current === ac) abort.current = null;
      if (!ac.signal.aborted) {
        setRun({ phase: "idle" });
        setError(code(e));
      }
    }
  };
  const cont = (start: ExportStart) => {
    if (abort.current) return;
    void page(start, (abort.current = new AbortController()));
  };
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setRun({ phase: "idle" });
  };
  useHotkeys({ escape: cancel } satisfies Bindings<typeof EXPORT_KEYS>, overlay === null && (starting || run.phase === "running" || run.phase === "confirm"));

  const progress = run.phase === "running" || run.phase === "done" ? run.progress : null;
  const cont0 = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (run.phase === "confirm") cont0.current?.focus(); // the Download button is disabled now: Enter lands on Continue
  }, [run.phase]);
  return (
    <section className="sblock" aria-labelledby="st-backups">
      <h2 id="st-backups">Backups and export</h2>
      <p>Cloudflare D1 keeps point-in-time restore (Time Travel) for 7 days on Workers Free and 30 days on Workers Paid. The export is a full copy of your links, domains, people and audit log, without secrets or passwords.</p>
      <label className="check">
        <input type="checkbox" checked={analytics} disabled={run.phase !== "idle" && run.phase !== "done"} onChange={(ev) => setAnalytics(ev.target.checked)} />
        Include click analytics (daily totals; can be many rows)
      </label>
      <div className="row-actions save-row">
        <button type="button" className="btn" onClick={() => void begin()} disabled={starting || run.phase === "running" || run.phase === "confirm"}>Download full export</button>
        {(starting || run.phase === "running") && <button type="button" className="btn ghost" onClick={cancel} aria-keyshortcuts="Escape">Cancel<Kbd>Esc</Kbd></button>}
      </div>
      {run.phase === "confirm" && (
        <div className="callout wait gap" role="alert">
          {estimateText(run.start)} Continue?
          <div className="row-actions">
            <button type="button" className="btn" ref={cont0} onClick={() => cont(run.start)}>Continue</button>
            <button type="button" className="btn ghost" onClick={cancel} aria-keyshortcuts="Escape">Cancel<Kbd>Esc</Kbd></button>
          </div>
        </div>
      )}
      <div aria-live="polite">
        {(run.phase === "running" || run.phase === "done") && <p className="muted">{estimateText(run.start)}</p>}
        {progress && (
          <ul className="fails">
            {Object.entries(progress).map(([t, n]) => <li key={t}><span className="mono">{t}</span>: {plural(n, "row")}</li>)}
          </ul>
        )}
        {run.phase === "done" && <p className="muted">Export downloaded.</p>}
      </div>
      {error && <p className="err" role="alert">{settingsError(error)}</p>}
    </section>
  );
}
