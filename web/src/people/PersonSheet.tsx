import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type InviteResult, type Me, type UserItem } from "../api";
import { notSent } from "./InviteSheet";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { useDetailView } from "../shell/narrow";
import { Confirm, Sheet } from "../shell/Sheet";
import { Tag } from "../shell/ui";
import { can as has, isOwner, mayAssign } from "../perms";
import { RolePicker, RolesLoadError, useRoles } from "./RolePicker";
import { useApp } from "../state";
import { shortDate } from "../time";

/** Person sheet hotkeys and their text on the shortcuts sheet. Each acts only where its button is shown. */
export const PERSON_KEYS = {
  r: "Re-send the invite, in a person's sheet",
  "shift+r": "Revoke the invite",
  "shift+d": "Turn off their access",
  "shift+s": "Sign them out everywhere",
  e: "Turn their access back on",
  "shift+x": "Remove the person",
  a: "Show their activity in the audit log",
} as const;
const STATUS = { invited: ["wait", "Invited"], active: ["ok", "Active"], disabled: ["off", "Disabled"] } as const;
type Ask = "revoke" | "disable" | "signout" | "remove" | "role";

const label = (u: UserItem) => u.name || u.email;
const peopleError = (code: string) => errorText({ too_many: "invite_too_many", email_not_configured: "invite_email_off" }[code] ?? code);

/** Who may receive a removed person's links and domains: an owner picks anyone active (themselves first, only owners when
 * main or shared domains move); anyone else only an active owner, the first owner first (S8 R4, as the server checks). */
export function transferTargets(users: UserItem[], me: Me, id: string, needsOwner: boolean): UserItem[] {
  const owner = me.role === "owner";
  return users
    .filter((x) => x.id !== id && x.status === "active" && ((owner && !needsOwner) || x.role === "owner"))
    .sort(owner ? (a, b) => Number(b.id === me.id) - Number(a.id === me.id) : (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** R6: role and access here; who can use a domain is set on the domain. The owner never acts on themselves (R4). */
export function PersonSheet({ id }: { id: string }) {
  const app = useApp();
  const { me, users, domains } = app;
  const u = users?.find((x) => x.id === id) ?? null;
  const self = id === me.id;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState(me.id);
  const [pick, setPick] = useState("member"); // the role chosen in the picker, until confirmed
  const { roles, error: rolesError, reload: reloadRoles } = useRoles();
  const busy = useRef(false);
  const { show } = useDetailView("/people");

  // Gone (revoked, removed elsewhere) once the list is loaded: nothing to show.
  useEffect(() => {
    if (users !== null && !u) app.close();
  }, [users, u]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolves true when the change was made. */
  const run = async (call: () => Promise<string | null>, done?: { msg: string; close?: boolean }): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setAsk(null);
    setError(null);
    try {
      const failed = await call();
      if (failed) setError(failed);
      else if (done) {
        if (done.close) app.close();
        app.announce(done.msg);
      }
      app.reloadUsers().catch(() => undefined);
      return !failed;
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal");
      return false;
    } finally {
      busy.current = false;
    }
  };

  const path = `/api/users/${encodeURIComponent(id)}`;
  const email = u?.email ?? "";
  const patch = (body: object) => api("PATCH", path, body).then(() => null);
  const act = {
    resend: () => run(async () => {
      const r = await api<InviteResult>("POST", `${path}/resend`);
      return r.emailed ? null : notSent(r.emailReason);
    }, { msg: `Re-sent the invite to ${email}` }),
    revoke: () => run(() => api("DELETE", `${path}/invite`).then(() => null), { msg: `Revoked the invite for ${email}`, close: true }),
    disable: () => run(() => patch({ status: "disabled" }), { msg: `Turned off access for ${email}` }),
    enable: () => run(() => patch({ status: "active" }), { msg: `Turned on access for ${email}` }),
    signout: () => run(() => api("DELETE", `${path}/sessions`).then(() => null), { msg: `Signed ${email} out everywhere` }),
    remove: () => run(() => api("DELETE", `${path}?transferTo=${encodeURIComponent(to)}`).then(() => null), { msg: `Removed ${email}`, close: true }),
    role: (roleId: string, msg: string) => run(() => patch({ roleId }), { msg }),
    name: (name: string) => run(() => patch({ name }), { msg: name.trim() ? `Saved the name for ${email}` : `Removed the name for ${email}` }),
  };
  // The transfer target starts at you (a non-owner: the first owner) each time, so a target removed or disabled since never lingers.
  const askRemove = () => {
    setTo(me.role === "owner" ? me.id : transferTargets(users ?? [], me, id, true)[0]?.id ?? "");
    setAsk("remove");
  };
  const activity = () => {
    app.close();
    if (!show(id)) navigate(`/people?sel=${encodeURIComponent(id)}`, { replace: true });
  };

  const st = u?.status;
  // R4: an owner reaches anyone; a people manager only someone whose current role is within their own permissions, never an owner.
  // Every action on the person (role, status, sign-out, invite, removal) and its shortcut follows it; the server refuses the rest.
  const reach = !!u && !self && (isOwner(me) || (u.role !== "owner" && mayAssign(me, { id: u.roleId, perms: u.perms })));
  const can = (s: typeof st) => reach && st === s;
  // Activity shows their audit log entries on People, which needs the audit permission (S8 R2).
  const audit = has(me, "audit");
  // Without the Activity button the sheet would focus the first action (maybe "Turn on access"): focus the heading instead.
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!audit) head.current?.focus(); }, [audit, !!u]); // eslint-disable-line react-hooks/exhaustive-deps
  useHotkeys(
    {
      r: (e) => void (!e.shiftKey && can("invited") && act.resend()),
      "shift+r": () => can("invited") && setAsk("revoke"),
      "shift+d": () => can("active") && setAsk("disable"),
      "shift+s": () => can("active") && setAsk("signout"),
      e: (e) => void (!e.shiftKey && can("disabled") && act.enable()),
      "shift+x": () => reach && askRemove(),
      a: (e) => void (!e.shiftKey && audit && activity()),
    } satisfies Bindings<typeof PERSON_KEYS>,
    ask === null,
  );

  if (!u) return null;
  const [tone, status] = STATUS[u.status];
  // R5: main and shared domains may only move to an owner.
  const moving = u.domains.filter((d) => d.via === "owner" && (domains.find((x) => x.id === d.id)?.type ?? "main") !== "private").map((d) => d.host);
  const needsOwner = moving.length > 0;
  const targets = transferTargets(users ?? [], me, id, needsOwner);
  const target = targets.find((x) => x.id === to) ?? null;
  const choice = !target || target.id === me.id ? "you" : label(target);
  const picked = roles?.find((r) => r.id === pick);
  const roleAsk = pick === "owner"
    ? { title: `Make ${email} an owner`, text: `Make ${email} an owner? They can change every setting and person.`, ok: "Make owner", msg: `Made ${email} an owner` }
    : {
      title: pick === "member" ? `Make ${email} a member` : `Give ${email} the role ${picked?.name ?? ""}`,
      ok: pick === "member" ? "Make member" : "Give role",
      msg: pick === "member" ? `Made ${email} a member` : `Gave ${email} the role ${picked?.name ?? ""}`,
      text: u.role === "owner"
        ? `They lose owner rights${moving.length ? `, and ${moving.join(", ")} move to you.` : ". No domains move."}`
        : `They can do what ${picked?.name ?? "it"} allows from their next request.`,
    };
  const btn = (text: string, keys: string, aria: string, onClick: () => void, cls = "btn", autoFocus = false) => (
    <button type="button" className={cls} aria-keyshortcuts={aria} onClick={onClick} autoFocus={autoFocus}>
      {text} <kbd>{keys}</kbd>
    </button>
  );

  return (
    <Sheet label={label(u)} onClose={() => (busy.current ? undefined : app.close())}>
      <div className="sh-head">
        <h2 ref={head} tabIndex={-1}>{label(u)} <Tag tone={tone}>{status}</Tag></h2>
        <span className="x"><kbd>Esc</kbd> close</span>
      </div>
      <div className="sh-body">
        <p>
          {u.name && <>{u.email}<br /></>}
          {!self && <small>{u.status === "invited" ? "Invited" : "Added"} {shortDate(u.createdAt)}</small>}
        </p>
        {reach && <NameField key={u.id} current={u.name} onSave={act.name} />}
        <div className="f">
          <h3 className="lbl">Role</h3>
          {reach && roles ? (
            <RolePicker value={u.role === "owner" ? "owner" : u.roleId} roles={roles} me={me} allowOwner onChange={(v) => (setPick(v), setAsk("role"))} />
          ) : (
            <p>{u.role === "owner" ? "Owner" : u.roleName}{self ? " (you)" : ""}</p>
          )}
          {reach && !roles && rolesError && <RolesLoadError onRetry={() => void reloadRoles()} />}
        </div>
        <div className="f">
          <h3 className="lbl">Domains</h3>
          {u.role === "owner" ? (
            <p>All {domains.length} domains</p>
          ) : (
            <div className="rules">
              {domains.filter((d) => d.type === "main").map((d) => (
                <div key={d.id} className="rule"><span className="lbl mono">{d.host}</span><small>Main, always included</small></div>
              ))}
              {u.domains.map((d) => (
                <div key={d.id} className="rule"><span className="lbl mono">{d.host}</span><small>{d.via === "owner" ? "Their own" : "Can use"}</small></div>
              ))}
            </div>
          )}
          <p className="hint">Who can use a shared domain is set on the Domains screen.</p>
        </div>
        {error && <p className="err" role="alert">{peopleError(error)}</p>}
        <div className="actions">
          {/* The first focus: never a control that changes data, so a stray Enter or arrow does nothing harmful. */}
          {audit && btn("Activity", "A", "A", activity, "btn", true)}
          {can("invited") && btn("Resend", "R", "R", () => void act.resend())}
          {can("invited") && btn("Revoke", "Shift R", "Shift+R", () => setAsk("revoke"))}
          {can("active") && btn("Turn off access", "Shift D", "Shift+D", () => setAsk("disable"))}
          {can("active") && btn("Sign out everywhere", "Shift S", "Shift+S", () => setAsk("signout"))}
          {can("disabled") && btn("Turn on access", "E", "E", () => void act.enable())}
          {reach && btn("Remove", "Shift X", "Shift+X", askRemove, "btn bad")}
        </div>
      </div>
      {ask === "revoke" && (
        <Confirm title="Revoke the invite" text={`Revoke the invite for ${email}? They will not be able to sign in.`} ok="Revoke" onOk={() => void act.revoke()} onCancel={() => setAsk(null)} />
      )}
      {ask === "disable" && (
        <Confirm title="Turn off access" text={`Turn off access for ${email}? They are signed out now, and their agents and API keys stop working.`} ok="Turn off" onOk={() => void act.disable()} onCancel={() => setAsk(null)} />
      )}
      {ask === "signout" && (
        <Confirm title="Sign out everywhere" text={`Sign ${email} out on every device?`} ok="Sign out" onOk={() => void act.signout()} onCancel={() => setAsk(null)} />
      )}
      {ask === "role" && (
        <Confirm tone="primary" title={roleAsk.title} ok={roleAsk.ok} onOk={() => void act.role(pick, roleAsk.msg)} onCancel={() => setAsk(null)}
          text={pick === "owner" ? roleAsk.text : `${roleAsk.title}? ${roleAsk.text}`} />
      )}
      {ask === "remove" && (
        <Confirm title={`Remove ${email}`} ok="Remove" onOk={() => void act.remove()} onCancel={() => setAsk(null)}
          text={`Remove ${email}? Their links and domains move to ${choice}. Their API keys and agent connections are deleted. This cannot be undone.`}>
          <div className="f">
            <label htmlFor="ps-to">Move their links and domains to</label>
            <div className="ctl">
              <select id="ps-to" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void act.remove())}>
                {targets.map((x) => <option key={x.id} value={x.id}>{x.id === me.id ? "You" : label(x)}</option>)}
              </select>
            </div>
          </div>
        </Confirm>
      )}
    </Sheet>
  );
}

/** Their name, set by an owner or a people manager in reach: Enter saves, empty clears. */
function NameField({ current, onSave }: { current: string | null; onSave: (name: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(current ?? ""); // the last name the server confirmed
  const tidy = (n: string) => n.replace(/\s+/g, " ").trim(); // as the server stores it
  const changed = tidy(draft) !== saved; // an unsaved edit, which a reload never replaces
  useEffect(() => { if (!changed) setDraft(current ?? ""); setSaved(current ?? ""); }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    void onSave(draft).then((ok) => { if (ok) setSaved(tidy(draft)); }).finally(() => setSaving(false)); // a failed save keeps its text
  };
  return (
    <form className="f" onSubmit={submit}>
      <label htmlFor="ps-name">Name</label>
      <div className="acct-name">
        <input id="ps-name" className="input sans" value={draft} maxLength={40} autoComplete="off" placeholder="No name yet"
          onChange={(e) => setDraft(e.target.value)} readOnly={saving} />
        <button type="submit" className="btn" disabled={!changed || saving}>{saving ? "Saving" : "Save"}</button>
      </div>
    </form>
  );
}
