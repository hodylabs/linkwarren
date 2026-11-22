import { useEffect, useRef, useState } from "react";
import { api, ApiError, type InviteResult, type UserItem } from "../api";
import { notSent } from "./InviteSheet";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate } from "../router";
import { useDetailView } from "../shell/narrow";
import { Confirm, Sheet } from "../shell/Sheet";
import { Seg, Tag } from "../shell/ui";
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
const ROLES: { value: "member" | "owner"; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "owner", label: "Owner" },
];
const STATUS = { invited: ["wait", "Invited"], active: ["ok", "Active"], disabled: ["off", "Disabled"] } as const;
type Ask = "revoke" | "disable" | "signout" | "remove" | "promote" | "demote";

const label = (u: UserItem) => u.name || u.email;
const peopleError = (code: string) => errorText({ too_many: "invite_too_many", email_not_configured: "invite_email_off" }[code] ?? code);

/** R6: role and access here; who can use a domain is set on the domain. The owner never acts on themselves (R4). */
export function PersonSheet({ id }: { id: string }) {
  const app = useApp();
  const { me, users, domains } = app;
  const u = users?.find((x) => x.id === id) ?? null;
  const self = id === me.id;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState(me.id);
  const busy = useRef(false);
  const { show } = useDetailView("/people");

  // Gone (revoked, removed elsewhere) once the list is loaded: nothing to show.
  useEffect(() => {
    if (users !== null && !u) app.close();
  }, [users, u]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (call: () => Promise<string | null>, done?: { msg: string; close?: boolean }) => {
    if (busy.current) return;
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
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "internal");
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
    role: (role: "member" | "owner") => run(() => patch({ roleId: role }), { msg: `Made ${email} ${role === "owner" ? "an owner" : "a member"}` }),
  };
  // The transfer target starts at you each time, so a target removed or disabled since never lingers.
  const askRemove = () => {
    setTo(me.id);
    setAsk("remove");
  };
  const activity = () => {
    app.close();
    if (!show(id)) navigate(`/people?sel=${encodeURIComponent(id)}`, { replace: true });
  };

  const st = u?.status;
  const can = (s: typeof st) => !self && st === s;
  useHotkeys(
    {
      r: (e) => void (!e.shiftKey && can("invited") && act.resend()),
      "shift+r": () => can("invited") && setAsk("revoke"),
      "shift+d": () => can("active") && setAsk("disable"),
      "shift+s": () => can("active") && setAsk("signout"),
      e: (e) => void (!e.shiftKey && can("disabled") && act.enable()),
      "shift+x": () => !self && askRemove(),
      a: (e) => void (!e.shiftKey && activity()),
    } satisfies Bindings<typeof PERSON_KEYS>,
    ask === null,
  );

  if (!u) return null;
  const [tone, status] = STATUS[u.status];
  // R5: main and shared domains may only move to an owner.
  const moving = u.domains.filter((d) => d.via === "owner" && (domains.find((x) => x.id === d.id)?.type ?? "main") !== "private").map((d) => d.host);
  const needsOwner = moving.length > 0;
  const targets = (users ?? [])
    .filter((x) => x.id !== id && x.status === "active" && (!needsOwner || x.role === "owner"))
    .sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id));
  const target = targets.find((x) => x.id === to) ?? null;
  const choice = !target || target.id === me.id ? "you" : label(target);
  const btn = (text: string, keys: string, aria: string, onClick: () => void, cls = "btn", autoFocus = false) => (
    <button type="button" className={cls} aria-keyshortcuts={aria} onClick={onClick} autoFocus={autoFocus}>
      {text} <kbd>{keys}</kbd>
    </button>
  );

  return (
    <Sheet label={label(u)} onClose={() => (busy.current ? undefined : app.close())}>
      <div className="sh-head">
        <h2>{label(u)} <Tag tone={tone}>{status}</Tag></h2>
        <span className="x"><kbd>Esc</kbd> close</span>
      </div>
      <div className="sh-body">
        <p>
          {u.name && <>{u.email}<br /></>}
          {!self && <small>{u.status === "invited" ? "Invited" : "Added"} {shortDate(u.createdAt)}</small>}
        </p>
        <div className="f">
          <h3 className="lbl">Role</h3>
          {self ? <p>Owner (you)</p> : <Seg label="Role" options={ROLES} value={u.role} onChange={(v) => v !== u.role && setAsk(v === "owner" ? "promote" : "demote")} />}
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
          {btn("Activity", "A", "A", activity, "btn", true)}
          {can("invited") && btn("Resend", "R", "R", () => void act.resend())}
          {can("invited") && btn("Revoke", "Shift R", "Shift+R", () => setAsk("revoke"))}
          {can("active") && btn("Turn off access", "Shift D", "Shift+D", () => setAsk("disable"))}
          {can("active") && btn("Sign out everywhere", "Shift S", "Shift+S", () => setAsk("signout"))}
          {can("disabled") && btn("Turn on access", "E", "E", () => void act.enable())}
          {!self && btn("Remove", "Shift X", "Shift+X", askRemove, "btn bad")}
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
      {ask === "demote" && (
        <Confirm title={`Make ${email} a member`} ok="Make member" onOk={() => void act.role("member")} onCancel={() => setAsk(null)}
          text={`Make ${email} a member? They lose owner rights${moving.length ? `, and ${moving.join(", ")} move to you.` : ". No domains move."}`} />
      )}
      {ask === "promote" && (
        <Confirm title={`Make ${email} an owner`} text={`Make ${email} an owner? They can change every setting and person.`} ok="Make owner" onOk={() => void act.role("owner")} onCancel={() => setAsk(null)} />
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
