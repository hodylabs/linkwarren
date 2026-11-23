import { useEffect, useRef, useState } from "react";
import { api, ApiError, type DigestPrefs } from "../api";
import { viewerZone } from "../time";
import { errorText } from "../copy";
import { Switch } from "../shell/ui";

/**
 * S10: the person's weekly clicks email. Off by default; turning it on stores this browser's time zone, so it comes on Monday
 * morning there. Without email on the instance the switch is disabled and says why.
 */
export function WeeklyEmail() {
  const [p, setP] = useState<DigestPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    api<DigestPrefs>("GET", "/api/account/digest", undefined, ac.signal).then(setP, (e: unknown) => {
      if (!ac.signal.aborted) setError(errorText(e instanceof ApiError ? e.code : "internal"));
    });
    return () => ac.abort();
  }, []);
  const save = async (enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      setP(await api<DigestPrefs>("PUT", "/api/account/digest", { enabled, tz: p?.enabled && p.tz ? p.tz : viewerZone() }));
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : "internal"));
    }
    busy.current = false;
    setSaving(false);
  };
  if (!p) return error ? <p className="err" role="alert">{error}</p> : null;
  const zone = p.enabled && p.tz ? p.tz : viewerZone();
  return (
    <>
      <div className="p-sec">Weekly email</div>
      <div className="toggle sfield">
        <div>
          <b>Weekly clicks summary</b>
          <small id="digest-hint">
            {p.emailReady
              ? `Monday morning (07:00, ${zone}): total clicks, QR codes, top 5 links and the change on the week before, for the links you can see.`
              : "Email is not set up on this instance, so the weekly email is off. The owner can set it up in Settings."}
          </small>
        </div>
        <Switch checked={p.enabled} onChange={(v) => void save(v)} label="Weekly clicks summary" disabled={saving || (!p.emailReady && !p.enabled)} describedBy="digest-hint" />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
    </>
  );
}
