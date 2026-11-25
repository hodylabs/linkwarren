import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { errorText } from "../copy";
import { useApp } from "../state";

/** Your own name, shown to the people you work with instead of your email address. Empty clears it. */
export function YourName() {
  const { me, setMyName, announce } = useApp();
  const [draft, setDraft] = useState(me.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  // A save elsewhere (the other copy of this field, Settings or the account sheet) replaces the draft, so an older one never overwrites it.
  useEffect(() => setDraft(me.name ?? ""), [me.name]);
  const changed = draft.trim() !== (me.name ?? "");
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy.current || !changed) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ name: string | null }>("PUT", "/api/account/name", { name: draft });
      setMyName(r.name);
      setDraft(r.name ?? "");
      announce(r.name ? "Name saved" : "Name removed");
    } catch (err) {
      setError(errorText(err instanceof ApiError ? err.code : "internal"));
    }
    busy.current = false;
    setSaving(false);
  };
  return (
    <>
      <div className="p-sec">Your name</div>
      <form className="acct-name" onSubmit={save}>
        <input id="acct-name" className="input sans" aria-label="Your name" aria-describedby="acct-name-hint" value={draft} maxLength={40} autoComplete="name"
          placeholder={me.email} onChange={(e) => setDraft(e.target.value)} readOnly={saving} />
        <button type="submit" className="btn" disabled={saving || !changed}>Save</button>
      </form>
      <small id="acct-name-hint" className="muted">Shown to the people you work with instead of your email address. Up to 40 characters.</small>
      {error && <p className="err" role="alert">{error}</p>}
    </>
  );
}
