import { useChord, useHotkeys } from "./keys";
import { navigate, useRoute, type Screen } from "./router";
import { ComingSoon } from "./shell/ComingSoon";
import { Gate } from "./shell/Gate";
import { DomainSwitcher } from "./shell/DomainSwitcher";
import { Palette } from "./shell/Palette";
import { Rail, SCREEN_TITLES } from "./shell/Rail";
import { Shortcuts } from "./shell/Shortcuts";
import { AppProvider, useApp } from "./state";
import { errorText } from "./copy";
import { LinksScreen } from "./links/LinksScreen";
import { NewLinkSheet } from "./links/NewLinkSheet";

const OWNER_ONLY = new Set<Screen>(["people", "agents", "settings"]);

const SOON: Partial<Record<Screen, string>> = {
  analytics: "Clicks, countries, devices and referrers arrive in a later version.",
  agents: "Agent connections and API keys arrive in a later version.",
  settings: "Instance settings and the first-run setup arrive in a later version.",
};

function ScreenView({ screen }: { screen: Screen }) {
  const { me } = useApp();
  if (OWNER_ONLY.has(screen) && me.role !== "owner")
    return <ComingSoon title="Owner only" text="Only the owner of this linkwarren can open this page." />;
  const soon = SOON[screen];
  if (soon) return <ComingSoon title={SCREEN_TITLES[screen]} text={soon} />;
  if (screen === "links") return <LinksScreen />;
  // Domains and People arrive in their own tasks; until then the header alone.
  return (
    <header className="top">
      <h1>{SCREEN_TITLES[screen]}</h1>
    </header>
  );
}

function Shell() {
  const { signedOut, loadError, retryLoad, overlay, open, close, me } = useApp();
  const { screen } = useRoute();
  // Ctrl+K toggles the palette; any other sheet keeps it out so unsaved form input is never lost (R10).
  useHotkeys({
    "mod+k": () => (overlay === null ? open({ kind: "palette" }) : overlay.kind === "palette" ? close() : undefined),
    "?": () => (overlay === null ? open({ kind: "shortcuts" }) : undefined),
  });
  useChord((letter) => {
    const to = { l: "links", d: "domains", a: "analytics", p: "people", i: "agents", s: "settings" }[letter];
    if (!to || (OWNER_ONLY.has(to as Screen) && me.role !== "owner")) return false;
    navigate(`/${to}`);
    return true;
  }, overlay === null);
  return (
    <div className="app">
      <Rail />
      <main>
        {signedOut && (
          <div className="banner" role="alert">
            {errorText("network")}
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        )}
        {loadError && (
          <div className="banner" role="alert">
            Could not load your domains. {loadError}
            <button type="button" className="btn" onClick={retryLoad}>
              Retry
            </button>
          </div>
        )}
        <ScreenView screen={screen} />
      </main>
      {overlay?.kind === "palette" && <Palette />}
      {overlay?.kind === "switcher" && <DomainSwitcher />}
      {overlay?.kind === "shortcuts" && <Shortcuts />}
      {overlay?.kind === "newLink" && <NewLinkSheet slug={overlay.slug} />}
    </div>
  );
}

export default function App() {
  return <Gate>{(me) => <AppProvider me={me}><Shell /></AppProvider>}</Gate>;
}
