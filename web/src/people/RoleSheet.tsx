import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Me, type RoleItem } from "../api";
import { errorText, plural } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { isOwner, PERM_TEXT, PERMS, type Perm } from "../perms";
import { Confirm, Sheet } from "../shell/Sheet";
import { Tag } from "../shell/ui";
import { RolePicker } from "./RolePicker";

/** Role sheet hotkeys and their text on the shortcuts sheet (owners only: everyone else reads it). */
export const ROLE_SHEET_KEYS = {
  "mod+enter": "Save the role, in a role's sheet",
  "shift+x": "Delete the role",
} as const;

/** Some codes mean something else here than elsewhere. */
const roleError = (code: string) => errorText({ name_taken: "role_name_taken", changed: "conflict" }[code] ?? code);
/** The server's rule (src/api/roles.ts cleanName) as a first check: NFC, trimmed, 1 to 40 characters. */
const cleanName = (raw: string): string | null => {
  const n = raw.normalize("NFC").trim();
  return [...n].length >= 1 && [...n].length <= 40 ? n : null;
};

type Step = null | "delete" | "move";

/** `role` null: a new role. Owners edit every role but Owner; anyone else (people managers) reads it (S8 R4, R15). */
export function RoleSheet({ role, roles, me, onClose, onDone, onReload }: {
  role: RoleItem | null;
  roles: RoleItem[];
  me: Pick<Me, "role" | "perms">;
  onClose: () => void;
  onDone: (msg: string) => void;
  /** Reloads the role list; the sheet then starts over from the fresh role. */
  onReload: () => Promise<void>;
}) {
  const fixed = role?.id === "owner";
  const editable = isOwner(me) && !fixed;
  const deletable = isOwner(me) && role !== null && role.builtin === null;
  const [name, setName] = useState(role?.name ?? "");
  const [perms, setPerms] = useState<Perm[]>(role?.perms ?? []);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [count, setCount] = useState(role?.people ?? 0);
  const [moveTo, setMoveTo] = useState("member");
  const busy = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // A reload hands in a fresh role object: start over from it (edits made against the old one are dropped).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    setName(role?.name ?? "");
    setPerms(role?.perms ?? []);
    setCount(role?.people ?? 0);
    setStep(null);
    setError(null);
    nameRef.current?.focus();
  }, [role]);

  const run = async (call: () => Promise<string>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      onDone(await call());
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "internal";
      // The count was stale: someone has the role now, so ask where they go instead of failing.
      if (code === "role_in_use") {
        const n = (e as ApiError).data as { people?: unknown } | undefined;
        setCount(typeof n?.people === "number" ? n.people : Math.max(count, 1));
        setStep("move");
      }
      setError(code);
    } finally {
      busy.current = false;
    }
  };

  const save = () => {
    if (!editable) return;
    const n = cleanName(name);
    if (!n) return setError("bad_name");
    const next = PERMS.filter((p) => perms.includes(p));
    if (!role) return void run(() => api("POST", "/api/roles", { name: n, perms: next }).then(() => `Created the role ${n}`));
    const body = {
      ...(n !== role.name ? { name: n } : {}),
      ...(next.join() !== PERMS.filter((p) => role.perms.includes(p)).join() ? { perms: next } : {}),
    };
    if (!Object.keys(body).length) return onClose();
    void run(() => api("PATCH", `/api/roles/${encodeURIComponent(role.id)}`, body).then(() => `Saved the role ${n}`));
  };
  const askDelete = () => {
    if (!deletable) return;
    setError(null);
    setStep(role.people > 0 ? "move" : "delete");
  };
  const remove = (to?: string) =>
    role && void run(() => api("DELETE", `/api/roles/${encodeURIComponent(role.id)}`, to === undefined ? undefined : { moveTo: to }).then(() => `Deleted the role ${role.name}`));

  useHotkeys({ "mod+enter": save, "shift+x": askDelete } satisfies Bindings<typeof ROLE_SHEET_KEYS>, step === null);

  const toggle = (p: Perm) => setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const title = role ? role.name : "New role";
  const targets = roles.filter((r) => r.id !== "owner" && r.id !== role?.id);
  const target = targets.find((r) => r.id === moveTo)?.name ?? "Member";
  const close = () => (busy.current ? undefined : onClose());
  // A conflict offers a reload in place, so the person never has to close and reopen to see the latest.
  const errorLine = error && (
    <>
      <p className="err" role="alert">{roleError(error)}</p>
      {error === "changed" && <button type="button" className="btn" onClick={() => void onReload()}>Reload</button>}
    </>
  );

  return (
    <Sheet label={title} onClose={close}>
      <div className="sh-head">
        <h2>{title} {role && <Tag tone="off">{plural(role.people, "person", "people")}</Tag>}</h2>
        <span className="x"><kbd>Esc</kbd> close</span>
      </div>
      <div className="sh-body">
        {editable && (
          <div className="f">
            <label htmlFor="rl-name">Name</label>
            <div className={error === "bad_name" || error === "name_taken" ? "ctl bad" : "ctl"}>
              <input id="rl-name" ref={nameRef} autoFocus value={name} spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
        )}
        {fixed && <p className="hint">The owner role always has every permission.</p>}
        {!isOwner(me) && <p className="hint">Only an owner can change roles.</p>}
        <div className="f">
          <h3 className="lbl">What this role can do</h3>
          <ul className="perms">
            {PERMS.map((p) => (
              <li key={p} className="perm">
                <input type="checkbox" id={`rl-${p}`} value={p} checked={fixed || perms.includes(p)} disabled={!editable} onChange={() => toggle(p)} />
                <label htmlFor={`rl-${p}`}>
                  <span className="perm-name">{PERM_TEXT[p].label}</span>
                  <small>{PERM_TEXT[p].hint}</small>
                </label>
              </li>
            ))}
          </ul>
        </div>
        {error && step === null && errorLine}
      </div>
      {editable && (
        <div className="sh-foot">
          {deletable && (
            <button type="button" className="btn bad" aria-keyshortcuts="Shift+X" onClick={askDelete}>
              Delete <kbd>Shift X</kbd>
            </button>
          )}
          <button type="button" className="btn primary" aria-keyshortcuts="Control+Enter" onClick={save}>
            {role ? "Save" : "Create role"}
            <span className="k2">Ctrl Enter</span>
          </button>
        </div>
      )}
      {step === "delete" && role && (
        <Confirm key="delete" title={`Delete the role ${role.name}`} text={`Delete the role ${role.name}? This cannot be undone.`} ok="Delete" onOk={() => remove()} onCancel={() => (setStep(null), setError(null))}>
          {error && errorLine}
        </Confirm>
      )}
      {step === "move" && role && (
        <Confirm key="move" title={`Delete the role ${role.name}`} text={`Its people move to ${target}. This cannot be undone.`} ok="Delete" onOk={() => remove(moveTo)} onCancel={() => (setStep(null), setError(null))}>
          <p className="lbl">Move its {plural(count, "person", "people")} to</p>
          <RolePicker value={moveTo} onChange={setMoveTo} roles={targets} me={me} label={`Move its ${plural(count, "person", "people")} to`} />
          {error && errorLine}
        </Confirm>
      )}
    </Sheet>
  );
}
