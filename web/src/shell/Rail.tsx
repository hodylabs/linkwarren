import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { errorText } from "../copy";
import { NavLink, useRoute, type Screen } from "../router";
import { logoUrl } from "../settings/api";
import { canSee, isOwner } from "../perms";
import { useApp } from "../state";
import { useTheme, type Theme } from "../theme";
import { PHONE, useMedia } from "./narrow";
import { Sheet } from "./Sheet";
import { Icon, Seg } from "./ui";
import { withBase } from "../base";

// Paths copied from the mockup's <symbol> set.
const ICONS: Record<Screen, ReactNode> = {
  links: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  domains: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  qr: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3M21 14v7h-4M14 21v-3" />,
  analytics: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5" />
    </>
  ),
  agents: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 13h.01M15 13h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
};

export const SCREEN_TITLES: Record<Screen, string> = {
  links: "Links",
  qr: "QR codes",
  domains: "Domains",
  analytics: "Analytics",
  people: "People & audit log",
  agents: "API & agents",
  settings: "Settings",
};
const KEYS: Record<Screen, string> = { links: "G L", qr: "G Q", domains: "G D", analytics: "G A", people: "G P", agents: "G I", settings: "G S" };
const TYPE_LABEL = { main: "Main", shared: "Shared", private: "Private" } as const;

/** Two letters for the avatar: initials of the name, else the start of the email. */
export function initials(name: string | null, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (words.length ? words.slice(0, 2).map((w) => w[0]).join("") : email.slice(0, 2)).toUpperCase();
}

function Item({ screen, current }: { screen: Screen; current: Screen }) {
  return (
    <NavLink to={`/${screen}`} aria-current={screen === current ? "page" : undefined} title={SCREEN_TITLES[screen]}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {ICONS[screen]}
      </svg>
      <span className="lbl">{SCREEN_TITLES[screen]}</span>
      <span className="k" aria-hidden="true">
        {KEYS[screen]}
      </span>
    </NavLink>
  );
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** The avatar's menu: who is signed in, the theme, account security and sign out. A small sheet, so Esc and Tab work as everywhere. */
function UserMenu({ onClose }: { onClose(): void }) {
  const { me, open } = useApp();
  const [theme, setTheme] = useTheme();
  const appMode = me.authMode === "app";
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signingOut = useRef(false);
  // Reload into the sign-in screen only when the server ended the session: a failed POST leaves the cookie valid.
  const signOut = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setSignOutError(null);
    try {
      await api("POST", "/api/account/sign-out", {});
    } catch (e) {
      setSignOutError(errorText(e instanceof ApiError ? e.code : "internal"));
      signingOut.current = false;
      return;
    }
    location.assign(withBase("/"));
  };
  return (
    <Sheet label="Account menu" onClose={onClose} cls="usermenu" scrimCls="menu-scrim">
      <div className="me">
        <span className="avatar" aria-hidden="true">{initials(me.name, me.email)}</span>
        <div>
          <b>{me.name || me.email}</b>
          {me.name && <small>{me.email}</small>}
          <small>{me.roleName}</small>
        </div>
      </div>
      <div className="um-sec">
        <span className="lbl">Theme</span>
        <Seg label="Theme" options={THEMES} value={theme} onChange={setTheme} />
      </div>
      <div className="um-acts">
        <p className="hint">{appMode ? "Signed in to linkwarren" : "Signed in with Cloudflare Access"}</p>
        {appMode ? (
          <>
            <button type="button" className="btn ghost" onClick={() => open({ kind: "account" })}>Sign-in and security</button>
            <button type="button" className="btn ghost" onClick={() => void signOut()}>Sign out</button>
            {signOutError && <p className="err" role="alert">{signOutError}</p>}
          </>
        ) : (
          <a className="btn ghost" href="/cdn-cgi/access/logout">Sign out</a>
        )}
      </div>
    </Sheet>
  );
}

/** The top bar: brand, rail collapse (the menu drawer on phones), Jump to (the palette), help and the account menu. */
export function TopBar({ mini, onMini }: { mini: boolean; onMini(): void }) {
  const { me, open, close, overlay, instance } = useApp();
  const name = instance?.name || "linkwarren";
  useEffect(() => {
    document.title = name; // R8: the instance name, as in the top bar
  }, [name]);
  const phone = useMedia(PHONE);
  return (
    <header className="topbar">
      {phone && (
        <button type="button" className="btn ghost icon menu-btn" aria-label="Menu" aria-expanded={overlay?.kind === "menu"} aria-controls="nav-drawer" onClick={() => open({ kind: "menu" })}>
          <Icon name="menu" />
        </button>
      )}
      <NavLink to="/links" className="brand" aria-label={`${name} home`}>
        <img src={logoUrl(instance?.logoVersion ?? null)} alt="" />
        <span aria-hidden="true">{name}</span>
      </NavLink>
      {!phone && (
        <button type="button" className="btn ghost sm icon" aria-label="Collapse the sidebar" aria-pressed={mini} onClick={onMini}>
          <Icon name="side" />
        </button>
      )}
      <span className="grow" />
      <button type="button" className={phone ? "btn ghost icon" : "btn ghost sm"} aria-label={phone ? "Jump to" : undefined} aria-keyshortcuts="Control+K" onClick={() => open({ kind: "palette" })}>
        <Icon name="search" />
        {!phone && <>Jump to<kbd>Ctrl K</kbd></>}
      </button>
      <button type="button" className={phone ? "btn ghost icon" : "btn ghost sm icon"} aria-label="Keyboard shortcuts and help" aria-keyshortcuts="?" onClick={() => open({ kind: "shortcuts" })}>
        <Icon name="help" />
      </button>
      <button type="button" className="avatar-btn" aria-label="Account menu" aria-haspopup="dialog" aria-expanded={overlay?.kind === "userMenu"} onClick={() => open({ kind: "userMenu" })}>
        <span className="avatar" aria-hidden="true">{initials(me.name, me.email)}</span>
      </button>
      {overlay?.kind === "userMenu" && <UserMenu onClose={close} />}
    </header>
  );
}

/** The left rail: domain switcher, screens and the version box. On phones the same content lives in the menu drawer. */
export function Rail() {
  const { me, domains, currentDomainId, open, close, overlay, instance } = useApp();
  const { screen } = useRoute();
  const phone = useMedia(PHONE);
  const menuOpen = overlay?.kind === "menu";
  // The drawer only exists on phones: widening the window with it open closes it.
  useEffect(() => {
    if (!phone && menuOpen) close();
  }, [phone, menuOpen, close]);
  const current = domains.find((d) => d.id === currentDomainId);
  const admin = canSee(me, "people") || canSee(me, "settings");
  const nav = (
    <nav className="nav" aria-label="Screens">
      <Item screen="links" current={screen} />
      {canSee(me, "qr") && <Item screen="qr" current={screen} />}
      <Item screen="domains" current={screen} />
      <Item screen="analytics" current={screen} />
      {/* R9: everyone manages their own keys and agents; with People or Settings it sits in their group, as the owner's does. */}
      {!admin && <Item screen="agents" current={screen} />}
      {admin && (
        <>
          <div className="nav-sep">{isOwner(me) ? "Owner" : "Manage"}</div>
          {canSee(me, "people") && <Item screen="people" current={screen} />}
          <Item screen="agents" current={screen} />
          {canSee(me, "settings") && <Item screen="settings" current={screen} />}
        </>
      )}
    </nav>
  );
  const switcher = (
    <button type="button" className="switch" aria-label={`Switch domain, current ${current?.host ?? "All domains"}`} title={current?.host ?? "All domains"} onClick={() => open({ kind: "switcher" })}>
      <span className="dot" />
      <b>{current?.host ?? "All domains"}</b>
      {current && <small>{TYPE_LABEL[current.type]}</small>}
      <Icon name="updown" />
    </button>
  );
  const ver = (
    <div className="ver">
      <div>
        Version <b>{__APP_VERSION__}</b>
      </div>
      <div>
        Domains <b>{domains.length}</b>
      </div>
      {instance?.update && (
        <a href={instance.update.url} target="_blank" rel="noopener noreferrer">v{instance.update.latest} available</a>
      )}
    </div>
  );
  if (phone)
    return menuOpen ? (
      <Sheet label="Menu" onClose={close} cls="drawer">
        {/* Picking a screen (even the current one) closes the drawer. */}
        <div id="nav-drawer" className="drawer-in" onClick={(e) => (e.target as Element).closest("a[href]") && close()}>
          {nav}
          {switcher}
          {ver}
        </div>
      </Sheet>
    ) : null;
  return (
    <aside className="rail" aria-label="Main">
      {switcher}
      {nav}
      {ver}
    </aside>
  );
}
