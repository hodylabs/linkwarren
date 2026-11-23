import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type Me, type RoleItem } from "../api";
import { isOwner, mayAssign } from "../perms";

const rank = (r: RoleItem) => (r.id === "owner" ? 0 : r.id === "member" ? 1 : 2);
/** Owner, Member, then custom roles by name: the server's order, kept even if an answer comes back in another. */
export const sortRoles = (rs: RoleItem[]): RoleItem[] => [...rs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

/** GET /api/roles once on mount; `reload` after a change (`clear`: drop the old list first, so a failed reload leaves none). A stale answer is dropped. */
export function useRoles(): { roles: RoleItem[] | null; error: string | null; reload: (clear?: boolean) => Promise<void> } {
  const [roles, setRoles] = useState<RoleItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const reload = useCallback((clear = false) => {
    const g = ++gen.current;
    if (clear) setRoles(null);
    return api<RoleItem[]>("GET", "/api/roles").then(
      (r) => void (g === gen.current && (setRoles(sortRoles(r)), setError(null))),
      (e: unknown) => void (g === gen.current && setError(e instanceof ApiError ? e.code : "internal")),
    );
  }, []);
  useEffect(() => void reload(), [reload]);
  return { roles, error, reload };
}

/** The role list did not load: say so, with a Retry. */
export const RolesLoadError = ({ onRetry }: { onRetry: () => void }) => (
  <p className="err" role="alert">
    Could not load the roles.{" "}
    <button type="button" className="btn" onClick={onRetry}>Retry</button>
  </p>
);

/**
 * One tab stop listing roles: arrows, Home and End move, Enter or Space picks. No type-ahead: letters stay the sheet's hotkeys. Owner is listed only for an
 * owner and only with `allowOwner`; a role with a permission `me` lacks is shown but cannot be picked (the server refuses it, R4).
 */
export function RolePicker({ value, onChange, roles, me, allowOwner = false, label = "Role" }: {
  value: string;
  onChange: (id: string) => void;
  roles: RoleItem[];
  me: Pick<Me, "role" | "perms">;
  allowOwner?: boolean;
  label?: string;
}) {
  const shown = roles.filter((r) => r.id !== "owner" || (allowOwner && isOwner(me)));
  const [at, setAt] = useState(() => Math.max(0, shown.findIndex((r) => r.id === value)));
  const base = useId();
  const cur = Math.min(at, shown.length - 1);
  useEffect(() => {
    const i = shown.findIndex((r) => r.id === value);
    if (i >= 0) setAt(i);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (r: RoleItem | undefined) => r && mayAssign(me, r) && r.id !== value && onChange(r.id);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !shown.length) return; // Ctrl+Enter stays the sheet's submit
    const n = shown.length;
    const to = { ArrowDown: cur + 1, ArrowUp: cur - 1, Home: 0, End: n - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      setAt(Math.max(0, Math.min(n - 1, to)));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(shown[cur]);
    }
  };

  return (
    <div className="rules picker" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={shown[cur] ? `${base}-${cur}` : undefined} onKeyDown={onKeyDown}>
      {shown.map((r, i) => {
        const ok = mayAssign(me, r);
        return (
          <div key={r.id} id={`${base}-${i}`} role="option" aria-selected={r.id === value} aria-disabled={ok ? undefined : true}
            className={i === cur ? "rule open" : "rule"} onClick={() => (setAt(i), pick(r))}>
            <span className="lbl">{r.name}</span>
            {!ok && <small>Has permissions you do not have</small>}
          </div>
        );
      })}
    </div>
  );
}
