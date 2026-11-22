import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, onSignedOut, type Domain, type Me, type UserItem } from "./api";
import { errorText } from "./copy";

export type Overlay =
  | { kind: "palette" }
  | { kind: "switcher" }
  | { kind: "shortcuts" }
  | { kind: "newLink"; slug?: string }
  | { kind: "addDomain" }
  | { kind: "account" }
  | { kind: "newKey" }
  | { kind: "invite" }
  | { kind: "person"; id: string }
  | { kind: "menu" }; // the phone nav drawer

export type AppState = {
  me: Me;
  domains: Domain[];
  /** Owner only; null for members and until loaded. */
  users: UserItem[] | null;
  /** null = every domain the user can see. */
  currentDomainId: string | null;
  setCurrentDomain(id: string | null): void;
  reloadDomains(): Promise<void>;
  reloadUsers(): Promise<void>;
  linksVersion: number;
  bumpLinks(): void;
  overlay: Overlay | null;
  open(o: Overlay): void;
  close(): void;
  announce(msg: string): void;
  signedOut: boolean;
  /** Set when the first load of domains or users failed (not a sign-out); the shell shows it with a retry. */
  loadError: string | null;
  retryLoad(): void;
};

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

const DOMAIN_KEY = "lw.domain";
// Storage can be blocked (private mode, policy): the choice then lasts for this page only.
function readDomain(): string | null {
  try {
    return localStorage.getItem(DOMAIN_KEY);
  } catch {
    return null;
  }
}
function writeDomain(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(DOMAIN_KEY);
    else localStorage.setItem(DOMAIN_KEY, id);
  } catch {
    /* see readDomain */
  }
}

/** Shell state for every screen. Also renders the aria-live region that `announce` writes to. */
export function AppProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [users, setUsers] = useState<UserItem[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(readDomain);
  const [linksVersion, setLinksVersion] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => onSignedOut(() => setSignedOut(true)), []);

  // Failures reject so callers decide; signed-out ones have already raised the banner through onSignedOut.
  // An answer is stored unless a newer request already stored one, so a stale answer never overwrites a
  // fresh one, and a newer request that fails does not throw away an older answer that succeeded.
  const domainsGen = useRef({ sent: 0, stored: 0 });
  const usersGen = useRef({ sent: 0, stored: 0 });
  const reloadDomains = useCallback(async () => {
    const gen = domainsGen.current;
    const g = ++gen.sent;
    const list = await api<Domain[]>("GET", "/api/domains");
    if (g > gen.stored) { gen.stored = g; setDomains(list); }
  }, []);
  const reloadUsers = useCallback(async () => {
    if (me.role !== "owner") return;
    const gen = usersGen.current;
    const g = ++gen.sent;
    const { items } = await api<{ items: UserItem[] }>("GET", "/api/users");
    if (g > gen.stored) { gen.stored = g; setUsers(items); }
  }, [me.role]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    setLoadError(null);
    Promise.all([reloadDomains(), reloadUsers()]).catch((e: unknown) => {
      const signedOutError = e instanceof ApiError && (e.code === "network" || e.status === 401);
      if (!signedOutError) setLoadError(errorText(e instanceof ApiError ? e.code : "internal"));
    });
  }, [reloadDomains, reloadUsers, loadTry]);

  const setCurrentDomain = useCallback((id: string | null) => {
    writeDomain(id);
    setChosen(id);
  }, []);

  // A remembered domain that is gone (deleted, access removed) means all domains. While the list loads the choice is kept;
  // if loading failed there is no list to trust, so it is all domains (the Rail shows the same).
  const currentDomainId = domains === null ? (loadError === null ? chosen : null) : domains.some((d) => d.id === chosen) ? chosen : null;

  const value = useMemo<AppState>(
    () => ({
      me,
      domains: domains ?? [],
      users,
      currentDomainId,
      setCurrentDomain,
      reloadDomains,
      reloadUsers,
      linksVersion,
      bumpLinks: () => setLinksVersion((v) => v + 1),
      overlay,
      open: setOverlay,
      close: () => setOverlay(null),
      announce: (text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })),
      signedOut,
      loadError,
      retryLoad: () => setLoadTry((n) => n + 1),
    }),
    [me, domains, users, currentDomainId, setCurrentDomain, reloadDomains, reloadUsers, linksVersion, overlay, signedOut, loadError],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      {/* Keyed span: a repeated message is a new node, so screen readers announce it again. */}
      <div className="sr-only" aria-live="polite">
        <span key={announcement.n}>{announcement.text}</span>
      </div>
    </AppContext.Provider>
  );
}
