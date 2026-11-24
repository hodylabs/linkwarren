import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Me, type SsoProviderItem } from "../api";
import { errorText, SIGNIN_ERRORS, signInErrorText } from "../copy";
import { useHotkeys } from "../keys";
import { goNext, nav } from "./next";
import { addPasskey, passkeysSupported, signInWithPasskey } from "./passkey";
import { stripBase, withBase } from "../base";

/**
 * R4: the email link's token rides in the fragment of /sign-in. Read it and drop it from the URL (and so from history,
 * screenshots and any later Referer) before anything is fetched or rendered. Call once, from a useState initializer.
 */
export function takeToken(): { token: string | null; incomplete: boolean } {
  if (stripBase(location.pathname) !== "/sign-in" || !location.hash) return { token: null, incomplete: false };
  const m = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  const incomplete = !m && location.hash.startsWith("#token=");
  history.replaceState(null, "", withBase("/sign-in"));
  return { token: m ? m[1]! : null, incomplete };
}

/** S14 R13: a failed single sign-on lands here with ?error=<code>. Only known codes show their text; anything else reads as sso_failed. */
export function ssoErrorFromUrl(): string | null {
  const raw = new URLSearchParams(location.search).get("error");
  if (raw === null) return null;
  return signInErrorText((SIGNIN_ERRORS as readonly string[]).includes(raw) ? raw : "sso_failed");
}
/** Drops ?error= from the address (other parameters such as next stay), so a reload or a shared URL does not show it again. */
function dropErrorParam() {
  const q = new URLSearchParams(location.search);
  if (!q.has("error")) return;
  q.delete("error");
  const rest = q.toString();
  history.replaceState(history.state, "", withBase(stripBase(location.pathname)) + (rest ? `?${rest}` : "") + location.hash);
}

/** Google and GitHub by name; the OIDC button carries the label the owner set. */
const buttonText = (p: SsoProviderItem) =>
  p.id === "google" ? "Continue with Google" : p.id === "github" ? "Continue with GitHub" : p.label.trim() || "Single sign-on";

type View = "form" | "sent" | "landing" | "signedIn" | "offer";
type Done = { email: string | null; next: string; offer: boolean };

const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

/** The app-mode sign-in screen: email link, passkey, link landing and the passkey offer (R13). Centred, no rail. */
export function SignIn({ next, token, incomplete, onSpent, join }: { next: string; token?: string; incomplete?: boolean; onSpent?: () => void; join?: { name: string } }) {
  const host = location.host;
  const [view, setView] = useState<View>(token ? "landing" : "form");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState(""); // the address the link went to, fixed at submit time
  const [error, setError] = useState<string | null>(() => (incomplete ? errorText("link_incomplete") : ssoErrorFromUrl()));
  const [providers, setProviders] = useState<SsoProviderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const supported = passkeysSupported();
  // The invite page opens on its heading (not the field), so a screen reader hears where it is first.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (join) heading.current?.focus(); }, [join]);
  useEffect(dropErrorParam, []);
  // Back from a provider can restore this page from the back/forward cache with busy still set: free the buttons again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setBusy(false);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  // S14: the enabled providers. The email link's landing sends nothing before Sign in (R4), so only the form asks.
  // Any failure leaves the page as it was, without single sign-on.
  useEffect(() => {
    if (token) return;
    const ac = new AbortController();
    api<{ items?: unknown }>("POST", "/auth/sso/providers", {}, ac.signal).then(
      (r) => setProviders(Array.isArray(r.items) ? (r.items as SsoProviderItem[]).filter((p) => ["google", "github", "oidc"].includes(p?.id) && typeof p.label === "string") : []),
      () => undefined,
    );
    return () => ac.abort();
  }, [token]);

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
    const to = email.trim();
    await api("POST", "/auth/email", { email: to, next });
    setSentTo(to);
    setView("sent");
  });
  // The state behind the returned URL is single use, so the page stays busy until the browser leaves.
  const startSso = async (p: SsoProviderItem) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("POST", `/auth/sso/${p.id}/start`, { next });
      if (new URL(url).protocol !== "https:") throw new ApiError(0, "sso_failed");
      nav.assign(url);
    } catch (e) {
      setError(signInErrorText(e instanceof ApiError ? e.code : "sso_failed"));
      setBusy(false);
    }
  };
  const usePasskey =() => run(async () => goNext((await signInWithPasskey(next)).next));
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
        {join ? (
          <>
            <h1 ref={heading} tabIndex={-1}>You were invited to {join.name}</h1>
            <p>Sign in with the address the invite was sent to.</p>
          </>
        ) : (
          <h1>Sign in to {host}</h1>
        )}
        {providers.length > 0 && (
          <div className="signin-sso">
            {providers.map((p) => (
              <button key={p.id} type="button" className="btn" disabled={busy} onClick={() => void startSso(p)}>
                {buttonText(p)}
              </button>
            ))}
            <p className="signin-or">or with your email</p>
          </div>
        )}
        <form onSubmit={submit(sendLink)}>
          <label htmlFor="signin-email">Email</label>
          <input id="signin-email" type="email" autoComplete="username" required autoFocus={!join} value={email} onChange={(e) => setEmail(e.target.value)} />
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
        <p>If {sentTo} can sign in here, a link is on its way. It works once, for 15 minutes.</p>
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
          <img src={withBase("/linkwarren-mark.svg")} alt="" />
          <span>linkwarren</span>
        </div>
        {error && <p className="signin-err" role="alert">{error}</p>}
        {body}
      </div>
    </main>
  );
}
