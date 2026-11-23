import { useRef, useState, type KeyboardEvent } from "react";
import { ApiError, type Domain } from "../api";
import { Seg } from "../shell/ui";
import { can } from "../perms";
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
 * Security level and rate limit for a domain in the owner's own Cloudflare account. The form starts from the server's stored
 * values and only fields that differ from the saved baseline are sent (Default = null removes the rule; an empty rate removes it too).
 */
export function CfControls({ domain, controlsEnabled }: { domain: Domain; controlsEnabled: boolean }) {
  const { me, reloadDomains } = useApp();
  const fromServer = (v: { securityLevel?: string | null; rateLimit?: number | null } | undefined) => ({ level: v?.securityLevel ?? "default", rate: v?.rateLimit == null ? "" : String(v.rateLimit) });
  const server = fromServer(domain.cloudflare);
  const [base, setBase] = useState(server); // what Cloudflare holds, as far as we know
  const [level, setLevel] = useState(base.level);
  const [rate, setRate] = useState(base.rate);
  // New stored values for the same domain (a reload or a poll): move the baseline, and every field the person has not edited.
  const [seen, setSeen] = useState(server);
  if (server.level !== seen.level || server.rate !== seen.rate) {
    setSeen(server);
    setBase(server);
    if (level === base.level) setLevel(server.level);
    if (rate === base.rate) setRate(server.rate);
  }
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  if (!can(me, "domains.manage") || domain.cloudflare?.kind !== "account" || !controlsEnabled) return null;

  const save = async () => {
    if (busy.current) return;
    setSaved(false);
    const body: ControlsPatch = {};
    if (level !== base.level) body.securityLevel = level === "default" ? null : level;
    if (rate.trim() !== base.rate) {
      const t = rate.trim();
      const n = Number(t);
      if (t !== "" && !(/^\d+$/.test(t) && n >= 10 && n <= 1000)) return setError("rate_range");
      body.rateLimit = t === "" ? null : n;
    }
    setError(null);
    if (Object.keys(body).length === 0) return;
    busy.current = true;
    try {
      setBase(fromServer(await patchDomainCf(domain.id, body)));
      setSaved(true);
      void reloadDomains().catch(() => {}); // the saved values are already in the form
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal");
      // A partial failure carries the stored values: the field that landed is no longer changed, the failed one stays.
      const d = e instanceof ApiError ? (e.data as { securityLevel?: string | null; rateLimit?: number | null } | undefined) : undefined;
      if (d && "securityLevel" in d && "rateLimit" in d) setBase(fromServer(d));
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // the detail form must not also save
      void save();
    }
  };

  return (
    <div className="sect" onKeyDown={onKeyDown}>
      <h3>Cloudflare</h3>
      <div className="field stack">
        <span id="cfc-level">Security level</span>
        <Seg wrap options={LEVELS} value={level} label="Security level" onChange={setLevel} />
      </div>
      <div className="field">
        <label htmlFor="cfc-rate">Rate limit</label>
        <input id="cfc-rate" className="input" inputMode="numeric" autoComplete="off" value={rate} aria-describedby="cfc-rate-hint" aria-invalid={error === "rate_range" ? true : undefined}
          onChange={(e) => setRate(e.target.value)} />
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
