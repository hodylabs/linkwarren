import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "../api";
import { errorText } from "../copy";
import { goNext } from "../signin/next";
import { SignIn, takeToken } from "../signin/SignIn";

type GateState = { me: Me } | { error: string } | { signIn: string } | null;

const onSignInPage = () => location.pathname === "/sign-in";
/** Where to go after signing in: ?next= on /sign-in, else the page the person asked for. */
const nextHere = () => (onSignInPage() ? new URLSearchParams(location.search).get("next") ?? "/" : location.pathname + location.search);

/**
 * Loads /api/me and renders the app only for a signed-in, invited, enabled user. In app mode a 401 renders the sign-in
 * screen in place; an email link's landing (/sign-in#token=) renders it without any request.
 */
export function Gate({ children }: { children: (me: Me) => ReactNode }) {
  const [token] = useState(takeToken);
  const [state, setState] = useState<GateState>(null);
  useEffect(() => {
    if (token) return;
    const ac = new AbortController();
    api<Me>("GET", "/api/me", undefined, ac.signal).then(
      (me) => (onSignInPage() ? goNext(nextHere()) : setState({ me })),
      (e) => {
        if (ac.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401 && (e.data as { signIn?: unknown } | undefined)?.signIn === "app")
          return setState({ signIn: nextHere() });
        // 401 and network both mean the Access session is gone.
        const code = e instanceof ApiError ? (e.status === 401 ? "network" : e.code) : "internal";
        setState({ error: errorText(code) });
      },
    );
    return () => ac.abort();
  }, [token]);
  if (token) return <SignIn token={token} next="/" />;
  if (state === null) return null;
  if ("signIn" in state) return <SignIn next={state.signIn} />;
  if ("error" in state)
    return (
      <div className="gate" role="alert">
        <img src="/linkwarren-mark.svg" alt="" />
        <p>{state.error}</p>
      </div>
    );
  return <>{children(state.me)}</>;
}
