import type { ReactNode } from "react";
import { NavLink, useRoute, type Screen } from "../router";
import { useApp } from "../state";

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
  domains: "Domains",
  analytics: "Analytics",
  people: "People & audit log",
  agents: "API & agents",
  settings: "Settings",
};
const KEYS: Record<Screen, string> = { links: "G L", domains: "G D", analytics: "G A", people: "G P", agents: "G I", settings: "G S" };
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
  const { me, domains, currentDomainId, open } = useApp();
  const { screen } = useRoute();
  const current = domains.find((d) => d.id === currentDomainId);
  const isOwner = me.role === "owner";
  return (
    <aside className="rail" aria-label="Main">
      <div className="brand">
        <img src="/linkwarren-mark.svg" alt="" />
        <span>linkwarren</span>
      </div>
      <button type="button" className="switch" aria-label={`Switch domain, current ${current?.host ?? "All domains"}`} onClick={() => open({ kind: "switcher" })}>
        <span className="dot" />
        <b>{current?.host ?? "All domains"}</b>
        {current && <small>{TYPE_LABEL[current.type]}</small>}
      </button>
      <nav className="nav">
        <Item screen="links" current={screen} />
        <Item screen="domains" current={screen} />
        <Item screen="analytics" current={screen} />
        {isOwner && (
          <>
            <div className="nav-sep">Owner</div>
            <Item screen="people" current={screen} />
            <Item screen="agents" current={screen} />
            <Item screen="settings" current={screen} />
          </>
        )}
      </nav>
      <div className="me">
        <span className="avatar" aria-hidden="true">
          {initials(me.name, me.email)}
        </span>
        <div>
          {isOwner ? "Owner" : "Member"}
          <br />
          <small>Signed in with Cloudflare Access</small>
          <br />
          <a href="/cdn-cgi/access/logout">Sign out</a>
        </div>
      </div>
    </aside>
  );
}
