import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { api, ApiError, type CfView, type Domain } from "../api";
import { MANUAL_NOTE, outsideNote } from "../domains/AddDomainSheet";
import { CfStatus } from "../domains/CfStatus";
import { errorText, plural } from "../copy";
import { downloadCsv } from "../links/bulk";
import { useHotkeys, type Bindings } from "../keys";
import { apexOf, normalizeHost } from "../../../src/host";
import { navigate } from "../router";
import { PermList } from "../settings/CloudflareSection";
import { checkCloudflare, getSettings, logoUrl, patchSettings, sendTestEmail, type CheckResult, type SecretStatus, type SettingsBody } from "../settings/api";
import { settingsError } from "../settings/copy";
import { SecretField } from "../settings/SecretField";
import { addPasskey, passkeysSupported } from "../signin/passkey";
import { useApp } from "../state";
import { chunkImport, errorsCsv, resultsCsv, runImport, type ImportRun } from "./importRun";
import { parseLinksFile, type ImportBody, type LineError } from "./parseLinks";
import { PASSWORDS_UNKNOWN, passwordsUnknown } from "../../../scripts/lib/export";

/** Wizard hotkeys (the navrow shows them; the shell's shortcuts sheet is not on screen here). */
export const WIZARD_KEYS = { "mod+enter": "Continue", "alt+arrowleft": "Back", escape: "Back (or dismiss the record warning)" } as const;
export const RECREATE = "Create each again with its new password: open the New link sheet, release the lock, set the password, then create.";

type StepKey = "name" | "signIn" | "cloudflare" | "mainDomain" | "email";
type SetupStatus = { configured: boolean; steps: Record<StepKey, boolean> };
const STEPS: readonly { key: StepKey | "links"; label: string }[] = [
  { key: "name", label: "Name it" },
  { key: "signIn", label: "Sign-in" },
  { key: "cloudflare", label: "Connect Cloudflare" },
  { key: "mainDomain", label: "Main domain" },
  { key: "email", label: "Email" },
  { key: "links", label: "Bring your links" },
];
const MAX_FILE = 10 * 1024 * 1024;
const MISSING: Record<string, string> = { name: "a name", mainDomain: "a main domain" };
const SHOWN_ROWS = 20;

const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
/** Error text for a step: setup's own answers first, then the Settings list. */
function stepError(e: unknown): string {
  if (e instanceof ApiError && e.code === "incomplete") {
    const missing = (e.data as { missing?: unknown } | undefined)?.missing;
    const names = Array.isArray(missing) ? missing.map((m) => MISSING[String(m)]).filter(Boolean) : [];
    return `Setup cannot finish yet: add ${names.length ? names.join(" and ") : "a name and a main domain"} first.`;
  }
  return settingsError(code(e));
}
const counts = (r: ImportRun["report"]) => `${r.skipped} already there, ${r.conflicts.length} conflicts`;
type Record_ = { type: string; name: string; content: string };
const csvDay = () => new Date().toISOString().slice(0, 10);

/** Line errors and conflicts as plain text rows (server text is never markup). */
function Rows({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="fails">
      {items.slice(0, SHOWN_ROWS).map((t, i) => <li key={i}>{t}</li>)}
      {items.length > SHOWN_ROWS && <li>and {items.length - SHOWN_ROWS} more</li>}
    </ul>
  );
}

/** First-run setup (R10). Every save goes through the owner-only Settings APIs; only Finish marks the instance as set up. */
export function SetupWizard() {
  const app = useApp();
  const [settings, setSettings] = useState<SettingsBody | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  const [name, setName] = useState("");
  const [passkey, setPasskey] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checking = useRef(false);
  const tokenGen = useRef(0); // bumped by every token save: a check started before it is ignored
  const [tokenSaves, setTokenSaves] = useState(0);
  const [host, setHost] = useState("");
  const [takeover, setTakeover] = useState<{ host: string; records: Record_[] } | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  // M7: a new main domain Cloudflare cannot attach directly (outside the account, or no Cloudflare): its next step stays on screen.
  const [dns, setDns] = useState<{ host: string; view: CfView } | null>(null);
  const [mail, setMail] = useState<{ text: string; error: boolean } | null>(null);
  const [fileErrors, setFileErrors] = useState<LineError[]>([]);
  const [chunks, setChunks] = useState<ImportBody[] | null>(null);
  const [preview, setPreview] = useState<ImportRun | null>(null);
  const [result, setResult] = useState<ImportRun | null>(null);
  // N2: no link in the file says whether it had a password; a real run waits for the owner's confirmation.
  const [pwUnknown, setPwUnknown] = useState(false);
  const [noPw, setNoPw] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [part, setPart] = useState<string | null>(null);
  const fileGen = useRef(0); // only the newest chosen file may show its preview
  const errorEl = useRef<HTMLParagraphElement>(null);
  const takeoverEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoadError(null);
    Promise.all([getSettings(ac.signal), api<SetupStatus>("GET", "/api/setup", undefined, ac.signal)]).then(
      ([s, st]) => {
        setSettings(s);
        setStatus(st);
        setName(s.name ?? "");
        // Answers are saved as they go: pick up at the first step not done yet.
        const at = STEPS.findIndex((x) => x.key === "links" || !st.steps[x.key]);
        setStep(at);
      },
      (e) => !ac.signal.aborted && setLoadError(code(e)),
    );
    return () => ac.abort();
  }, [loadTry]);

  const mains = app.domains.filter((d) => d.type === "main" && d.status === "active");
  const chosen = choice ?? (mains.some((d) => d.id === settings?.mainDomainId) ? settings!.mainDomainId : mains[0]?.id ?? null);
  const mainHost = app.domains.find((d) => d.id === settings?.mainDomainId)?.host ?? "";
  const cfSet = settings !== null && settings.secrets.cf !== "missing";

  const go = (i: number) => {
    setError(null);
    setStep(i);
  };
  const done = (key: StepKey) => setStatus((st) => st && { ...st, steps: { ...st.steps, [key]: true } });
  const onSecrets = (s: SecretStatus) => setSettings((cur) => cur && { ...cur, secrets: s });

  /** One write at a time: a second Ctrl+Enter or click while saving does nothing. */
  const run = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(stepError(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const runCheck = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setCheckError(null);
    const g = tokenGen.current;
    try {
      const r = await checkCloudflare();
      if (g === tokenGen.current) setCheck(r);
    } catch (e) {
      if (g === tokenGen.current) setCheckError(settingsError(code(e)));
    } finally {
      checking.current = false;
    }
    // A token saved while this check ran: its result was dropped, so check the new one.
    if (g !== tokenGen.current) setTokenSaves((n) => n + 1);
  }, []);
  // A token that is set (by any source) is checked when the step opens, and again after every token save.
  useEffect(() => {
    if (step === 2 && cfSet && check === null) void runCheck();
  }, [step, cfSet, check, runCheck, tokenSaves]);

  const created = useRef<{ id: string; host: string; view: CfView } | null>(null);
  /** Shows the DNS next step of the domain this wizard created, once; true when it did. */
  const showCreated = (id: string) => {
    const c = created.current;
    if (!c || c.id !== id) return false;
    created.current = null;
    setDns({ host: c.host, view: c.view });
    return true;
  };
  const addMain = (confirm: boolean) =>
    run(async () => {
      const h = normalizeHost(host.trim()); // display only: the server stays the authority
      setHost(h);
      if (!h) throw new ApiError(400, "invalid_host");
      let d: Domain & { cloudflare?: CfView };
      try {
        d = await api<Domain>("POST", "/api/domains", { host: h, type: "main", ...(confirm ? { confirmTakeover: true } : {}) });
      } catch (e) {
        if (code(e) !== "dns_record_exists") throw e;
        // Named, with what is there today; only the explicit button confirms (never Ctrl+Enter).
        const recs = (e as ApiError).data as { records?: unknown } | undefined;
        setTakeover({ host: h, records: Array.isArray(recs?.records) ? (recs.records as Record_[]) : [] });
        return;
      }
      setTakeover(null);
      // Kept until shown: if the save below fails, the retry (the existing-main branch) still shows this DNS next step.
      created.current = d.cloudflare && d.cloudflare.kind !== "account" ? { id: d.id, host: d.host, view: d.cloudflare } : null;
      // Reload before saving: if the save fails, the new domain is in the choice list for the next try.
      await app.reloadDomains().catch(() => undefined);
      const s = await patchSettings({ mainDomainId: d.id });
      setSettings(s);
      done("mainDomain");
      if (showCreated(d.id)) return;
      go(4);
    });

  const finish = () =>
    run(async () => {
      try {
        await api("POST", "/api/setup/complete", {});
      } catch (e) {
        if (code(e) !== "already_configured") throw e; // set up elsewhere meanwhile: the shell is the right place now
      }
      await app.reloadInstance();
      navigate("/links", { replace: true });
    });

  const next = () => {
    if (!settings) return;
    if (step === 0) {
      const v = name.trim();
      if (!v) return setError(settingsError("bad_name"));
      return void run(async () => {
        setSettings(await patchSettings({ name: v }));
        done("name");
        go(1);
      });
    }
    if (step === 3) {
      if (dns) {
        setDns(null);
        return go(4);
      }
      if (!mains.length && app.loadError) return setError(app.loadError);
      if (!mains.length) return void addMain(false);
      return void run(async () => {
        if (chosen !== settings.mainDomainId) setSettings(await patchSettings({ mainDomainId: chosen }));
        done("mainDomain");
        if (chosen && showCreated(chosen)) return;
        go(4);
      });
    }
    if (step === 5) return void finish();
    go(step + 1);
  };
  const back = () => step > 0 && !working.current && go(step - 1);
  useHotkeys({
    "mod+enter": (e) => !e.repeat && next(), // a held key must not walk through the steps
    "alt+arrowleft": back,
    escape: () => (takeover ? setTakeover(null) : back()),
  } satisfies Bindings<typeof WIZARD_KEYS>, settings !== null);

  // Each step opens on its first field (or its first control, else Continue).
  useEffect(() => {
    if (!settings) return;
    const root = body.current;
    const el = root?.querySelector<HTMLElement>("input:not([disabled]), select, textarea") ?? root?.querySelector<HTMLElement>("button:not([disabled])") ?? primary.current;
    el?.focus();
  }, [step, settings, mains.length]);
  // An error or a record warning takes focus, so a keyboard user hears it and goes on from there (the field may be disabled while saving).
  useEffect(() => void (error && errorEl.current?.focus()), [error]);
  useEffect(() => void (takeover && takeoverEl.current?.focus()), [takeover]);

  const onPart = (verb: string) => (i: number, n: number) => setPart(`${verb} part ${i} of ${n}`);
  // The chosen file and the main domain its chunks were built for: a later main domain change rebuilds them (links with no
  // host go to the main domain, so stale chunks would import to the old one).
  const source = useRef<{ name: string; text: string; host: string } | null>(null);
  const reset = () => {
    setFileErrors([]);
    setChunks(null);
    setPreview(null);
    setResult(null);
    setPwUnknown(false);
    setNoPw(false);
  };
  const prepare = async (g: number, name: string, text: string) => {
    source.current = { name, text, host: mainHost };
    const p = parseLinksFile(name, text, mainHost);
    if (!p.body || p.errors.length) return setFileErrors(p.errors);
    if (!p.body.mainHost) return setFileErrors([{ line: 0, reason: "Pick a main domain first (Main domain step)" }]);
    let c: ImportBody[];
    try {
      c = chunkImport(p.body);
    } catch (err) {
      return setFileErrors([{ line: 0, reason: (err as Error).message }]);
    }
    setChunks(c);
    setPwUnknown(passwordsUnknown(p.body));
    const r = await runImport(c, true, { onPart: (i, n) => g === fileGen.current && onPart("Checking")(i, n) });
    if (g !== fileGen.current) return;
    setPart(null);
    setPreview(r);
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const g = ++fileGen.current;
    const f = e.target.files?.[0];
    e.target.value = ""; // choosing the same file again fires change again
    reset();
    source.current = null;
    if (!f) return;
    setFileName(f.name);
    // Checked here for a quick answer; the server checks every request again.
    if (f.size > MAX_FILE) return setFileErrors([{ line: 0, reason: "The file is larger than 10 MB" }]);
    const text = await f.text();
    if (g !== fileGen.current) return;
    await prepare(g, f.name, text);
  };
  useEffect(() => {
    const src = source.current;
    if (!src || src.host === mainHost) return;
    const g = ++fileGen.current;
    reset();
    void prepare(g, src.name, src.text);
  }, [mainHost]);
  /** Import, or Retry from the part that failed (the server skips what an earlier try already wrote). */
  const doImport = (dry: boolean, from?: ImportRun) =>
    chunks &&
    run(async () => {
      const r = await runImport(!dry && pwUnknown ? chunks.map((x) => ({ ...x, confirmNoPasswords: true })) : chunks, dry, { onPart: onPart(dry ? "Checking" : "Importing"), ...(from ? { from: from.failedAt!, report: from.report } : {}) });
      setPart(null);
      if (dry) return setPreview(r);
      setResult(r);
      app.bumpLinks();
      void app.reloadDomains().catch(() => undefined);
    });

  if (loadError)
    return (
      <div className="gate" role="alert">
        <img src="/linkwarren-mark.svg" alt="" />
        <p>{settingsError(loadError)}</p>
        <button type="button" className="btn" onClick={() => setLoadTry((n) => n + 1)}>Retry</button>
      </div>
    );
  if (!settings || !status) return null;

  const app_ = settings.authMode === "app";
  let title = STEPS[step]!.label;
  let lead: ReactNode;
  let content: ReactNode = null;
  let skip: string | null = null;
  if (step === 0) {
    lead = "The name shows in the dashboard, the browser tab and the emails linkwarren sends.";
    content = (
      <div className="field stack">
        <label htmlFor="wiz-name">Name</label>
        <input id="wiz-name" className="input sans" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} disabled={busy} />
      </div>
    );
  } else if (step === 1) {
    lead = app_ ? "You signed in with an email link. People you invite sign in the same way." : "Sign-in is handled in front of this dashboard. People you invite sign in the same way.";
    if (app_)
      content = (
        <>
          <p className="muted">{passkeysSupported() ? "A passkey signs you in with this device, without waiting for an email." : "This browser cannot use passkeys. You can add one later from another device."}</p>
          <div className="row-actions">
            <button type="button" className="btn" disabled={busy || !passkeysSupported()} onClick={() => void run(async () => {
              await addPasskey();
              setPasskey("Passkey added.");
            })}>Add a passkey</button>
            {passkey && <span className="muted" role="status">{passkey}</span>}
          </div>
        </>
      );
  } else if (step === 2) {
    lead = "linkwarren runs in your own Cloudflare account. Give it an API token so it can attach your domains and issue certificates.";
    skip = "Skip for now";
    content = (
      <>
        <SecretField name="cf" status={settings.secrets.cf} pasteAvailable={settings.secrets.pasteAvailable} onSaved={(s) => {
          onSecrets(s);
          tokenGen.current++;
          setTokenSaves((n) => n + 1);
          setCheck(null);
          setCheckError(null);
        }} />
        <p className="muted hint">CF_ACCOUNT_ID and CF_WORKER_NAME are set in the Worker config.</p>
        {cfSet && (
          <>
            <h3>What the token can do</h3>
            {check && <PermList check={check} />}
            {checkError && <p className="err" role="alert">{checkError}</p>}
            <div className="row-actions gap-top">
              <button type="button" className="btn" onClick={() => void runCheck()}>Check again</button>
            </div>
          </>
        )}
      </>
    );
  } else if (step === 3) {
    lead = "Short links live on the main domain unless you pick another one. You can add more domains later.";
    content = dns ? (
      <>
        <p className="slug">{dns.host}</p>
        <div className="callout wait" role="status">{dns.view.kind === "manual" ? MANUAL_NOTE : outsideNote(apexOf(dns.host))}</div>
        {dns.view.kind !== "manual" && <CfStatus view={dns.view} />}
        <p className="muted">Links on it start working once this is done. Continue when you are ready; the domain stays in Domains.</p>
      </>
    ) : !mains.length && app.loadError ? (
      <p className="muted">The domain list did not load. Retry above before adding a main domain, so an existing one is not added twice.</p>
    ) : mains.length ? (
      <fieldset className="choices">
        <legend className="muted">Pick the main domain</legend>
        {mains.map((d) => (
          <label className="check" key={d.id}>
            <input type="radio" name="wiz-main" checked={chosen === d.id} onChange={() => setChoice(d.id)} disabled={busy} />
            <span className="mono">{d.host}</span>
          </label>
        ))}
      </fieldset>
    ) : (
      <>
        <div className="field stack">
          <label htmlFor="wiz-host">Domain</label>
          <input id="wiz-host" className="input" value={host} placeholder="go.example.com" autoComplete="off" spellCheck={false} inputMode="url" onChange={(e) => {
            setHost(e.target.value);
            setTakeover(null);
          }} disabled={busy} />
        </div>
        {takeover && takeover.host === normalizeHost(host.trim()) && (
          <div className="callout wait" role="alert" tabIndex={-1} ref={takeoverEl}>
            <p>
              {`${takeover.host} already has DNS records in your Cloudflare account`}
              {takeover.records.length ? `: ${takeover.records.map((r) => `${r.type} ${r.name} ${r.content}`).join(", ")}` : ""}
              {". Replacing sends its traffic to linkwarren, and whatever it serves today stops. Esc keeps it, then pick another name."}
            </p>
            <div className="row-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void addMain(true)}>{`Replace the record for ${takeover.host} and continue`}</button>
            </div>
          </div>
        )}
      </>
    );
  } else if (step === 4) {
    lead = "linkwarren sends sign-in links and invites through Resend.";
    skip = "Skip for now";
    content = (
      <>
        <div className="sfield">
          <div><b>Sender</b><small>Set by the EMAIL_FROM variable</small></div>
          <span className="mono">{settings.emailFrom ?? "Not set"}</span>
        </div>
        <SecretField name="resend" status={settings.secrets.resend} pasteAvailable={settings.secrets.pasteAvailable} onSaved={onSecrets}
          hint="Your sign-in email uses the key that works today; a pasted key replaces it." />
        <div className="row-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
            setMail(null);
            try {
              await sendTestEmail();
              setMail({ text: `Sent a test email to ${app.me.email}.`, error: false });
            } catch (e) {
              setMail({ text: settingsError(code(e)), error: true });
            }
          })}>Send test email</button>
        </div>
        {mail && <p className={mail.error ? "err" : "muted"} role={mail.error ? "alert" : "status"}>{mail.text}</p>}
      </>
    );
  } else {
    title = "Bring your links";
    lead = "Import short links from a CSV file or the legacy JSON export (see docs/import-legacy.md). Existing slugs are never overwritten. Links the export marks protected (they had a password) come in locked, never live.";
    skip = result ? null : "Skip";
    const r = result ?? preview;
    const rows = r ? r.report.conflicts.length + r.report.protected.length + r.report.ignored.length : 0;
    content = (
      <>
        <div className="field stack">
          <label htmlFor="wiz-file">Links file</label>
          <input id="wiz-file" type="file" accept=".csv,.json" onChange={(e) => void onFile(e)} disabled={busy} />
          {fileName && <small className="muted">{`Chosen: ${fileName}`}</small>}
          <small className="muted">CSV columns: slug, destination (or url), and optional host, enabled, start_date and end_date (YYYY-MM-DD HH:MM:SS, UTC). A CSV cannot mark password links: leave them out or set enabled to false. Up to 10 MB.</small>
        </div>
        {fileErrors.length > 0 && (
          <div role="alert">
            <p className="err">{`This file cannot be imported (${plural(fileErrors.length, "problem")}). Fix it and choose it again.`}</p>
            <Rows items={fileErrors.map((e) => (e.line ? `Line ${e.line}: ${e.reason}` : e.reason))} />
            {fileErrors.length > 1 && (
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => downloadCsv(errorsCsv(fileErrors), `linkwarren-import-errors-${csvDay()}.csv`)}>Download errors</button>
              </div>
            )}
          </div>
        )}
        <div aria-live="polite">
          {part && <p className="muted">{part}</p>}
          {preview && !result && preview.failedAt === null && (
            <>
              <p>{`${preview.report.created} to import, ${counts(preview.report)}, new domains: ${preview.report.domainsCreated.join(", ") || "none"}`}</p>
              {pwUnknown && (
                <div className="callout wait">
                  <p>{PASSWORDS_UNKNOWN}</p>
                  <label className="check">
                    <input type="checkbox" checked={noPw} onChange={(e) => setNoPw(e.target.checked)} disabled={busy} />
                    <span>No link in this file had a password</span>
                  </label>
                </div>
              )}
              {preview.report.protected.length > 0 && (
                <p>{`${plural(preview.report.protected.length, "password link")} ${preview.report.protected.length === 1 ? "comes" : "come"} in locked, never live. You set their new passwords after the import.`}</p>
              )}
            </>
          )}
          {result && result.failedAt === null && <p>{`Imported ${result.report.created}, ${counts(result.report)}.`}</p>}
          {r && r.failedAt !== null && (
            <p className="err" role="alert">
              {`Stopped at part ${r.failedAt + 1} of ${chunks?.length ?? 1}: ${settingsError(r.error ?? "internal")}`}
              {result && r.failedAt > 0 ? ` The parts before it are imported (${r.report.created} links).` : ""}
              {" Retry continues from that part; nothing is imported twice."}
            </p>
          )}
          {r && <Rows items={r.report.conflicts.map((c) => `${c.host}/${c.slug}: ${c.reason}`)} />}
          {result && result.report.protected.length > 0 && (
            <>
              <h3>{`${plural(result.report.protected.length, "password link")} imported locked`}</h3>
              <p>{RECREATE}</p>
              <Rows items={result.report.protected.map((x) => `${x.host}/${x.slug}`)} />
            </>
          )}
        </div>
        <div className="row-actions">
          {preview && preview.failedAt === null && !result && <button type="button" className="btn" disabled={busy || (pwUnknown && !noPw)} onClick={() => void doImport(false)}>Import</button>}
          {r && r.failedAt !== null && <button type="button" className="btn" disabled={busy} onClick={() => void doImport(!result, r)}>Retry</button>}
          {rows > 0 && <button type="button" className="btn" onClick={() => downloadCsv(resultsCsv(r!.report), `linkwarren-import-results-${csvDay()}.csv`)}>Download results</button>}
        </div>
      </>
    );
  }

  const last = step === STEPS.length - 1;
  return (
    <div className="setup">
      <aside className="steps" aria-label="Setup steps">
        <div className="brand"><img src={logoUrl(app.instance?.logoVersion ?? null)} alt="" /><span>{settings.name || "linkwarren"}</span></div>
        <ol>
          {STEPS.map((s, i) => {
            const isDone = i !== step && s.key !== "links" && status.steps[s.key];
            return (
              <li key={s.key} className={i === step ? "now" : isDone ? "done" : "todo"} aria-current={i === step ? "step" : undefined}>
                <span className="n" aria-hidden="true">{isDone ? "✓" : i + 1}</span>
                <div><b>{s.label}</b>{s.key === "name" && settings.name && <small>{settings.name}</small>}</div>
              </li>
            );
          })}
        </ol>
        <p>Everything here can be changed later in Settings. Your answers are saved as you go.</p>
      </aside>
      <main className="wiz">
        {app.signedOut && (
          <div className="banner" role="alert">
            {errorText("network")}
            <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
          </div>
        )}
        {app.loadError && (
          <div className="banner" role="alert">
            Could not load the dashboard data. {app.loadError}
            <button type="button" className="btn" onClick={app.retryLoad}>Retry</button>
          </div>
        )}
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        <div ref={body}>{content}</div>
        {error && <p className="err" role="alert" tabIndex={-1} ref={errorEl}>{error}</p>}
        <div className="navrow">
          <span className="left"><kbd>Ctrl</kbd> <kbd>Enter</kbd> continue, <kbd>Alt</kbd> <kbd>←</kbd> or <kbd>Esc</kbd> back</span>
          {step > 0 && <button type="button" className="btn" onClick={back} disabled={busy} aria-keyshortcuts="Alt+ArrowLeft">Back</button>}
          {skip && <button type="button" className="btn ghost" onClick={() => (last ? void finish() : go(step + 1))} disabled={busy}>{skip}</button>}
          <button ref={primary} type="button" className="btn primary" onClick={next} disabled={busy} aria-keyshortcuts="Control+Enter">
            {last ? "Finish" : "Continue"}<span className="k">Ctrl Enter</span>
          </button>
        </div>
      </main>
    </div>
  );
}
