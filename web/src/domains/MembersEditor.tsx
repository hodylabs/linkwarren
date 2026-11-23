import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type Domain } from "../api";
import { errorText } from "../copy";
import { Switch } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";

const label = (u: { name: string | null; email: string; status: string }) => `${u.name || u.email}${u.status === "disabled" ? " (disabled)" : ""}`;

/** Needs domains.manage (S8 R8). Saves the whole member set in one call, so it is all or nothing. */
export function MembersEditor({ domain }: { domain: Domain }) {
  const app = useApp();
  const { me, users } = app;
  const people = (users ?? []).filter((u) => u.role === "member");
  const saved = people.filter((u) => u.domains.some((d) => d.id === domain.id && d.via === "member")).map((u) => u.id);
  const savedKey = saved.join(",");
  const [picked, setPicked] = useState(() => new Set(saved));
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const sent = useRef<{ domainId: string; ids: Set<string> } | null>(null); // the set a pending or finished save sent
  useEffect(() => {
    const next = new Set(savedKey ? savedKey.split(",") : []);
    const s = sent.current;
    sent.current = null;
    // Switches flipped after the save was sent keep their new position; the rest follow the saved set.
    setPicked((cur) => {
      if (s?.domainId !== domain.id) return next;
      for (const id of new Set([...cur, ...s.ids])) if (cur.has(id) !== s.ids.has(id)) (cur.has(id) ? next.add(id) : next.delete(id));
      return next;
    });
  }, [savedKey, domain.id]);
  useEffect(() => setError(null), [domain.id]);

  if (!can(me, "domains.manage")) return null;
  if (domain.type === "main")
    return (
      <div className="sect">
        <h3>Who can use it</h3>
        <p className="hint">Everyone can use the main domain.</p>
      </div>
    );

  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const save = async () => {
    // Saving replaces the whole set: without the loaded list it would send an empty or partial one and remove members.
    if (busy.current || users === null) return;
    busy.current = true;
    setError(null);
    const ids = new Set(people.filter((u) => picked.has(u.id)).map((u) => u.id));
    try {
      await api("PUT", `/api/domains/${encodeURIComponent(domain.id)}/members`, { userIds: [...ids] });
      sent.current = { domainId: domain.id, ids };
      app.announce("Members saved");
      await app.reloadUsers().catch(() => app.announce("Saved, but the list could not be refreshed"));
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal"); // the choices stay as typed
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // the domain settings form must not save too
      void save();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setPicked(new Set(saved));
      setError(null);
    }
  };

  return (
    <div className="sect" onKeyDown={onKeyDown}>
      <h3>Who can use it</h3>
      {users === null ? (
        <p className="hint">Loading people</p>
      ) : people.length === 0 ? (
        <p className="hint">No members yet.</p>
      ) : (
        <div className="rules">
          {people.map((u) => (
            <div className="rule" key={u.id}>
              <span className="lbl">{label(u)}</span>
              <Switch checked={picked.has(u.id)} onChange={(on) => toggle(u.id, on)} label={label(u)} />
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="err" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={users === null} aria-keyshortcuts="Control+Enter">
          Save members <span className="k">Ctrl Enter</span>
        </button>
      </div>
    </div>
  );
}
