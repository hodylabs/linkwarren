import { useEffect, useRef, useState } from "react";
import { api, ApiError, type InviteResult } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { Seg, Switch } from "../shell/ui";
import { useApp } from "../state";

/** Invite sheet hotkeys and their text on the shortcuts sheet. */
export const INVITE_KEYS = {
  "mod+enter": "Send the invite, in the Invite sheet",
  c: "Copy the dashboard address, when no email was sent",
} as const;
const ROLES: { value: "member" | "owner"; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "owner", label: "Owner" },
];
// A first check only; the server's rule (src/api/invites.ts) decides.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Mail = { emailFrom: string | null; emailConfigured: boolean; dashboardHost: string };

/** The error code for an invite saved or re-sent without its email. */
export const notSent = (reason: InviteResult["emailReason"]) => (reason === "too_many" ? "invite_too_many" : reason === "not_configured" ? "invite_email_off" : "not_sent");

/** Some codes mean something else here than at sign-in. */
const inviteError = (code: string) => errorText({ invalid_body: "invite_email", too_many: "invite_too_many", email_not_configured: "invite_email_off" }[code] ?? code);

export function InviteSheet() {
  const app = useApp();
  const main = app.domains.filter((d) => d.type === "main");
  const shared = app.domains.filter((d) => d.type === "shared");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
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
    if (busy.current || address !== null) return;
    const e = email.trim();
    if (!EMAIL.test(e)) return setError("invite_email");
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await api<InviteResult>("POST", "/api/users/invite", { email: e, role, domainIds: role === "owner" ? [] : picked });
      app.reloadUsers().catch(() => undefined);
      if (res.emailed) {
        app.close();
        app.announce(`Invited ${e}`);
      } else {
        setWhy(notSent(res.emailReason));
        setAddress(`https://${mail?.dashboardHost ?? location.host}/`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "internal"); // the typed values stay in the form
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
              <Seg label="Role" options={ROLES} value={role} onChange={setRole} />
            </div>
            {role === "member" && (
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
            <p className="hint">They get an email with a link to sign in. They sign in with their email, and can add a passkey and their own private domains.</p>
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
