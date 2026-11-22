import { useRef, useState } from "react";
import { errorText, plural } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { isOwner } from "../perms";
import { NavLink, navigate } from "../router";
import { PrimaryButton, ScreenHeader } from "../shell/ui";
import { useApp } from "../state";
import { RoleSheet } from "./RoleSheet";
import { useRoles } from "./RolePicker";

const MAX_CUSTOM = 20; // src/api/roles.ts

/** Roles view hotkeys and their text on the shortcuts sheet. */
export const ROLES_KEYS = {
  j: "Next role",
  k: "Previous role",
  n: "New role",
  p: "Show people, in Roles",
} as const;

/** The People screen's two views (S8 R15), for owners and people managers. */
export function PeopleTabs({ at }: { at: "people" | "roles" }) {
  return (
    <nav className="seg" aria-label="People views">
      <NavLink to="/people" aria-current={at === "people" ? "page" : undefined}>People <kbd>P</kbd></NavLink>
      <NavLink to="/people/roles" aria-current={at === "roles" ? "page" : undefined}>Roles <kbd>O</kbd></NavLink>
    </nav>
  );
}

/** /people/roles: every role with its people and permission counts. Owners edit and create; people managers read. */
export function RolesView() {
  const app = useApp();
  const { me, overlay } = app;
  const owner = isOwner(me);
  const { roles, error, reload } = useRoles();
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // a role id, or "" for a new role
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const list = roles ?? [];
  const at = list.findIndex((r) => r.id === sel);
  const custom = list.filter((r) => !r.builtin).length;
  const full = custom >= MAX_CUSTOM; // the server refuses a 21st (too_many_roles): say so before any typing
  const newRole = () => (full ? app.announce(errorText("too_many_roles")) : setOpen(""));

  const move = (step: 1 | -1) => {
    const to = at < 0 ? list[step === 1 ? 0 : list.length - 1] : list[at + step];
    if (!to) return;
    setSel(to.id);
    rowRefs.current.get(to.id)?.focus();
  };
  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      n: (e) => void (!e.shiftKey && owner && newRole()),
      p: (e) => void (!e.shiftKey && navigate("/people")),
    } satisfies Bindings<typeof ROLES_KEYS>,
    overlay === null && open === null,
  );

  const role = open ? list.find((r) => r.id === open) : null;
  return (
    <>
      <ScreenHeader
        title="Roles"
        count={roles ? plural(custom, "custom role") : undefined}
        text={owner ? "What each role can do. Who can use which domain is set per person and domain." : "What each role can do. Only an owner can change roles."}
      >
        <PeopleTabs at="roles" />
        {owner && full && <span className="hint">{errorText("too_many_roles")}</span>}
        {owner && <PrimaryButton label="New role" shortcut="N" disabled={full} onClick={newRole} />}
      </ScreenHeader>
      <div className="body solo">
        <section className="list" aria-label="Roles list">
          {error && <p className="err pad" role="alert">{errorText(error)}</p>}
          <table aria-label="Roles">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">People</th>
                <th className="num">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr
                  key={r.id}
                  ref={(el) => void (el ? rowRefs.current.set(r.id, el) : rowRefs.current.delete(r.id))}
                  aria-selected={r.id === sel}
                  tabIndex={r.id === sel || (at < 0 && i === 0) ? 0 : -1}
                  onFocus={() => setSel(r.id)}
                  onClick={() => setOpen(r.id)}
                  onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && (e.preventDefault(), setOpen(r.id))}
                >
                  <td>{r.name}</td>
                  <td className="num" data-label="People">{r.people}</td>
                  <td className="num" data-label="Permissions">{r.id === "owner" ? "All" : r.perms.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      {open !== null && (open === "" || role) && (
        <RoleSheet
          key={open}
          role={role ?? null}
          roles={list}
          me={me}
          onClose={() => setOpen(null)}
          onReload={reload}
          onDone={(msg) => {
            setOpen(null);
            app.announce(msg);
            reload().catch(() => undefined);
          }}
        />
      )}
    </>
  );
}
