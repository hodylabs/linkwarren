import { useEffect, useRef, useState } from "react";
import { api, ApiError, type InviteResult } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { Switch } from "../shell/ui";
import { can, mayAssign } from "../perms";
import { RolePicker, RolesLoadError, useRoles } from "./RolePicker";
import { useApp } from "../state";
import { withBase } from "../base";

/** Invite sheet hotkeys and their text on the shortcuts sheet. */
export const INVITE_KEYS = {
  "mod+enter": "Send the invite, in the Invite sheet",
  c: "Copy the dashboard address, when no email was sent",
} as const;
// A first check only; the server's rule (src/api/invites.ts) decides.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Mail = { emailFrom: string | null; emailConfigured: boolean; dashboardUrl: string };

/** The error code for an invite saved or re-sent without its email. */
export const notSent = (reason: InviteResult["emailReason"]) => (reason === "too_many" ? "invite_too_many" : reason === "not_configured" ? "invite_email_off" : "not_sent");

/** Some codes mean something else here than at sign-in. */
const inviteError = (code: string) => errorText({ invalid_body: "invite_email", too_many: "invite_too_many", email_not_configured: "invite_email_off" }[code] ?? code);

export function InviteSheet() {
  const app = useApp();
  const main = app.domains.filter((d) => d.type === "main");
  // Only owners and domain managers may give access to shared domains here; the server refuses the rest (src/api/invites.ts).
  const shared = can(app.me, "domains.manage") ? app.domains.filter((d) => d.type === "shared") : [];
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [chosen, setRole] = useState<string | null>(null); // a role id, once picked
  const { roles, error: rolesError, reload: reloadRoles } = useRoles();
  // Until one is picked: Member, or the first role a people manager below Member may give (R4). None at all: no invite.
  const role = chosen ?? roles?.find((r) => r.id !== "owner" && mayAssign(app.me, r))?.id ?? null;
  const perms = roles?.find((r) => r.id === role)?.perms ?? [];
  const ownDomains = role === "owner" || perms.includes("domains.own") || perms.includes("domains.manage");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mail, setMail] = useState<Mail | null>(null);
  // Set when the invite is saved but no email went out: the address to send them by hand.
  const [address, setAddress] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api<Mail>("GET", "/api/settings").then(setMail, () => undefined); // the footer is a hint; the invite works without it
  }, []);

  const submit = async () => {
    if (busy.current || address !== null || role === null) return;
    const e = email.trim();
    if (!EMAIL.test(e)) return setError("invite_email");
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await api<InviteResult>("POST", "/api/users/invite", { email: e, roleId: role, domainIds: role === "owner" ? [] : picked, ...(name.trim() ? { name } : {}) });
      app.reloadUsers().catch(() => undefined);
      if (res.emailed) {
        app.close();
        app.announce(`Invited ${e}`);
      } else {
        setWhy(notSent(res.emailReason));
        setAddress(`${mail?.dashboardUrl ?? `https://${location.host}${withBase("")}`}/`);
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "internal";
      setError(code); // the typed values stay in the form
      // The picked role was deleted meanwhile: drop the stale list (no send, no default from it) until a reload succeeds; the email and domains stay.
      if (code === "bad_role") { setRole(null); void reloadRoles(true); }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const copy = () => {
    if (address === null) return;
    navigator.clipboard.writeText(address).then(
      () => app.announce("Copied"),
      () => app.announce("Could not copy. Select the address and copy it."),
    );
  };
  const dismiss = () => (busy.current ? undefined : app.close());

  useHotkeys({ "mod+enter": () => void submit(), c: (e) => void (!e.shiftKey && copy()) } satisfies Bindings<typeof INVITE_KEYS>);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Sheet label="Invite a person" onClose={dismiss}>
      <div className="sh-head">
        <h2>Invite a person</h2>
        <span className="x">
          <kbd>Esc</kbd> {address ? "close" : "cancel"}
        </span>
      </div>
      {address !== null ? (
        <>
          <div className="sh-body">
            <p>Invite saved. No email was sent. Send them this address: {address}</p>
            {why && <p className="hint">{errorText(why)}</p>}
            <div className="actions">
              <button type="button" className="btn" onClick={copy} aria-keyshortcuts="C">
                Copy <kbd>C</kbd>
              </button>
              <button key="close" type="button" className="btn primary" autoFocus onClick={dismiss}>
                Close <span className="k">Esc</span>
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="sh-body">
            <div className="f">
              <label htmlFor="iv-email">Email</label>
              <div className={error === "invite_email" || error === "email_taken" ? "ctl bad" : "ctl"}>
                <input id="iv-email" type="email" autoFocus value={email} spellCheck={false} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="f">
              <h3 className="lbl">Role</h3>
              {/* Owner only for owners; a people manager picks among roles within their own permissions (R4). */}
              {roles && role !== null && <RolePicker value={role} onChange={setRole} roles={roles} me={app.me} allowOwner />}
              {roles && role === null && <p className="err" role="alert">Every role has permissions you do not have, so you cannot invite anyone. Ask an owner.</p>}
              {!roles && rolesError && <RolesLoadError onRetry={() => void reloadRoles()} />}
            </div>
            {role !== "owner" && (
              <div className="f">
                <h3 className="lbl">Domains they can use</h3>
                <div className="rules">
                  {main.map((d) => (
                    <div key={d.id} className="rule">
                      <span className="lbl mono">{d.host}</span>
                      <small>Main, always included</small>
                      <span className="sw on fixed" aria-hidden="true" />
                    </div>
                  ))}
                  {shared.map((d) => (
                    <div key={d.id} className="rule">
                      <span className="lbl mono">{d.host}</span>
                      <small>Shared</small>
                      <Switch label={d.host} checked={picked.includes(d.id)} onChange={() => toggle(d.id)} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="f">
              <label htmlFor="iv-name">Name <small className="muted">optional, they can change it</small></label>
              <div className={error === "invalid_name" ? "ctl bad" : "ctl"}>
                <input id="iv-name" value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <p className="hint">They get an email with a link to sign in. They sign in with their email, and can add a passkey{ownDomains && " and their own private domains"}.</p>
            {error && (
              <p className="err" role="alert">{inviteError(error)}</p>
            )}
          </div>
          <div className="sh-foot">
            <span className="left">{mail && (mail.emailConfigured && mail.emailFrom ? `Sent from ${mail.emailFrom}` : "Email is not set up yet")}</span>
            <button type="button" className="btn primary" aria-keyshortcuts="Control+Enter" aria-disabled={pending || undefined} onClick={() => void submit()}>
              {pending ? "Sending invite" : "Send invite"}
              <span className="k2">Ctrl Enter</span>
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
