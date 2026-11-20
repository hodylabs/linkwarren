import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "../api";
import { errorText } from "../copy";

type GateState = { me: Me } | { error: string } | null;

/** Loads /api/me and renders the app only for a signed-in, invited, enabled user. */
export function Gate({ children }: { children: (me: Me) => ReactNode }) {
  const [state, setState] = useState<GateState>(null);
  useEffect(() => {
    const ac = new AbortController();
    api<Me>("GET", "/api/me", undefined, ac.signal).then(
      (me) => setState({ me }),
      (e) => {
        if (ac.signal.aborted) return;
        // 401 and network both mean the Access session is gone.
        const code = e instanceof ApiError ? (e.status === 401 ? "network" : e.code) : "internal";
        setState({ error: errorText(code) });
      },
    );
    return () => ac.abort();
  }, []);
  if (state === null) return null;
  if ("error" in state)
    return (
      <div className="gate" role="alert">
        <img src="/linkwarren-mark.svg" alt="" />
        <p>{state.error}</p>
      </div>
    );
  return <>{children(state.me)}</>;
}
