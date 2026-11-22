import { useApp } from "../state";
import { keyLabels } from "../keys";
import type { Screen } from "../router";
import { ACCOUNT_KEYS } from "../account/AccountPanel";
import { AGENT_DETAIL_KEYS, AGENTS_KEYS } from "../agents/AgentsScreen";
import { NEW_KEY_KEYS } from "../agents/NewKeySheet";
import { ANALYTICS_KEYS } from "../analytics/AnalyticsScreen";
import { CHART_KEYS } from "../analytics/ClicksChart";
import { ADD_DOMAIN_KEYS } from "../domains/AddDomainSheet";
import { DOMAIN_DETAIL_KEYS } from "../domains/DomainDetail";
import { DOMAINS_KEYS } from "../domains/DomainsScreen";
import { BULK_KEYS } from "../links/BulkBar";
import { BULK_SHEET_KEYS } from "../links/BulkSheet";
import { LINKS_KEYS } from "../links/LinksScreen";
import { NEW_LINK_KEYS } from "../links/NewLinkSheet";
import { INVITE_KEYS } from "../people/InviteSheet";
import { PEOPLE_KEYS } from "../people/PeopleScreen";
import { PERSON_KEYS } from "../people/PersonSheet";
import { SETTINGS_KEYS } from "../settings/CloudflareSection";
import { EXPORT_KEYS } from "../settings/sections";
import type { Me } from "../api";
import { can, canSee, isOwner, type Perm } from "../perms";
import { buildCommands } from "./palette";
import { SCREEN_TITLES } from "./Rail";
import { Kbd } from "./ui";
import { Sheet } from "./Sheet";

/** Shell hotkeys (bound in App) and their text here. */
export const GLOBAL_KEYS = { "mod+k": "Search and go", "?": "All keyboard shortcuts" } as const;

/** "G then letter" chords (bound in App). */
export const GO_KEYS = { l: "links", d: "domains", a: "analytics", p: "people", i: "agents", s: "settings" } as const satisfies Record<string, Screen>;

type Need = (me: Me) => boolean;
/** Keys, text, and the role it needs (none: everyone). */
type Row = [string[], string, Need?];
const any = (...ps: Perm[]): Need => (me) => ps.some((p) => can(me, p));
const owner: Need = isOwner;
const rows = <M extends Record<string, string>>(map: M, needs: Partial<Record<keyof M, Need>> = {}): Row[] =>
  Object.entries(map).map(([k, what]) => [keyLabels(k), what, needs[k as keyof M]]);

// Rows below that are not from a keymap are handled by onKeyDown in the component named next to them.
const SAVE_REVERT: Row[] = [
  [["Ctrl", "Enter"], "Save the panel you are in"], // LinkDetail, DomainDetail, MembersEditor
  [["Esc"], "Revert unsaved edits in the panel you are in"],
];
const OPEN_ROW: Row = [["Enter"], "Select the focused row"]; // row onKeyDown in each list
const bulk = any("links.bulk");

/** Every group with every row; `need` on a group or row hides it from a role that cannot use it (S8: hidden, not just greyed). */
const GROUPS: { title: string; rows: Row[]; need?: Need }[] = [
  {
    title: "Everywhere",
    rows: [
      ...rows(GLOBAL_KEYS),
      [["Esc"], "Close the open panel"], // Sheet
      ...Object.entries(GO_KEYS).map(([k, s]): Row => [["G", k.toUpperCase()], `Go to ${SCREEN_TITLES[s]}`, (me) => canSee(me, s)]),
    ],
  },
  // "In search and go" rows come from the palette's own commands for the role (groupsFor).
  { title: "In search and go (Ctrl K)", rows: [] },
  { title: "Links", rows: [...rows(LINKS_KEYS, { n: any("links.create"), x: bulk, "shift+j": bulk, "shift+k": bulk, "mod+a": bulk }), OPEN_ROW, ...SAVE_REVERT] },
  { title: "Selected links", rows: [...rows(BULK_KEYS), ...rows(BULK_SHEET_KEYS)], need: bulk },
  { title: "New link", rows: rows(NEW_LINK_KEYS), need: any("links.create") },
  {
    title: "Domains",
    rows: [
      ...rows(DOMAINS_KEYS, { n: any("domains.own", "domains.manage") }),
      ...rows(DOMAIN_DETAIL_KEYS, { a: any("domains.manage"), f: any("domains.manage"), "shift+r": any("domains.manage"), "shift+d": any("domains.manage") }),
      OPEN_ROW,
      ...SAVE_REVERT,
      ...rows(ADD_DOMAIN_KEYS, { "mod+enter": any("domains.own", "domains.manage"), "mod+shift+enter": any("domains.manage"), f: any("domains.manage") }),
    ],
  },
  {
    title: "People",
    need: (me) => canSee(me, "people"),
    rows: [
      ...rows(PEOPLE_KEYS, { n: any("people.manage") }),
      [["Enter"], "Open the focused person", any("people.manage")],
      ...rows(PERSON_KEYS, Object.fromEntries(Object.keys(PERSON_KEYS).map((k) => [k, any("people.manage")]))),
      [["Enter"], "Confirm", any("people.manage")],
      ...rows(INVITE_KEYS, Object.fromEntries(Object.keys(INVITE_KEYS).map((k) => [k, any("people.manage")]))),
    ],
  },
  {
    title: "Analytics",
    rows: [
      ...rows(ANALYTICS_KEYS),
      [["←", "→"], "Change the date range"], // Seg onKeyDown
      [["↑", "↓"], "Move in the domain list"], // DomainPicker onKeyDown
      [["Space"], "Pick or unpick a domain"],
      [["Esc"], "Close the domain list"],
      ...rows(CHART_KEYS),
    ],
  },
  {
    title: "API & agents",
    rows: [
      ...rows(AGENTS_KEYS, { n: any("keys"), c: any("agents") }),
      ...rows(AGENT_DETAIL_KEYS),
      OPEN_ROW,
      [["←", "→"], "Pick an agent to see how to connect it", any("agents")], // AgentsScreen chip onKeyDown
      [["Enter"], "Confirm"], // confirm sheets
    ],
  },
  { title: "New API key", rows: rows(NEW_KEY_KEYS), need: any("keys") },
  {
    title: "Settings",
    need: any("settings"),
    rows: [
      [["↑", "↓"], "Previous or next section"], // SettingsScreen nav onKeyDown
      [["Ctrl", "Enter"], "Save the section you are in"], // useEdit and SecretField onKeyDown
      [["Esc"], "Revert unsaved edits in the section"],
      ...rows(SETTINGS_KEYS, { c: owner }),
      ...rows(EXPORT_KEYS),
    ],
  },
  { title: "Sign-in and security", rows: [...rows(ACCOUNT_KEYS), [["Enter"], "Confirm"], [["Esc"], "Cancel or close"]], need: (me) => me.authMode === "app" },
];

/** The sheet for this person: only groups and rows their role can use; access mode has no account sheet (and no `ys` row). */
export function groupsFor(me: Me): { title: string; rows: Row[] }[] {
  // Palette letter commands come from the palette itself; switching domains needs real domains, so it is one row.
  const palette: Row[] = [
    ...buildCommands({ domains: [], open: () => undefined, setCurrentDomain: () => undefined }, me, me.authMode === "app").map((c): Row => [keyLabels(c.keys), c.label]),
    [["G", "1 to 9"], "Switch to one of the first nine domains"],
    [["↑", "↓"], "Move"], // Palette onKeyDown
    [["Enter"], "Open"],
    [["Backspace"], "Back a letter"],
  ];
  return GROUPS.filter((g) => !g.need || g.need(me)).map((g) => ({
    title: g.title,
    rows: (g.title.startsWith("In search") ? palette : g.rows).filter(([, , need]) => !need || need(me)),
  }));
}

export function Shortcuts() {
  const { close, me } = useApp();
  return (
    <Sheet label="Keyboard shortcuts" onClose={close}>
      <div className="sh-head">
        <h2>Keyboard shortcuts</h2>
        <span className="x"><Kbd>Esc</Kbd> close</span>
      </div>
      <div className="sh-body">
        {groupsFor(me).map((g) => (
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
