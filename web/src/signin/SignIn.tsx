import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Me } from "../api";
import { errorText } from "../copy";
import { useHotkeys } from "../keys";
import { goNext } from "./next";
import { addPasskey, passkeysSupported, signInWithPasskey } from "./passkey";

/**
 * R4: the email link's token rides in the fragment of /sign-in. Read it and drop it from the URL (and so from history,
 * screenshots and any later Referer) before anything is fetched or rendered. Call once, from a useState initializer.
 */
export function takeToken(): { token: string | null; incomplete: boolean } {
  if (location.pathname !== "/sign-in" || !location.hash) return { token: null, incomplete: false };
  const m = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  const incomplete = !m && location.hash.startsWith("#token=");
  history.replaceState(null, "", "/sign-in");
  return { token: m ? m[1]! : null, incomplete };
}

type View = "form" | "sent" | "landing" | "signedIn" | "offer";
type Done = { email: string | null; next: string; offer: boolean };

const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

/** The app-mode sign-in screen: email link, passkey, link landing and the passkey offer (R13). Centred, no rail. */
export function SignIn({ next, token, incomplete, onSpent }: { next: string; token?: string; incomplete?: boolean; onSpent?: () => void }) {
  const host = location.host;
  const [view, setView] = useState<View>(token ? "landing" : "form");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(incomplete ? errorText("link_incomplete") : null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const supported = passkeysSupported();

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : "internal"));
    } finally {
      setBusy(false);
    }
  };

  const sendLink = () => run(async () => {
    await api("POST", "/auth/email", { email: email.trim(), next });
    setView("sent");
  });
  const usePasskey = () => run(async () => goNext((await signInWithPasskey(next)).next));
  // Nothing is sent until the person presses Sign in: some mail scanners run JavaScript (R4).
  const verify = () => run(async () => {
    const t = token;
    onSpent?.(); // the token is single-use: the parent drops its copy now
    let r;
    try {
      r = await api<{ next: string }>("POST", "/auth/email/verify", { token: t });
    } catch (e) {
      setView("form");
      throw e;
    }
    // Show who this session belongs to before continuing: a planted link would sign the person in as someone else.
    // If /api/me fails the person is signed in anyway, so say that and offer Continue.
    const me = await api<Me>("GET", "/api/me").catch(() => null);
    setDone({ email: me?.email ?? null, next: r.next, offer: me?.passkeys === 0 && supported });
    setView("signedIn");
  });
  const proceed = () => (done!.offer ? setView("offer") : goNext(done!.next));
  const signOut = () => run(async () => {
    await api("POST", "/api/account/sign-out");
    setDone(null);
    setView("form");
  });
  const offerPasskey = () => run(async () => {
    await addPasskey();
    goNext(done!.next);
  });

  useHotkeys({ escape: () => (view === "sent" ? setView("form") : goNext(done?.next)) }, view === "sent" || view === "offer");

  let body: ReactNode;
  if (view === "form")
    body = (
      <>
        <h1>Sign in to {host}</h1>
        <form onSubmit={submit(sendLink)}>
          <label htmlFor="signin-email">Email</label>
          <input id="signin-email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn primary act" aria-keyshortcuts="Enter" disabled={busy}>
            Send me a sign-in link <span className="k">Enter</span>
          </button>
        </form>
        {supported && (
          <button type="button" className="btn" onClick={usePasskey} disabled={busy}>
            Use a passkey
          </button>
        )}
      </>
    );
  else if (view === "sent")
    body = (
      <>
        <h1>Check your email</h1>
        <p>If {email.trim()} can sign in here, a link is on its way. It works once, for 15 minutes.</p>
        <button type="button" className="btn" aria-keyshortcuts="Escape" onClick={() => setView("form")}>
          Use a different email <kbd>Esc</kbd>
        </button>
      </>
    );
  else if (view === "landing")
    body = (
      <>
        <h1>Sign in to {host}</h1>
        <form onSubmit={submit(verify)}>
          <button type="submit" className="btn primary act" aria-keyshortcuts="Enter" autoFocus disabled={busy}>
            Sign in <span className="k">Enter</span>
          </button>
        </form>
        <p className="muted">This link works once.</p>
      </>
    );
  else if (view === "signedIn")
    body = (
      <>
        <h1>Sign in to {host}</h1>
        <p>{done!.email ? <>Signed in as <b>{done!.email}</b></> : "You are signed in."}</p>
        <form onSubmit={submit(proceed)}>
          <button type="submit" className="btn primary act" aria-keyshortcuts="Enter" autoFocus disabled={busy}>
            Continue <span className="k">Enter</span>
          </button>
        </form>
        {done!.email && (
          <button type="button" className="btn ghost" onClick={signOut} disabled={busy}>
            Not you? Sign out
          </button>
        )}
      </>
    );
  else
    body = (
      <>
        <h1>Add a passkey</h1>
        <p>You are signed in. Add a passkey to sign in with one tap next time.</p>
        <form onSubmit={submit(offerPasskey)}>
          <button type="submit" className="btn primary act" aria-keyshortcuts="Enter" autoFocus disabled={busy}>
            Add a passkey <span className="k">Enter</span>
          </button>
        </form>
        <button type="button" className="btn" aria-keyshortcuts="Escape" onClick={() => goNext(done!.next)}>
          Not now <kbd>Esc</kbd>
        </button>
      </>
    );

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <img src="/linkwarren-mark.svg" alt="" />
          <span>linkwarren</span>
        </div>
        {error && <p className="signin-err" role="alert">{error}</p>}
        {body}
      </div>
    </main>
  );
}
