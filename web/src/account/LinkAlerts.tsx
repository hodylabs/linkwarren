import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AlertPrefs } from "../api";
import { errorText } from "../copy";
import { Switch } from "../shell/ui";

/**
 * S13: the person's link alert emails. Off by default; when on, each kind has its own switch. At most one email a day, about
 * the links the person can see. Without email on the instance the switch is disabled and says why.
 */
export function LinkAlerts() {
  const [p, setP] = useState<AlertPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    api<AlertPrefs>("GET", "/api/account/alerts", undefined, ac.signal).then(setP, (e: unknown) => {
      if (!ac.signal.aborted) setError(errorText(e instanceof ApiError ? e.code : "internal"));
    });
    return () => ac.abort();
  }, []);
  const save = async (next: Partial<Pick<AlertPrefs, "enabled" | "quiet" | "spike">>) => {
    if (busy.current || !p) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      setP(await api<AlertPrefs>("PUT", "/api/account/alerts", { enabled: p.enabled, quiet: p.quiet, spike: p.spike, ...next }));
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : "internal"));
    }
    busy.current = false;
    setSaving(false);
  };
  if (!p) return error ? <p className="err" role="alert">{error}</p> : null;
  return (
    <>
      <div className="p-sec">Link alerts</div>
      <div className="toggle sfield">
        <div>
          <b>Link alert emails</b>
          <small id="alerts-hint">
            {p.emailReady
              ? "At most one email a day about the links you can see, when one of the alerts below happens."
              : "Email is not set up on this instance, so alerts are off. The owner can set it up in Settings."}
          </small>
        </div>
        <Switch checked={p.enabled} onChange={(enabled) => void save({ enabled })} label="Link alert emails" disabled={saving || (!p.emailReady && !p.enabled)} describedBy="alerts-hint" />
      </div>
      {p.enabled && (
        <>
          <div className="toggle sfield">
            <div>
              <b>Gone quiet</b>
              <small>A link that had at least 5 clicks a day gets none for 14 days.</small>
            </div>
            <Switch checked={p.quiet} onChange={(quiet) => void save({ quiet })} label="Gone quiet alerts" disabled={saving} />
          </div>
          <div className="toggle sfield">
            <div>
              <b>Spike</b>
              <small>Yesterday had at least 20 clicks and 3 times the average of the week before.</small>
            </div>
            <Switch checked={p.spike} onChange={(spike) => void save({ spike })} label="Spike alerts" disabled={saving} />
          </div>
        </>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </>
  );
}
