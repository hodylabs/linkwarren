import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Me } from "../api";
import { errorText } from "../copy";
import { goNext } from "./next";

/** The invite page for a browser that is already signed in: say who, and let the person sign out or go on. Never the app or the wizard. */
export function JoinSignedIn({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => heading.current?.focus(), []);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/account/sign-out", {});
      onSignedOut();
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e.code : "internal"));
      setBusy(false);
    }
  };
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <img src="/linkwarren-mark.svg" alt="" />
          <span>linkwarren</span>
        </div>
        {error && <p className="signin-err" role="alert">{error}</p>}
        <h1 ref={heading} tabIndex={-1}>You are signed in as {me.email}</h1>
        <p>If this invite was sent to another address, sign out first, then open the invite again.</p>
        <form onSubmit={(e) => { e.preventDefault(); goNext("/links"); }}>
          <button type="submit" className="btn primary act" aria-keyshortcuts="Enter" disabled={busy}>
            Continue as {me.email} <span className="k">Enter</span>
          </button>
        </form>
        {me.authMode === "app" ? (
          <button type="button" className="btn ghost" onClick={signOut} disabled={busy}>Sign out</button>
        ) : (
          <a className="btn ghost" href="/cdn-cgi/access/logout">Sign out</a>
        )}
      </div>
    </main>
  );
}
