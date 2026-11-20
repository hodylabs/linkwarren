import { useRoute, type Screen } from "./router";
import { ComingSoon } from "./shell/ComingSoon";
import { Gate } from "./shell/Gate";
import { Rail, SCREEN_TITLES } from "./shell/Rail";
import { AppProvider, useApp } from "./state";
import { errorText } from "./copy";

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
  // Links, Domains and People arrive in their own tasks; until then the header alone.
  return (
    <header className="top">
      <h1>{SCREEN_TITLES[screen]}</h1>
    </header>
  );
}

function Shell() {
  const { signedOut } = useApp();
  const { screen } = useRoute();
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
        <ScreenView screen={screen} />
      </main>
    </div>
  );
}

export default function App() {
  return <Gate>{(me) => <AppProvider me={me}><Shell /></AppProvider>}</Gate>;
}
