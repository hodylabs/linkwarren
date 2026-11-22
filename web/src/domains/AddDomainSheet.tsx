import { useRef, useState } from "react";
import { api, ApiError, type CfView, type Domain } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { Sheet } from "../shell/Sheet";
import { Seg } from "../shell/ui";
import { useApp } from "../state";
import { apexOf, normalizeHost } from "../../../src/host";
import { CfStatus } from "./CfStatus";
import { cfSettled, useCfPoll } from "./useCfPoll";

type Type = Domain["type"];
type Made = Pick<Domain, "id" | "host"> & { cloudflare?: CfView };

/** Add domain sheet hotkeys and their text on the shortcuts sheet. */
export const ADD_DOMAIN_KEYS = {
  "mod+enter": "Add the domain, in the Add a domain sheet",
  "mod+shift+enter": "Add anyway after the DNS records warning, in the Add a domain sheet (owner)",
} as const;
const TYPES: { value: Type; label: string }[] = [
  { value: "main", label: "Main" },
  { value: "shared", label: "Shared" },
  { value: "private", label: "Private" },
];
const MANUAL_NOTE = "linkwarren does not connect domains to Cloudflare yet. Add this host as a custom domain of the Worker in your Cloudflare dashboard so visits reach it.";
const APPROVAL_LINE = "You can create links on it straight away. They start working once the owner approves the domain.";

export function AddDomainSheet() {
  const app = useApp();
  const isOwner = app.me.role === "owner";
  const [host, setHost] = useState("");
  const [type, setType] = useState<Type>("private");
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<string | null>(null); // the host the DNS records warning was shown for
  const [made, setMade] = useState<Made | null>(null);
  const busy = useRef(false); // a double Ctrl+Enter sends once

  const initial = made?.cloudflare ?? null;
  const poll = useCfPoll(made?.id ?? null, initial !== null && !cfSettled(initial));
  const view = poll.view ?? initial;

  const submit = async (confirmTakeover = false) => {
    if (busy.current || made) return;
    const h = normalizeHost(host.trim()); // display only: the server stays the authority
    if (confirmTakeover && h !== takeover) return; // the warning was for another host
    setHost(h);
    if (!h) return setError("invalid_host");
    busy.current = true;
    setError(null);
    try {
      const body = { host: h, type: isOwner ? type : "private", ...(confirmTakeover ? { confirmTakeover: true } : {}) };
      const res = await api<Made>("POST", "/api/domains", body);
      setTakeover(null);
      setMade(res); // a no-op once this sheet is dismissed, so a late answer never steers a newer sheet
      const refreshed = await app.reloadDomains().then(() => true, () => false);
      app.announce(refreshed ? `Added ${res.host}` : "Added, but the list could not be refreshed");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      if (code === "dns_record_exists" && isOwner) setTakeover(h);
      else setError(code); // typed values stay in the form
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
  } satisfies Bindings<typeof ADD_DOMAIN_KEYS>);

  const apex = made ? apexOf(made.host) : "";
  const callout = !view || view.kind === "manual"
    ? <div className="callout wait">{MANUAL_NOTE}</div>
    : view.kind === "outside"
      ? <div className="callout wait">{`${apex} isn't in your Cloudflare account, so it connects with one DNS record at its DNS provider. Cloudflare then checks ownership and issues the certificate.`}</div>
      : <div className="callout ok">{`${apex} is in your Cloudflare account, so linkwarren attaches it directly.${isOwner ? "" : " The owner attaches it when they approve the domain."}`}</div>;

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
            {!isOwner && (
              <p className="hint">
                {view?.kind === "outside" ? "You can create links on it straight away. They start working once the record is found and the owner approves the domain." : APPROVAL_LINE}
              </p>
            )}
          </div>
          <div className="sh-foot">
            <span className="left">{isOwner ? "Checks keep running while this is open" : "Members' domains need the owner's approval"}</span>
            <button type="button" className="btn primary" autoFocus onClick={finish}>
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
              {isOwner ? <Seg label="Type" options={TYPES} value={type} onChange={setType} /> : <p className="hint">Private</p>}
            </div>
            {takeover && (
              <div className="callout wait" role="alert">
                {`${takeover} already has DNS records in your account. Adding it sends its traffic to linkwarren.`}
              </div>
            )}
            {!isOwner && <p className="hint">{APPROVAL_LINE}</p>}
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
    </Sheet>
  );
}
