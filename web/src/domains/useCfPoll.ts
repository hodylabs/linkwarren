import { useEffect, useState } from "react";
import { api, ApiError, type CfView } from "../api";

const POLL_MS = 5000;

/** Nothing more to wait for: manual domains, an account domain that only the owner's approval changes, or every check green. */
export function cfSettled(v: CfView): boolean {
  if (v.kind === "manual") return true;
  if (v.lastError) return false; // "Retrying"
  if (v.attachOnApproval) return true;
  return v.dns === "found" && v.ownership === "verified" && (v.kind === "account" || v.certificate === "issued");
}

/**
 * Polls GET /api/domains/:id/cloudflare every 5 s while `enabled` and the tab is visible. One request at a time (the next
 * waits for the answer), aborted on unmount or id change, stopped once the view is settled or on a 4xx (gone, forbidden, signed out).
 */
export function useCfPoll(domainId: string | null, enabled: boolean): { view: CfView | null; error: string | null } {
  const [got, setGot] = useState<{ id: string; view: CfView | null; error: string | null } | null>(null);
  const mine = got && got.id === domainId ? got : null;
  const on = domainId !== null && enabled && !(mine?.view && cfSettled(mine.view));

  useEffect(() => {
    const id = domainId;
    if (!on || id === null) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const schedule = () => {
      if (!busy && timer === undefined && !ctl.signal.aborted && document.visibilityState === "visible") timer = setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      timer = undefined;
      if (document.visibilityState !== "visible") return; // visibilitychange schedules again
      busy = true;
      let retry = true;
      try {
        const view = await api<CfView>("GET", `/api/domains/${encodeURIComponent(id)}/cloudflare`, undefined, ctl.signal);
        setGot({ id, view, error: null });
      } catch (e) {
        if (ctl.signal.aborted) return;
        const status = e instanceof ApiError ? e.status : 500;
        retry = status >= 500;
        setGot((g) => ({ id, view: g?.id === id ? g.view : null, error: e instanceof ApiError ? e.code : "internal" }));
      } finally {
        busy = false;
      }
      if (retry) schedule();
    };
    const onVisible = () => schedule();
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      ctl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [domainId, on]);

  return { view: mine?.view ?? null, error: mine?.error ?? null };
}
