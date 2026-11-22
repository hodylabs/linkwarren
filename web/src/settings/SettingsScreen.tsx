import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../api";
import { navigate, NavLink, useRoute } from "../router";
import { ScreenHeader } from "../shell/ui";
import { getSettings, type SettingsBody } from "./api";
import { CloudflareSection } from "./CloudflareSection";
import { SECTIONS, settingsError, type SectionId } from "./copy";
import { BackupsSection, DataSection, EmailSection, InstanceSection, LinkDefaultsSection, SignInSection } from "./sections";

const STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** Owner only (App renders "Owner only" for members before this mounts). Each section is its own URL, /settings/<section> (R15). */
export function SettingsScreen() {
  const { sub } = useRoute();
  const section = SECTIONS.find((x) => x.id === sub)?.id;
  useEffect(() => {
    if (!section) navigate("/settings/instance", { replace: true });
  }, [section]);

  const [s, setS] = useState<SettingsBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    getSettings(ac.signal).then(setS, (e: unknown) => !ac.signal.aborted && setError(e instanceof ApiError ? e.code : "internal"));
    return () => ac.abort();
  }, []);

  const nav = useRef<HTMLElement>(null);
  // Arrow keys move between sections like a tab list; each move is a normal navigation, so Back returns.
  const onNavKey = (e: KeyboardEvent) => {
    const step = STEP[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const i = (SECTIONS.findIndex((x) => x.id === section) + step + SECTIONS.length) % SECTIONS.length;
    navigate(`/settings/${SECTIONS[i]!.id}`);
    nav.current?.querySelectorAll("a")[i]?.focus();
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
      <ScreenHeader title="Settings" text="Owner only" />
      <div className="setwrap">
        <nav className="subnav" aria-label="Settings sections" ref={nav} onKeyDown={onNavKey}>
          {SECTIONS.map((x) => (
            <NavLink key={x.id} to={`/settings/${x.id}`} aria-current={x.id === section ? "page" : undefined}>
              {x.label}
            </NavLink>
          ))}
        </nav>
        <div className="setmain">
          {!section ? null : error ? (
            <p className="err" role="alert">{settingsError(error)}</p>
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
