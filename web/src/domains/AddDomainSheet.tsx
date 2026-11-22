import { useRef, useState } from "react";
import { api, ApiError, type CfView, type Domain } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { Sheet } from "../shell/Sheet";
import { Seg } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";
import { apexOf, normalizeHost } from "../../../src/host";
import { CfStatus } from "./CfStatus";
import { needsFinish } from "./domainView";
import { cfSettled, useCfPoll } from "./useCfPoll";

type Type = Domain["type"];
type Made = Pick<Domain, "id" | "host"> & { cloudflare?: CfView };

/** Add domain sheet hotkeys and their text on the shortcuts sheet. */
export const ADD_DOMAIN_KEYS = {
  "mod+enter": "Add the domain, in the Add a domain sheet",
  "mod+shift+enter": "Add anyway after the DNS records warning, in the Add a domain sheet",
  f: "Finish connecting the new domain, in the Add a domain sheet",
} as const;
const TYPES: { value: Type; label: string }[] = [
  { value: "main", label: "Main" },
  { value: "shared", label: "Shared" },
  { value: "private", label: "Private" },
];
export const MANUAL_NOTE = "Cloudflare is not connected on this linkwarren, so it cannot attach domains itself. Add this host as a custom domain of the Worker in your Cloudflare dashboard so visits reach it.";
export const outsideNote = (apex: string) =>
  `${apex} isn't in your Cloudflare account, so it connects with one DNS record at its DNS provider. Cloudflare then checks ownership and issues the certificate.`;
const APPROVAL_LINE = "You can create links on it straight away. They start working once the owner approves the domain.";

export function AddDomainSheet() {
  const app = useApp();
  const admin = can(app.me, "domains.manage"); // the type picker, Add anyway and Finish connecting (S8 R8)
  const [host, setHost] = useState("");
  const [type, setType] = useState<Type>("private");
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<string | null>(null); // the host the DNS records warning was shown for
  const [made, setMade] = useState<Made | null>(null);
  const [connected, setConnected] = useState<CfView | null>(null); // the view a Finish connecting answer carried
  const [confirming, setConfirming] = useState(false); // the takeover confirm for Finish connecting
  const busy = useRef(false); // a double Ctrl+Enter sends once

  const initial = made?.cloudflare ?? null;
  // Polls while the view the sheet last got from a call (create, then Finish connecting) is unsettled; newer poll results win.
  const latest = connected ?? initial;
  const poll = useCfPoll(made?.id ?? null, latest !== null && !cfSettled(latest), connected);
  const view = poll.view ?? latest;
  const canFinish = admin && view !== null && needsFinish(view);

  const submit = async (confirmTakeover = false) => {
    if (busy.current || made) return;
    const h = normalizeHost(host.trim()); // display only: the server stays the authority
    if (confirmTakeover && h !== takeover) return; // the warning was for another host
    setHost(h);
    if (!h) return setError("invalid_host");
    busy.current = true;
    setError(null);
    try {
      const body = { host: h, type: admin ? type : "private", ...(confirmTakeover ? { confirmTakeover: true } : {}) };
      const res = await api<Made>("POST", "/api/domains", body);
      setTakeover(null);
      setMade(res); // a no-op once this sheet is dismissed, so a late answer never steers a newer sheet
      const refreshed = await app.reloadDomains().then(() => true, () => false);
      app.announce(refreshed ? `Added ${res.host}` : "Added, but the list could not be refreshed");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      if (code === "dns_record_exists" && admin) setTakeover(h);
      else setError(code); // typed values stay in the form
    } finally {
      busy.current = false;
    }
  };

  /** Same call and takeover flow as Finish connecting in the domain detail. */
  const connect = async (confirmTakeover = false) => {
    if (busy.current || !made) return;
    busy.current = true;
    setError(null);
    try {
      const res = await api<Made>("POST", `/api/domains/${encodeURIComponent(made.id)}/approve`, confirmTakeover ? { confirmTakeover: true } : {});
      setConfirming(false);
      if (res.cloudflare) setConnected(res.cloudflare);
      app.announce("Domain connected");
      await app.reloadDomains().catch(() => undefined);
    } catch (e) {
      setConfirming(false);
      const code = e instanceof ApiError ? e.code : "internal";
      if (code === "dns_record_exists") return setConfirming(true);
      const v = code === "not_verified" && e instanceof ApiError ? (e.data as { cloudflare?: CfView } | undefined)?.cloudflare : undefined;
      if (v) setConnected(v);
      setError(code);
    } finally {
      busy.current = false;
    }
  };

  const finish = () => {
    app.close();
    if (made) navigate(`/domains?sel=${encodeURIComponent(made.id)}`);
  };

  useHotkeys({
    "mod+enter": () => void submit(),
    "mod+shift+enter": (e) => void (takeover && !e.repeat && submit(true)), // a held chord never confirms
    f: () => void (canFinish && connect()),
  } satisfies Bindings<typeof ADD_DOMAIN_KEYS>, !confirming);

  const apex = made ? apexOf(made.host) : "";
  const callout = !view || view.kind === "manual"
    ? <div className="callout wait">{MANUAL_NOTE}</div>
    : view.kind === "outside"
      ? <div className="callout wait">{outsideNote(apex)}</div>
      : <div className="callout ok">{`${apex} is in your Cloudflare account, so linkwarren attaches it directly.${admin ? "" : " The owner attaches it when they approve the domain."}`}</div>;

  return (
    <Sheet label="Add a domain" onClose={app.close}>
      <div className="sh-head">
        <h2>Add a domain</h2>
        <span className="x">
          <kbd>Esc</kbd> {made ? "close" : "cancel"}
        </span>
      </div>
      {made ? (
        <>
          <div className="sh-body">
            <p className="slug">{made.host}</p>
            {callout}
            {view && view.kind !== "manual" && <CfStatus view={view} />}
            {poll.error && <p className="err">{errorText(poll.error)}</p>}
            {error && (
              <p className="err" role="alert">
                {error === "not_verified" ? "Checks have not passed yet" : errorText(error)}
              </p>
            )}
            {!admin && (
              <p className="hint">
                {view?.kind === "outside" ? "You can create links on it straight away. They start working once the record is found and the owner approves the domain." : APPROVAL_LINE}
              </p>
            )}
          </div>
          <div className="sh-foot">
            <span className="left">{!admin ? "Members' domains need the owner's approval" : view && !cfSettled(view) ? "Checks keep running while this is open" : ""}</span>
            {canFinish && (
              <button type="button" className="btn" onClick={() => void connect()} aria-keyshortcuts="F">
                Finish connecting <kbd>F</kbd>
              </button>
            )}
            {/* Keyed: without it React reuses the form's Add domain button here and autoFocus never runs. */}
            <button key="done" type="button" className="btn primary" autoFocus onClick={finish}>
              Done<span className="k2">Enter</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sh-body">
            <div className="f">
              <label htmlFor="ad-d">
                Domain or subdomain <span>for example go.yourbrand.com</span>
              </label>
              <div className={error ? "ctl bad" : "ctl"}>
                <input
                  id="ad-d"
                  autoFocus
                  value={host}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    setHost(e.target.value);
                    setTakeover(null);
                  }}
                  onBlur={() => setHost((v) => normalizeHost(v.trim()))}
                />
              </div>
              {error && (
                <p className="err" role="alert">
                  {errorText(error)}
                </p>
              )}
            </div>
            <div className="f">
              <h3 className="lbl">Type</h3>
              {admin ? <Seg label="Type" options={TYPES} value={type} onChange={setType} /> : <p className="hint">Private</p>}
            </div>
            {takeover && (
              <div className="callout wait" role="alert">
                {`${takeover} already has DNS records in your account. Adding it sends its traffic to linkwarren.`}
              </div>
            )}
            {!admin && <p className="hint">{APPROVAL_LINE}</p>}
          </div>
          <div className="sh-foot">
            <span className="left">Members' domains need the owner's approval</span>
            {takeover && (
              <button type="button" className="btn primary" aria-keyshortcuts="Control+Shift+Enter" onClick={() => void submit(true)}>
                Add anyway<span className="k2">Ctrl Shift Enter</span>
              </button>
            )}
            <button type="button" className={takeover ? "btn" : "btn primary"} aria-keyshortcuts="Control+Enter" onClick={() => void submit()}>
              Add domain<span className="k2">Ctrl Enter</span>
            </button>
          </div>
        </>
      )}
      {confirming && made && (
        <Sheet label="Send traffic to linkwarren" onClose={() => setConfirming(false)}>
          <div className="sh-head">
            <h2>Send traffic to linkwarren</h2>
          </div>
          <div className="sh-body">
            <p>{`Connect and send ${made.host} traffic to linkwarren? It already has DNS records in your Cloudflare account.`}</p>
            <div className="actions">
              {/* Takeover is hard to undo: focus starts on Cancel and key autorepeat never confirms (as in the domain detail). */}
              <button type="button" className="btn primary" onClick={() => void connect(true)} onKeyDown={(e) => e.repeat && e.preventDefault()}>
                Send traffic <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" autoFocus onClick={() => setConfirming(false)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </Sheet>
  );
}
