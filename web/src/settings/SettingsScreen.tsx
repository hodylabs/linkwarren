import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../api";
import { navigate, NavLink, useRoute } from "../router";
import { ScreenHeader } from "../shell/ui";
import { useApp } from "../state";
import { hasUnsaved, UNSAVED } from "../unsaved";
import { getSettings, type SettingsBody } from "./api";
import { CloudflareSection } from "./CloudflareSection";
import { SECTIONS, settingsError, type SectionId } from "./copy";
import { BackupsSection, DataSection, EmailSection, InstanceSection, LinkDefaultsSection, SignInSection } from "./sections";

const STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** Needs the settings permission (App renders "Not in your role" before this mounts); secrets stay owner only. Each section is its own URL, /settings/<section> (R15). */
export function SettingsScreen() {
  const { sub } = useRoute();
  const section = SECTIONS.find((x) => x.id === sub)?.id;
  useEffect(() => {
    if (!section) navigate("/settings/instance", { replace: true });
  }, [section]);

  const [s, setS] = useState<SettingsBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    getSettings(ac.signal).then(setS, (e: unknown) => !ac.signal.aborted && setError(e instanceof ApiError ? e.code : "internal"));
    return () => ac.abort();
  }, [tries]);

  const app = useApp();
  const nav = useRef<HTMLElement>(null);
  // Arrow keys move between sections like a tab list: each step replaces the history entry, so Back leaves Settings
  // instead of walking back through every section passed. A click or Enter on a section link is a normal navigation.
  // A section holding an unsaved edit keeps it: the switch waits until it is saved or discarded.
  const onNavKey = (e: KeyboardEvent) => {
    const step = STEP[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (hasUnsaved()) return app.announce(UNSAVED);
    // From the focused link (Tab may have moved past the open section), else from the open section.
    const links = [...(nav.current?.querySelectorAll("a") ?? [])];
    const from = links.indexOf(document.activeElement as HTMLAnchorElement);
    const i = ((from >= 0 ? from : SECTIONS.findIndex((x) => x.id === section)) + step + SECTIONS.length) % SECTIONS.length;
    navigate(`/settings/${SECTIONS[i]!.id}`, { replace: true });
    links[i]?.focus();
  };

  const body = (id: SectionId, v: SettingsBody) => {
    const onSecrets = (secrets: SettingsBody["secrets"]) => setS((cur) => cur && { ...cur, secrets });
    if (id === "instance") return <InstanceSection key={id} s={v} onSaved={setS} />;
    if (id === "sign-in") return <SignInSection s={v} />;
    if (id === "cloudflare") return <CloudflareSection secrets={v.secrets} onSecrets={onSecrets} />;
    if (id === "email") return <EmailSection s={v} onSecrets={onSecrets} />;
    if (id === "link-defaults") return <LinkDefaultsSection key={id} s={v} onSaved={setS} />;
    if (id === "data") return <DataSection s={v} />;
    return <BackupsSection />;
  };

  return (
    <>
      <ScreenHeader title="Settings" text="This instance, for everyone on it" />
      <div className="setwrap">
        <nav className="subnav" aria-label="Settings sections" ref={nav} onKeyDown={onNavKey}>
          {SECTIONS.map((x) => (
            <NavLink key={x.id} to={`/settings/${x.id}`} aria-current={x.id === section ? "page" : undefined}
              onClick={(e) => x.id !== section && hasUnsaved() && (e.preventDefault(), app.announce(UNSAVED))}>
              {x.label}
            </NavLink>
          ))}
        </nav>
        <div className="setmain">
          {!section ? null : error ? (
            <p className="err" role="alert">
              {settingsError(error)}
              <button type="button" className="btn" onClick={() => setTries((n) => n + 1)}>Retry</button>
            </p>
          ) : !s ? (
            <p className="muted" role="status">Loading</p>
          ) : (
            body(section, s)
          )}
        </div>
      </div>
    </>
  );
}
