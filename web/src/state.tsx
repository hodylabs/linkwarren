import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, onSignedOut, type Domain, type Me, type UserItem } from "./api";

export type Overlay =
  | { kind: "palette" }
  | { kind: "switcher" }
  | { kind: "shortcuts" }
  | { kind: "newLink"; slug?: string }
  | { kind: "addDomain" };

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

  // Errors other than signed-out leave the previous list in place; screens report their own failures.
  const reloadDomains = useCallback(async () => {
    try {
      setDomains(await api<Domain[]>("GET", "/api/domains"));
    } catch {
      /* signed-out errors raise the banner through onSignedOut */
    }
  }, []);
  const reloadUsers = useCallback(async () => {
    if (me.role !== "owner") return;
    try {
      setUsers((await api<{ items: UserItem[] }>("GET", "/api/users")).items);
    } catch {
      /* as above */
    }
  }, [me.role]);

  useEffect(() => {
    void reloadDomains();
    void reloadUsers();
  }, [reloadDomains, reloadUsers]);

  const setCurrentDomain = useCallback((id: string | null) => {
    writeDomain(id);
    setChosen(id);
  }, []);

  // A remembered domain that is gone (deleted, access removed) means all domains; keep it while the list is loading.
  const currentDomainId = domains === null || domains.some((d) => d.id === chosen) ? chosen : null;

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
    }),
    [me, domains, users, currentDomainId, setCurrentDomain, reloadDomains, reloadUsers, linksVersion, overlay, signedOut],
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
