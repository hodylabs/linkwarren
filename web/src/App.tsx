import { useEffect, useState } from "react";
import { useChord, useHotkeys, type Bindings } from "./keys";
import { navigate, useRoute, type Screen } from "./router";
import { ComingSoon } from "./shell/ComingSoon";
import { Gate } from "./shell/Gate";
import { DomainSwitcher } from "./shell/DomainSwitcher";
import { Palette } from "./shell/Palette";
import { Rail } from "./shell/Rail";
import { canSee, isOwner, seesRoles } from "./perms";
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
import { QrCodesScreen } from "./qrcodes/QrCodesScreen";
import { NewLinkSheet } from "./links/NewLinkSheet";
import { InviteSheet } from "./people/InviteSheet";
import { PersonSheet } from "./people/PersonSheet";
import { PeopleScreen } from "./people/PeopleScreen";
import { SettingsScreen } from "./settings/SettingsScreen";
import { SetupWizard } from "./setup/SetupWizard";
import { withBase } from "./base";

function ScreenView({ screen }: { screen: Screen }) {
  const { me } = useApp();
  if (!canSee(me, screen)) return <ComingSoon title="Not in your role" text="Your role in this linkwarren does not include this page." />;
  if (screen === "links") return <LinksScreen />;
  if (screen === "qr") return <QrCodesScreen />;
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
    if (letter === "r") return seesRoles(me) && (navigate("/people/roles"), true); // G R: the Roles view of People (S8 R15)
    const to = Object.hasOwn(GO_KEYS, letter) ? GO_KEYS[letter as keyof typeof GO_KEYS] : undefined;
    if (!to || !canSee(me, to)) return false;
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
      {overlay?.kind === "invite" && <InviteSheet />}
      {overlay?.kind === "person" && <PersonSheet id={overlay.id} />}
    </div>
  );
}

/** R10: an owner of an instance that is not set up yet gets the first-run wizard in place of the shell; members never do. */
const SLOW_MS = 10_000;
function Root() {
  const { me, instance, reloadInstance } = useApp();
  const pending = isOwner(me) && instance === undefined;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [pending]);
  // One request, so the shell never flashes before the wizard; a hung one says so instead of a blank page.
  if (pending)
    return slow ? (
      <div className="gate" role="alert">
        <img src={withBase("/linkwarren-mark.svg")} alt="" />
        <p>Loading this linkwarren is taking longer than it should. Check your connection, then reload.</p>
        <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    ) : null;
  // An owner cannot tell set up from not set up without /api/instance, so neither the shell nor the wizard is safe to show.
  if (isOwner(me) && instance === null)
    return (
      <div className="gate" role="alert">
        <img src={withBase("/linkwarren-mark.svg")} alt="" />
        <p>Could not load this instance.</p>
        <button type="button" className="btn" onClick={() => void reloadInstance().catch(() => undefined)}>Retry</button>
      </div>
    );
  if (isOwner(me) && instance?.configured === false) return <SetupWizard />;
  return <Shell />;
}

export default function App() {
  return <Gate>{(me) => <AppProvider me={me}><Root /></AppProvider>}</Gate>;
}
