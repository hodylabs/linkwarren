import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { errorText } from "../copy";
import { NavLink, useRoute, type Screen } from "../router";
import { logoUrl } from "../settings/api";
import { canSee, isOwner } from "../perms";
import { useApp } from "../state";
import { PHONE, useMedia } from "./narrow";
import { Sheet } from "./Sheet";
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
    <NavLink to={`/${screen}`} aria-current={screen === current ? "page" : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {ICONS[screen]}
      </svg>
      {SCREEN_TITLES[screen]}
      <span className="k" aria-hidden="true">
        {KEYS[screen]}
      </span>
    </NavLink>
  );
}

export function Rail() {
  const { me, domains, currentDomainId, open, close, overlay, instance } = useApp();
  const name = instance?.name || "linkwarren";
  useEffect(() => {
    document.title = name; // R8: the instance name, as in the rail
  }, [name]);
  const { screen } = useRoute();
  const phone = useMedia(PHONE);
  const menuOpen = overlay?.kind === "menu";
  // The drawer only exists on phones: widening the window with it open closes it.
  useEffect(() => {
    if (!phone && menuOpen) close();
  }, [phone, menuOpen, close]);
  const current = domains.find((d) => d.id === currentDomainId);
  const admin = canSee(me, "people") || canSee(me, "settings");
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
  const navBody = (
    <>
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
      <div className="me">
        <span className="avatar" aria-hidden="true">
          {initials(me.name, me.email)}
        </span>
        <div>
          {me.roleName}
          <br />
          {appMode ? (
            <>
              <small>Signed in to linkwarren</small>
              <br />
              <button type="button" className="linkbtn" onClick={() => open({ kind: "account" })}>Sign-in and security</button>
              <br />
              <button type="button" className="linkbtn" onClick={() => void signOut()}>Sign out</button>
              {signOutError && <small className="err" role="alert">{signOutError}</small>}
            </>
          ) : (
            <>
              <small>Signed in with Cloudflare Access</small>
              <br />
              <a href="/cdn-cgi/access/logout">Sign out</a>
            </>
          )}
        </div>
      </div>
      <div className="ver">
        Dashboard v{__APP_VERSION__}
        {instance?.update && (
          <a href={instance.update.url} target="_blank" rel="noopener noreferrer">v{instance.update.latest} available</a>
        )}
      </div>
    </>
  );
  return (
    <aside className="rail" aria-label="Main">
      <NavLink to="/links" className="brand" aria-label={`${name} home`}>
        <img src={logoUrl(instance?.logoVersion ?? null)} alt="" />
        <span aria-hidden="true">{name}</span>
      </NavLink>
      <button type="button" className="switch" aria-label={`Switch domain, current ${current?.host ?? "All domains"}`} onClick={() => open({ kind: "switcher" })}>
        <span className="dot" />
        <b>{current?.host ?? "All domains"}</b>
        {current && <small>{TYPE_LABEL[current.type]}</small>}
      </button>
      {!phone && navBody}
      {phone && (
        <button type="button" className="menu-btn" aria-label="Menu" aria-expanded={menuOpen} aria-controls="nav-drawer" onClick={() => open({ kind: "menu" })}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      )}
      {phone && menuOpen && (
        <Sheet label="Menu" onClose={close} cls="drawer">
          {/* Picking a screen (even the current one) closes the drawer. */}
          <div id="nav-drawer" className="drawer-in" onClick={(e) => (e.target as Element).closest("a[href]") && close()}>
            {navBody}
          </div>
        </Sheet>
      )}
    </aside>
  );
}
