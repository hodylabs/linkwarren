import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { plural } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Kbd, Switch } from "../shell/ui";
import { useApp } from "../state";
import { checkCloudflare, getCloudflare, PERMISSIONS, resyncBatch, setControls, setupOutside, type CheckResult, type CloudflareSettings } from "./api";
import { settingsError } from "./copy";

/** Settings hotkeys and their text on the shortcuts sheet. */
export const SETTINGS_KEYS = {
  c: "Check the Cloudflare token",
  escape: "Stop resyncing domains",
} as const;

const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const SSL_MISSING =
  "The token can't add outside domains yet. That's fine if every domain you'll use is in this Cloudflare account. To let people add their own domains with a CNAME, edit the token to include SSL and Certificates, then check again.";

type Resync = { running: boolean; checked: number; failed: { host: string; error: string }[]; resume: string | undefined; stopped: string | null; done: boolean };
const IDLE: Resync = { running: false, checked: 0, failed: [], resume: undefined, stopped: null, done: false };

export function CloudflareSection() {
  const { overlay } = useApp();
  const [s, setS] = useState<CloudflareSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ text: string; error: boolean } | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const setupBusy = useRef(false); // a double click sends one setup
  const [resync, setResync] = useState<Resync>(IDLE);
  const busy = useRef(false); // one check at a time: a double C sends once
  const abort = useRef<AbortController | null>(null);

  const load = useCallback((signal?: AbortSignal) => getCloudflare(signal).then(setS), []);
  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal).catch((e) => !isAbort(e) && setLoadError(code(e)));
    return () => {
      ac.abort();
      abort.current?.abort(); // leaving the screen cancels a running resync
    };
  }, [load]);

  const runCheck = async () => {
    if (busy.current || !s?.configured) return;
    busy.current = true;
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await checkCloudflare());
    } catch (e) {
      setCheckError(code(e));
    } finally {
      busy.current = false;
      setChecking(false);
    }
  };

  const toggle = async (on: boolean) => {
    if (!s) return;
    setControlsError(null);
    setS({ ...s, controlsEnabled: on });
    try {
      await setControls(on);
    } catch (e) {
      setS((cur) => cur && { ...cur, controlsEnabled: !on });
      setControlsError(code(e));
    }
  };

  const runSetup = async () => {
    if (setupBusy.current) return;
    setupBusy.current = true;
    setSettingUp(true);
    setSetup(null);
    try {
      const r = await setupOutside();
      setSetup({ text: r.fallbackOrigin === "active" ? "Outside domains are ready." : "Set up. Cloudflare is still activating the fallback origin, check again in a minute.", error: false });
      await load().catch(() => undefined);
    } catch (e) {
      setSetup({ text: settingsError(code(e)), error: true });
    } finally {
      setupBusy.current = false;
      setSettingUp(false);
    }
  };

  /** Loops batches until `next` is null. Stops (Retry) when the cursor does not move or one domain is unreachable twice in a row. */
  const runResync = async () => {
    if (abort.current) return;
    const ac = (abort.current = new AbortController());
    let after = resync.resume;
    let { checked } = resync;
    let failed = resync.failed;
    let pending: string | null = null; // the host whose retry decides whether Cloudflare is really unreachable
    const view = (p: Partial<Resync>) => setResync({ running: true, checked, failed, resume: after, stopped: null, done: false, ...p });
    view({});
    try {
      for (;;) {
        const r = await resyncBatch(after, ac.signal);
        const now = new Set(r.failed.map((f) => f.host)); // one row per host, the latest error
        failed = [...failed.filter((f) => f.host !== pending && !now.has(f.host)), ...r.failed];
        checked += r.ok;
        const unreachable = r.failed.find((f) => f.error === "cloudflare_unreachable");
        if (r.next === null) return view({ running: false, done: true });
        if (r.next === after) return view({ running: false, stopped: "stalled" });
        if (unreachable && unreachable.host === pending) return view({ running: false, resume: r.next, stopped: "stalled" });
        pending = unreachable?.host ?? null;
        after = r.next;
        view({});
      }
    } catch (e) {
      if (ac.signal.aborted) return view({ running: false, resume: after });
      view({ running: false, stopped: code(e) });
    } finally {
      abort.current = null;
    }
  };

  useHotkeys(
    {
      c: () => void runCheck(),
      escape: () => abort.current?.abort(),
    } satisfies Bindings<typeof SETTINGS_KEYS>,
    overlay === null && (resync.running || !!s?.configured),
  );

  if (loadError) return <p className="err" role="alert">{settingsError(loadError)}</p>;
  if (!s) return <p className="muted" role="status">Loading</p>;
  if (!s.configured)
    return (
      <section className="sblock" aria-label="Cloudflare">
        <h2>Cloudflare</h2>
        <div className="callout wait">Cloudflare is not connected. Set the CF_API_TOKEN secret and the Cloudflare variables, then reload. See the deploy guide.</div>
      </section>
    );

  const okLabels = check?.permissions.filter((p) => p.state === "ok").map((p) => PERMISSIONS.find((q) => q.key === p.key)?.label).filter(Boolean);
  const n = s.attachedCount;
  const shown = resync.checked + resync.failed.length > 0 || resync.done;
  return (
    <section className="sblock" aria-label="Cloudflare">
      <h2>Cloudflare</h2>
      <div className="callout ok">
        Connected to the account <b>{s.accountName ?? "your Cloudflare account"}</b>. {plural(n, "domain")} in this account {n === 1 ? "is" : "are"} attached directly; outside domains use a CNAME through Cloudflare for SaaS
        {s.hostnames ? ` (${s.hostnames.used} of ${s.hostnames.limit} free hostnames used)` : ""}.
      </div>
      <div className="sfield">
        <div>
          <b>API token</b>
          <small>Stored as a Worker secret, never shown again</small>
        </div>
        <div className="row-actions">
          <span className="muted">{okLabels?.length ? okLabels.join(", ") : "Not checked yet"}</span>
          <button type="button" className="btn" onClick={() => void runCheck()} disabled={checking} aria-keyshortcuts="C">
            Check token<Kbd>C</Kbd>
          </button>
        </div>
      </div>
      {checkError && <p className="err" role="alert">{settingsError(checkError)}</p>}
      {check && (
        <div aria-live="polite">
          {check.token === "invalid" ? (
            <div className="callout wait">Cloudflare does not accept this token. Create a new one and set it as the CF_API_TOKEN secret.</div>
          ) : (
            <>
              <ul className="perms" aria-label="Token permissions">
                {PERMISSIONS.map((p) => {
                  const st = check.permissions.find((q) => q.key === p.key)?.state ?? "unknown";
                  return (
                    <li className="perm" key={p.key}>
                      <span className={st === "ok" ? "pk ok" : st === "missing" ? "pk miss" : "pk"} aria-hidden="true">{st === "ok" ? "✓" : st === "missing" ? "!" : "?"}</span>
                      <div>
                        <span className="mono">{p.label}</span>
                        <small>{st === "ok" ? "OK" : st === "missing" ? "Missing" : "Checked on first use"}. {p.why}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {check.permissions.find((q) => q.key === "ssl_edit")?.state === "missing" && <div className="callout wait gap">{SSL_MISSING}</div>}
            </>
          )}
        </div>
      )}
      <div className="toggle sfield">
        <div>
          <b>Cloudflare controls in domain settings</b>
          <small>Security level and rate limits for domains in this account</small>
        </div>
        <Switch checked={s.controlsEnabled} onChange={(v) => void toggle(v)} label="Cloudflare controls in domain settings" />
      </div>
      {controlsError && <p className="err" role="alert">{settingsError(controlsError)}</p>}
      {s.fallbackOrigin !== "active" && (
        <div className="sfield">
          <div>
            <b>Outside domains</b>
            <small>Creates the CNAME target and the fallback origin in Cloudflare for SaaS</small>
          </div>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => void runSetup()} disabled={settingUp}>Set up outside domains</button>
          </div>
        </div>
      )}
      {setup && <p className={setup.error ? "err" : "muted"} role={setup.error ? "alert" : "status"}>{setup.text}</p>}
      <div className="sfield">
        <div>
          <b>Resync domains</b>
          <small>Repairs the Cloudflare pieces of attached domains, a few at a time</small>
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => void runResync()} disabled={resync.running}>
            {resync.stopped ? "Retry" : "Resync domains"}
          </button>
          {resync.running && <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>Stop<Kbd>Esc</Kbd></button>}
        </div>
      </div>
      <div aria-live="polite">
        {shown && (
          <p className="muted">
            {resync.running ? `Checked ${resync.checked + resync.failed.length} so far` : resync.done ? `Checked ${resync.checked + resync.failed.length}. ${resync.failed.length ? `${plural(resync.failed.length, "domain")} could not be repaired.` : "All repaired."}` : `Stopped after ${resync.checked + resync.failed.length}.`}
          </p>
        )}
        {resync.stopped && <p className="err" role="alert">{settingsError(resync.stopped)}</p>}
        {resync.failed.length > 0 && (
          <ul className="fails">
            {resync.failed.map((f) => (
              <li key={f.host}><span className="mono">{f.host}</span>: {settingsError(f.error)}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
