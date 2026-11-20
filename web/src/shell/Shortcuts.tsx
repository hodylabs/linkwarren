import { useApp } from "../state";
import { Kbd } from "./ui";
import { Sheet } from "./Sheet";

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Everywhere",
    rows: [
      [["Ctrl", "K"], "Search and go"],
      [["?"], "All keyboard shortcuts"],
      [["Esc"], "Close a panel"],
      [["G", "L"], "Go to Links"],
      [["G", "D"], "Go to Domains"],
      [["G", "A"], "Go to Analytics"],
      [["G", "P"], "Go to People & audit log (owner)"],
      [["G", "I"], "Go to API & agents (owner)"],
      [["G", "S"], "Go to Settings (owner)"],
      [["Ctrl", "K", "G", "1"], "Switch to the first domain (1 to 9)"],
    ],
  },
  {
    title: "Links",
    rows: [
      [["N"], "New link"],
      [["J"], "Next link"],
      [["K"], "Previous link"],
      [["Enter"], "Open the focused link"],
      [["E"], "Edit the selected link"],
      [["C"], "Copy the short link"],
      [["Shift", "D"], "Delete the selected link"],
      [["Ctrl", "Enter"], "Save"],
      [["Esc"], "Revert unsaved edits"],
    ],
  },
  {
    title: "Domains and people",
    rows: [
      [["A"], "Add a domain"],
      [["T"], "Open the first setup step"],
      [["S"], "Switch domain"],
      [["Ctrl", "Enter"], "Save"],
    ],
  },
];

export function Shortcuts() {
  const { close } = useApp();
  return (
    <Sheet label="Keyboard shortcuts" onClose={close}>
      <div className="sh-head">
        <h2>Keyboard shortcuts</h2>
        <span className="x"><Kbd>Esc</Kbd> close</span>
      </div>
      <div className="sh-body">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <div className="p-sec">{g.title}</div>
            {g.rows.map(([keys, what]) => (
              <div key={what} className="sc-row">
                <span>{what}</span>
                <span className="keys">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
