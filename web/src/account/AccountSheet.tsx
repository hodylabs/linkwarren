import { useApp } from "../state";
import { Sheet } from "../shell/Sheet";
import { Kbd } from "../shell/ui";
import { AccountPanel } from "./AccountPanel";
import { YourName } from "./YourName";

export function AccountSheet() {
  const { close } = useApp();
  return (
    <Sheet label="Sign-in and security" onClose={close}>
      <div className="sh-head">
        <h2>Sign-in and security</h2>
        <span className="x"><Kbd>Esc</Kbd> close</span>
      </div>
      <div className="sh-body">
        <YourName />
        <AccountPanel />
      </div>
    </Sheet>
  );
}
