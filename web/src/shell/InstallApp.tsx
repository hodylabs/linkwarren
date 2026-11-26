import { useState } from "react";
import { PHONE, useMedia } from "./narrow";
import { Sheet } from "./Sheet";
import { Icon } from "./ui";
import { withBase } from "../base";
import { countVisit, markDone, promptInstall, shouldNudge, useInstall, type InstallKind } from "./install";

/** Safari can't install from a button: these are the steps, plus the one thing that differs inside the installed app. */
function IosSteps({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="Install app" onClose={onClose}>
      <div className="sh-head">
        <h2>Install linkwarren</h2>
      </div>
      <div className="sh-body">
        <ol className="install-steps">
          <li>Tap Share in Safari's toolbar.</li>
          <li>Choose Add to Home Screen.</li>
          <li>Tap Add.</li>
        </ol>
        <p className="hint">The app signs in on its own. Use a passkey or single sign-on there, because email sign-in links open in Safari.</p>
      </div>
    </Sheet>
  );
}

function useStart(kind: InstallKind, afterClose?: () => void) {
  const [steps, setSteps] = useState(false);
  const start = () => (kind === "ios" ? setSteps(true) : void promptInstall());
  const close = () => {
    setSteps(false);
    afterClose?.();
  };
  return { start, sheet: steps && <IosSteps onClose={close} /> };
}

/** The small rail button above the version box. Shown only when this browser can install and the app isn't installed. */
export function InstallButton() {
  const kind = useInstall();
  const { start, sheet } = useStart(kind);
  if (!kind) return null;
  return (
    <>
      <button type="button" className="install-btn" onClick={start}>
        <Icon name="dl" />
        Install app
      </button>
      {sheet}
    </>
  );
}

/** A one-time card at the bottom of a phone screen (see shouldNudge). Not a dialog: it never blocks the page. */
export function InstallNudge() {
  const kind = useInstall();
  const phone = useMedia(PHONE);
  const [stored, setStored] = useState(countVisit);
  // The nudge is gone once the steps close, so focus lands on the menu, where Install app stays (after the Sheet's own restore).
  const { start, sheet } = useStart(kind, () => setTimeout(() => document.querySelector<HTMLElement>(".menu-btn, .install-btn")?.focus()));
  const done = () => {
    markDone();
    setStored("done");
  };
  if (sheet) return sheet;
  if (!shouldNudge(stored, kind, phone)) return null;
  return (
    <aside className="install-nudge" aria-label="Install app">
      <img src={withBase("/icon-192.png")} alt="" />
      <span>Add linkwarren to your home screen for one-tap access.</span>
      <button
        type="button"
        className="btn primary"
        onClick={() => {
          done();
          start();
        }}
      >
        Install
      </button>
      <button type="button" className="btn ghost" onClick={done}>
        Not now
      </button>
    </aside>
  );
}
