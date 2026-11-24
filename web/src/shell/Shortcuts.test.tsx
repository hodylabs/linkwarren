import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me } from "../api";
import { ANALYTICS_KEYS } from "../analytics/AnalyticsScreen";
import { CHART_KEYS } from "../analytics/ClicksChart";
import { ADD_DOMAIN_KEYS } from "../domains/AddDomainSheet";
import { DOMAIN_DETAIL_KEYS } from "../domains/DomainDetail";
import { DOMAINS_KEYS } from "../domains/DomainsScreen";
import { keyLabels } from "../keys";
import { BULK_KEYS } from "../links/BulkBar";
import { BULK_SHEET_KEYS } from "../links/BulkSheet";
import { LINKS_KEYS } from "../links/LinksScreen";
import { NEW_LINK_KEYS } from "../links/NewLinkSheet";
import { PEOPLE_KEYS } from "../people/PeopleScreen";
import { fakeApi } from "../test/fakeApi";
import { GLOBAL_KEYS, groupsFor } from "./Shortcuts";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
afterEach(() => vi.unstubAllGlobals());

async function openSheet(me: Me = owner) {
  history.replaceState(null, "", "/links");
  fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [], next: null } }),
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Links" });
  await user.keyboard("?");
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
}

const sheetRows = (dlg: HTMLElement, title: string) => {
  const sec = within(dlg).getByText(title, { selector: ".p-sec" }).closest("section")!;
  return [...sec.querySelectorAll(".sc-row")].map((r) => `${[...r.querySelectorAll("kbd")].map((k) => k.textContent).join(" ")} = ${r.firstElementChild!.textContent}`);
};
const expected = (map: Record<string, string>) => Object.entries(map).map(([k, v]) => `${keyLabels(k).join(" ")} = ${v}`);

describe("Shortcuts sheet", () => {
  it("lists every bound key of every keymap under its screen (the maps are what useHotkeys binds)", async () => {
    const dlg = await openSheet();
    expect(sheetRows(dlg, "Everywhere")).toEqual(expect.arrayContaining(expected(GLOBAL_KEYS)));
    expect(sheetRows(dlg, "Links")).toEqual(expect.arrayContaining(expected(LINKS_KEYS)));
    expect(sheetRows(dlg, "Selected links")).toEqual([...expected(BULK_KEYS), ...expected(BULK_SHEET_KEYS)]);
    expect(sheetRows(dlg, "New link")).toEqual(expected(NEW_LINK_KEYS));
    expect(sheetRows(dlg, "Domains")).toEqual(expect.arrayContaining([...expected(DOMAINS_KEYS), ...expected(DOMAIN_DETAIL_KEYS), ...expected(ADD_DOMAIN_KEYS)]));
    expect(sheetRows(dlg, "People")).toEqual(expect.arrayContaining(expected(PEOPLE_KEYS)));
    expect(sheetRows(dlg, "Analytics")).toEqual(expect.arrayContaining([...expected(ANALYTICS_KEYS), ...expected(CHART_KEYS)]));
    expect(sheetRows(dlg, "Analytics")).toEqual(expect.arrayContaining(["← = Previous bar of the focused chart", "Home = First bar", "Esc = Hide the bar details"]));
  });

  it("matches what the screens really do: N adds a domain, A approves, no setup step or domain switch on S", async () => {
    const dlg = await openSheet();
    const domains = sheetRows(dlg, "Domains");
    expect(domains).toContain("N = Add a domain");
    expect(domains).toContain("A = Approve or enable the selected domain");
    expect(domains).toContain("Shift D = Disable the selected domain");
    expect(dlg.textContent).not.toContain("Open the first setup step");
    expect(sheetRows(dlg, "New link")).toEqual(
      expect.arrayContaining(["T = Campaign tags", "S = Schedule and expiry", "Alt D = Change the domain", "Ctrl Enter = Create the link, or save the edit", "Ctrl Shift Enter = Create and copy the short link"]),
    );
    expect(sheetRows(dlg, "Everywhere")).toEqual(expect.arrayContaining(["G L = Go to Links", "G P = Go to People & audit log"]));
    expect(sheetRows(dlg, "In search and go (Ctrl K)")).toEqual(expect.arrayContaining(["S D = Switch domain", "C D = Add a domain", "C L = New link"]));
  });

  it("every group in the table renders (app mode)", async () => {
    const dlg = await openSheet({ ...owner, authMode: "app", passkeys: 0 });
    await waitFor(() => expect(within(dlg).getAllByText(/./, { selector: ".p-sec" }).map((e) => e.textContent)).toEqual(groupsFor({ ...owner, authMode: "app" }).map((g) => g.title)));
  });

  it("access mode lists no account keys and no ys palette entry; app mode does", async () => {
    const dlg = await openSheet({ ...owner, authMode: "access" });
    expect(within(dlg).queryByText("Sign-in and security", { selector: ".p-sec" })).toBeNull();
    expect(sheetRows(dlg, "In search and go (Ctrl K)").join("\n")).not.toContain("Sign-in and security");
  });
  it("app mode shows the account group and the ys row", async () => {
    const dlg = await openSheet({ ...owner, authMode: "app", passkeys: 0 });
    expect(sheetRows(dlg, "In search and go (Ctrl K)")).toContain("Y S = Sign-in and security");
    expect(within(dlg).getByText("Sign-in and security", { selector: ".p-sec" })).toBeTruthy();
  });
});

describe("Shortcuts sheet follows the role", () => {
  const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE };
  const titles = (dlg: HTMLElement) => within(dlg).getAllByText(/./, { selector: ".p-sec" }).map((e) => e.textContent);

  it("a Member sees today's member sheet: no People or Settings, but links, bulk, domains and keys", async () => {
    const dlg = await openSheet(member);
    expect(titles(dlg)).toEqual(["Everywhere", "In search and go (Ctrl K)", "Links", "Selected links", "New link", "Domains", "Analytics", "API & agents", "New API key"]);
    expect(sheetRows(dlg, "Everywhere")).not.toContain("G P = Go to People & audit log");
    expect(sheetRows(dlg, "Domains")).toContain("N = Add a domain");
    expect(sheetRows(dlg, "Domains").join("\n")).not.toContain("Approve");
  });

  it("a role without create, bulk, domains, keys or agents lists none of their keys", async () => {
    const dlg = await openSheet({ ...member, ...customRole(["settings"]) });
    expect(titles(dlg)).toEqual(["Everywhere", "In search and go (Ctrl K)", "Links", "Domains", "Analytics", "API & agents", "Settings"]);
    const links = sheetRows(dlg, "Links");
    expect(links).not.toContain("N = New link");
    expect(links).not.toContain("X = Select or unselect the link");
    expect(links).not.toContain("E = Edit the selected link");
    expect(links).not.toContain("Shift D = Delete the selected link");
    expect(sheetRows(dlg, "Domains")).not.toContain("N = Add a domain");
    expect(sheetRows(dlg, "API & agents")).not.toContain("N = New API key");
    expect(sheetRows(dlg, "API & agents")).not.toContain("C = Copy the agent address");
    expect(sheetRows(dlg, "Settings")).not.toContain("C = Check the Cloudflare token");
    expect(sheetRows(dlg, "Settings")).not.toContain("Esc = Cancel the running export"); // needs data
    const palette = sheetRows(dlg, "In search and go (Ctrl K)");
    expect(palette).toContain("G S = Settings");
    for (const r of ["C L = New link", "C D = Add a domain", "C K = New API key", "C P = Invite a person", "G P = People & audit log"]) expect(palette).not.toContain(r);
  });
});
