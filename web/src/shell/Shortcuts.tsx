import { useApp } from "../state";
import { keyLabels } from "../keys";
import type { Screen } from "../router";
import { ADD_DOMAIN_KEYS } from "../domains/AddDomainSheet";
import { DOMAIN_DETAIL_KEYS } from "../domains/DomainDetail";
import { DOMAINS_KEYS } from "../domains/DomainsScreen";
import { LINKS_KEYS } from "../links/LinksScreen";
import { NEW_LINK_KEYS } from "../links/NewLinkSheet";
import { PEOPLE_KEYS } from "../people/PeopleScreen";
import { buildCommands } from "./palette";
import { OWNER_ONLY, SCREEN_TITLES } from "./Rail";
import { Kbd } from "./ui";
import { Sheet } from "./Sheet";

/** Shell hotkeys (bound in App) and their text here. */
export const GLOBAL_KEYS = { "mod+k": "Search and go", "?": "All keyboard shortcuts" } as const;

/** "G then letter" chords (bound in App). */
export const GO_KEYS = { l: "links", d: "domains", a: "analytics", p: "people", i: "agents", s: "settings" } as const satisfies Record<string, Screen>;

type Row = [string[], string];
const rows = (map: Record<string, string>): Row[] => Object.entries(map).map(([k, what]) => [keyLabels(k), what]);

// Rows below that are not from a keymap are handled by onKeyDown in the component named next to them.
const SAVE_REVERT: Row[] = [
  [["Ctrl", "Enter"], "Save the panel you are in"], // LinkDetail, DomainDetail, MembersEditor
  [["Esc"], "Revert unsaved edits in the panel you are in"],
];
const OPEN_ROW: Row = [["Enter"], "Select the focused row"]; // row onKeyDown in each list

const owner = (s: Screen) => (OWNER_ONLY.has(s) ? " (owner)" : "");
// Palette letter commands come from the palette itself; switching domains needs real domains, so it is one row.
const paletteCmds = buildCommands({ domains: [], open: () => undefined, setCurrentDomain: () => undefined }, true);

export const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Everywhere",
    rows: [
      ...rows(GLOBAL_KEYS),
      [["Esc"], "Close the open panel"], // Sheet
      ...Object.entries(GO_KEYS).map(([k, s]): Row => [["G", k.toUpperCase()], `Go to ${SCREEN_TITLES[s]}${owner(s)}`]),
    ],
  },
  {
    title: "In search and go (Ctrl K)",
    rows: [
      ...paletteCmds.map((c): Row => {
        const to = c.section === "Go to" ? GO_KEYS[c.keys[1] as keyof typeof GO_KEYS] : undefined;
        return [keyLabels(c.keys), c.label + (to ? owner(to) : "")];
      }),
      [["G", "1 to 9"], "Switch to one of the first nine domains"],
      [["↑", "↓"], "Move"], // Palette onKeyDown
      [["Enter"], "Open"],
      [["Backspace"], "Back a letter"],
    ],
  },
  { title: "Links", rows: [...rows(LINKS_KEYS), OPEN_ROW, ...SAVE_REVERT] },
  { title: "New link", rows: rows(NEW_LINK_KEYS) },
  { title: "Domains", rows: [...rows(DOMAINS_KEYS), ...rows(DOMAIN_DETAIL_KEYS), OPEN_ROW, ...SAVE_REVERT, ...rows(ADD_DOMAIN_KEYS)] },
  { title: "People", rows: [...rows(PEOPLE_KEYS), OPEN_ROW] },
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
            {g.rows.map(([keys, what], i) => (
              <div key={i} className="sc-row">
                <span>{what}</span>
                <span className="keys">{keys.map((k, j) => <Kbd key={j}>{k}</Kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
