import { useRef, useState } from "react";
import { api, ApiError, type Domain } from "../api";
import { errorText } from "../copy";
import { useHotkeys } from "../keys";
import { navigate } from "../router";
import { Sheet } from "../shell/Sheet";
import { Seg } from "../shell/ui";
import { useApp } from "../state";
import { normalizeHost } from "../../../src/host";

type Type = Domain["type"];
const TYPES: { value: Type; label: string }[] = [
  { value: "main", label: "Main" },
  { value: "shared", label: "Shared" },
  { value: "private", label: "Private" },
];

export function AddDomainSheet() {
  const app = useApp();
  const isOwner = app.me.role === "owner";
  const [host, setHost] = useState("");
  const [type, setType] = useState<Type>("private");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false); // a double Ctrl+Enter sends once

  const submit = async () => {
    if (busy.current) return;
    const h = normalizeHost(host.trim()); // display only: the server stays the authority
    setHost(h);
    if (!h) return setError("invalid_host");
    busy.current = true;
    setError(null);
    try {
      const made = await api<Domain>("POST", "/api/domains", { host: h, type: isOwner ? type : "private" });
      // Reload first so the selection in the URL exists when the screen reads it.
      const refreshed = await app.reloadDomains().then(() => true, () => false);
      app.close();
      navigate(`/domains?sel=${encodeURIComponent(made.id)}`);
      app.announce(refreshed ? `Added ${made.host}` : "Added, but the list could not be refreshed");
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal"); // typed values stay in the form
    } finally {
      busy.current = false;
    }
  };

  useHotkeys({ "mod+enter": () => void submit() });

  return (
    <Sheet label="Add a domain" onClose={app.close}>
      <div className="sh-head">
        <h2>Add a domain</h2>
        <span className="x">
          <kbd>Esc</kbd> cancel
        </span>
      </div>
      <div className="sh-body">
        <div className="f">
          <label htmlFor="ad-d">
            Domain or subdomain <span>for example go.yourbrand.com</span>
          </label>
          <div className={error ? "ctl bad" : "ctl"}>
            <input id="ad-d" autoFocus value={host} spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} onChange={(e) => setHost(e.target.value)} onBlur={() => setHost((v) => normalizeHost(v.trim()))} />
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
        <div className="callout wait">linkwarren does not connect domains to Cloudflare yet. Add this host as a custom domain of the Worker in your Cloudflare dashboard so visits reach it.</div>
        {!isOwner && <p className="hint">You can create links on it straight away. They start working once the owner approves the domain.</p>}
      </div>
      <div className="sh-foot">
        <span className="left">Members' domains need the owner's approval</span>
        <button type="button" className="btn primary" aria-keyshortcuts="Control+Enter" onClick={() => void submit()}>
          Add domain<span className="k2">Ctrl Enter</span>
        </button>
      </div>
    </Sheet>
  );
}
