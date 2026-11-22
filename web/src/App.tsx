import { useChord, useHotkeys, type Bindings } from "./keys";
import { navigate, useRoute, type Screen } from "./router";
import { ComingSoon } from "./shell/ComingSoon";
import { Gate } from "./shell/Gate";
import { DomainSwitcher } from "./shell/DomainSwitcher";
import { Palette } from "./shell/Palette";
import { OWNER_ONLY, Rail } from "./shell/Rail";
import { useOpenSheets } from "./shell/Sheet";
import { GLOBAL_KEYS, GO_KEYS, Shortcuts } from "./shell/Shortcuts";
import { AppProvider, useApp } from "./state";
import { errorText } from "./copy";
import { AnalyticsScreen } from "./analytics/AnalyticsScreen";
import { AccountSheet } from "./account/AccountSheet";
import { AgentsScreen } from "./agents/AgentsScreen";
import { NewKeySheet } from "./agents/NewKeySheet";
import { AddDomainSheet } from "./domains/AddDomainSheet";
import { DomainsScreen } from "./domains/DomainsScreen";
import { LinksScreen } from "./links/LinksScreen";
import { NewLinkSheet } from "./links/NewLinkSheet";
import { InviteSheet } from "./people/InviteSheet";
import { PersonSheet } from "./people/PersonSheet";
import { PeopleScreen } from "./people/PeopleScreen";
import { SettingsScreen } from "./settings/SettingsScreen";

function ScreenView({ screen }: { screen: Screen }) {
  const { me } = useApp();
  if (OWNER_ONLY.has(screen) && me.role !== "owner")
    return <ComingSoon title="Owner only" text="Only the owner of this linkwarren can open this page." />;
  if (screen === "links") return <LinksScreen />;
  if (screen === "domains") return <DomainsScreen />;
  if (screen === "settings") return <SettingsScreen />;
  if (screen === "analytics") return <AnalyticsScreen />;
  if (screen === "agents") return <AgentsScreen />;
  return <PeopleScreen />;
}

function Shell() {
  const { signedOut, loadError, retryLoad, overlay, open, close, me } = useApp();
  const { screen } = useRoute();
  // Any open sheet (an overlay or a screen's inline confirm) keeps the shell keys out, so a second dialog never stacks.
  // Ctrl+K still closes a lone palette; other sheets keep it out so unsaved form input is never lost (R10).
  const sheets = useOpenSheets();
  const free = overlay === null && sheets === 0;
  useHotkeys({
    "mod+k": () => (free ? open({ kind: "palette" }) : overlay?.kind === "palette" && sheets <= 1 ? close() : undefined),
    "?": () => (free ? open({ kind: "shortcuts" }) : undefined),
  } satisfies Bindings<typeof GLOBAL_KEYS>);
  useChord((letter) => {
    const to = Object.hasOwn(GO_KEYS, letter) ? GO_KEYS[letter as keyof typeof GO_KEYS] : undefined;
    if (!to || (OWNER_ONLY.has(to) && me.role !== "owner")) return false;
    navigate(`/${to}`);
    return true;
  }, free);
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
            Could not load the dashboard data. {loadError}
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
      {overlay?.kind === "account" && <AccountSheet />}
      {overlay?.kind === "addDomain" && <AddDomainSheet />}
      {overlay?.kind === "newLink" && <NewLinkSheet slug={overlay.slug} />}
      {overlay?.kind === "newKey" && <NewKeySheet />}
      {overlay?.kind === "invite" && me.role === "owner" && <InviteSheet />}
      {overlay?.kind === "person" && me.role === "owner" && <PersonSheet id={overlay.id} />}
    </div>
  );
}

export default function App() {
  return <Gate>{(me) => <AppProvider me={me}><Shell /></AppProvider>}</Gate>;
}
