import { useRef, useState, type KeyboardEvent } from "react";
import { ApiError, type Domain } from "../api";
import { Seg } from "../shell/ui";
import { useApp } from "../state";
import { patchDomainCf, type ControlsPatch } from "../settings/api";
import { settingsError } from "../settings/copy";

const LEVELS = [
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "under_attack", label: "Under attack" },
];

/**
 * Security level and rate limit for a domain in the owner's own Cloudflare account. The server does not report the current
 * values, so only fields the owner touched are sent (Default = null removes the rule; an empty rate removes it too).
 */
export function CfControls({ domain, controlsEnabled }: { domain: Domain; controlsEnabled: boolean }) {
  const { me } = useApp();
  const [level, setLevel] = useState("default");
  const [rate, setRate] = useState("");
  const [touched, setTouched] = useState({ level: false, rate: false });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  if (me.role !== "owner" || domain.cloudflare?.kind !== "account" || !controlsEnabled) return null;

  const save = async () => {
    if (busy.current) return;
    setSaved(false);
    const body: ControlsPatch = {};
    if (touched.level) body.securityLevel = level === "default" ? null : level;
    if (touched.rate) {
      const t = rate.trim();
      const n = Number(t);
      if (t !== "" && !(/^\d+$/.test(t) && n >= 10 && n <= 1000)) return setError("rate_range");
      body.rateLimit = t === "" ? null : n;
    }
    setError(null);
    if (Object.keys(body).length === 0) return;
    busy.current = true;
    try {
      await patchDomainCf(domain.id, body);
      setTouched({ level: false, rate: false });
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal");
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="sect" onKeyDown={onKeyDown}>
      <h3>Cloudflare</h3>
      <div className="field">
        <span id="cfc-level">Security level</span>
        <Seg options={LEVELS} value={level} label="Security level" onChange={(v) => { setLevel(v); setTouched((t) => ({ ...t, level: true })); }} />
      </div>
      <div className="field">
        <label htmlFor="cfc-rate">Rate limit</label>
        <input id="cfc-rate" className="input" inputMode="numeric" autoComplete="off" value={rate} aria-describedby="cfc-rate-hint" aria-invalid={error === "rate_range" ? true : undefined}
          onChange={(e) => { setRate(e.target.value); setTouched((t) => ({ ...t, rate: true })); }} />
      </div>
      <p id="cfc-rate-hint" className="muted">requests per 10 seconds per visitor, empty for none. Your Cloudflare plan may allow only one rate limit per zone.</p>
      {error && <p className="err" role="alert">{settingsError(error)}</p>}
      {saved && <p className="muted" role="status">Saved to Cloudflare.</p>}
      <button type="button" className="btn primary" onClick={() => void save()} aria-keyshortcuts="Control+Enter">
        Save<span className="k">Ctrl Enter</span>
      </button>
    </div>
  );
}
