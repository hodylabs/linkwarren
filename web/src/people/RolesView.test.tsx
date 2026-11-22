import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me, RoleItem } from "../api";
import { buildCommands } from "../shell/palette";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE, authMode: "app" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE, authMode: "app" };
const manager: Me = { ...member, ...customRole(["people.manage", "links.create"], "Lead") };
const MEMBER_PERMS = ["links.create", "links.bulk", "domains.own", "keys", "agents"] as const;
// Out of order on purpose: the screen shows Owner, Member, then custom roles by name.
const ROLES: RoleItem[] = [
  { id: "zd", name: "Zed", perms: ["audit"], builtin: null, people: 0 },
  { id: "member", name: "Member", perms: [...MEMBER_PERMS], builtin: "member", people: 3 },
  { id: "hl", name: "Helper", perms: ["links.create", "links.editAny"], builtin: null, people: 2 },
  { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
];

function boot(opts: { me?: Me; path?: string; routes?: FakeRoutes } = {}) {
  history.replaceState(null, "", opts.path ?? "/people");
  const api = fakeApi({
    "GET /api/me": () => ({ body: opts.me ?? owner }),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/audit": () => ({ body: { items: [], next: null } }),
    "GET /api/roles": () => ({ body: ROLES }),
    ...opts.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
const roleRows = () => within(screen.getByRole("table", { name: "Roles" })).getAllByRole("row").slice(1) as HTMLTableRowElement[];
const tabs = () => within(screen.getByRole("navigation", { name: "People views" }));
const ready = () => waitFor(() => expect(roleRows()).toHaveLength(4));
afterEach(() => vi.unstubAllGlobals());

describe("Roles view", () => {
  it("O from People opens it; Owner, Member, then custom roles by name; All for Owner, counts for the rest", async () => {
    const { user } = boot();
    await screen.findByRole("navigation", { name: "People views" });
    await user.keyboard("o");
    await ready();
    expect(location.pathname).toBe("/people/roles");
    expect(roleRows().map((r) => r.cells[0]!.textContent)).toEqual(["Owner", "Member", "Helper", "Zed"]);
    expect(roleRows().map((r) => r.cells[2]!.textContent)).toEqual(["All", "5", "2", "1"]);
    expect(roleRows()[2]!.cells[1]!.textContent).toBe("2");
    expect(tabs().getByRole("link", { name: /Roles/ }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: /People/ }).textContent).toContain("P");
    await user.keyboard("p");
    expect(location.pathname).toBe("/people");
  });

  it("keyboard only: J, Enter, two boxes with Space, Ctrl+Enter sends PATCH with exactly those perms", async () => {
    const { api, user } = boot({ path: "/people/roles", routes: { "PATCH /api/roles/member": ({ body }) => ({ body: { ...ROLES[1], ...(body as object) } }) } });
    await ready();
    await user.keyboard("jj{Enter}");
    const dlg = await screen.findByRole("dialog", { name: "Member" });
    expect(document.activeElement).toBe(within(dlg).getByLabelText("Name"));
    await user.tab(); // Create links (on)
    await user.keyboard(" ");
    await user.tab(); // Edit anyone's links (off)
    await user.keyboard(" ");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "PATCH", path: "/api/roles/member", body: { perms: ["links.editAny", "links.bulk", "domains.own", "keys", "agents"] } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the toggles are in R2 order with plain labels; export and agents say what they mean", async () => {
    const { user } = boot({ path: "/people/roles" });
    await ready();
    await user.keyboard("jjj{Enter}");
    const dlg = await screen.findByRole("dialog", { name: "Helper" });
    const boxes = within(dlg).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(12);
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(["links.create", "links.editAny"]);
    expect(dlg.textContent).toContain("Downloads every person, link and domain.");
    expect(dlg.textContent).toContain("Separate from API keys.");
    expect(dlg.textContent).not.toContain("\u2014");
  });

  it("New role N: an empty name shows the bad_name copy and sends nothing", async () => {
    const { api, user } = boot({ path: "/people/roles" });
    await ready();
    expect(screen.getByRole("button", { name: /New role/ }).textContent).toContain("N");
    await user.keyboard("n");
    const dlg = await screen.findByRole("dialog", { name: "New role" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await within(dlg).findByRole("alert")).textContent).toBe("Use 1 to 40 characters.");
    expect(writes(api)).toHaveLength(0);
  });

  it("New role sends POST with the name and boxes; 409 name_taken shows its copy", async () => {
    const { api, user } = boot({ path: "/people/roles", routes: { "POST /api/roles": () => ({ status: 409, body: { error: "name_taken" } }) } });
    await ready();
    await user.keyboard("n");
    const dlg = await screen.findByRole("dialog", { name: "New role" });
    await user.keyboard("Editors");
    await user.tab();
    await user.keyboard(" ");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "POST", path: "/api/roles", body: { name: "Editors", perms: ["links.create"] } });
    expect((await within(dlg).findByRole("alert")).textContent).toBe("Another role already has this name.");
  });

  it("Shift X on a role in use asks where its people go and sends moveTo", async () => {
    const { api, user } = boot({ path: "/people/roles", routes: { "DELETE /api/roles/hl": () => ({ body: { moved: 2 } }) } });
    await ready();
    await user.keyboard("jjj{Enter}");
    await screen.findByRole("dialog", { name: "Helper" });
    await user.tab(); // out of the name field: hotkeys never fire while typing
    await user.keyboard("{Shift>}X{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Delete the role Helper" });
    expect(c.textContent).toContain("Move its 2 people to");
    const pick = within(c).getByRole("listbox");
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["Member", "Zed"]);
    pick.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(writes(api)).toHaveLength(0); // picking is not confirming
    await user.click(within(c).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/roles/hl", body: { moveTo: "zd" } })]));
  });

  it("deleting a role nobody has asks once and sends no moveTo; a 409 role_in_use then asks where they go", async () => {
    let n = 0;
    const { api, user } = boot({ path: "/people/roles", routes: { "DELETE /api/roles/zd": () => (n++ ? { body: { moved: 1 } } : { status: 409, body: { error: "role_in_use", people: 1 } }) } });
    await ready();
    await user.keyboard("jjjj{Enter}");
    await screen.findByRole("dialog", { name: "Zed" });
    await user.tab(); // out of the name field: hotkeys never fire while typing
    await user.keyboard("{Shift>}X{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Delete the role Zed" });
    expect(within(c).queryByRole("listbox")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]!.body).toBeUndefined();
    const again = await screen.findByText("Move its 1 person to");
    expect(again).toBeTruthy();
    expect(screen.getByText("People still have this role. Choose where they go.")).toBeTruthy();
    await user.click(within(screen.getByRole("dialog", { name: "Delete the role Zed" })).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(writes(api)[1]).toMatchObject({ method: "DELETE", path: "/api/roles/zd", body: { moveTo: "member" } }));
  });

  it("Member and Owner cannot be deleted; Owner's boxes are all checked and disabled", async () => {
    const { user } = boot({ path: "/people/roles" });
    await ready();
    await user.keyboard("j{Enter}");
    const dlg = await screen.findByRole("dialog", { name: "Owner" });
    const boxes = within(dlg).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => b.checked && b.disabled)).toBe(true);
    expect(dlg.textContent).toContain("The owner role always has every permission.");
    expect(within(dlg).queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.keyboard("j{Enter}");
    const m = await screen.findByRole("dialog", { name: "Member" });
    expect(within(m).queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.tab();
    await user.keyboard("{Shift>}X{/Shift}");
    expect(screen.queryByRole("dialog", { name: /Delete the role/ })).toBeNull();
  });

  it("a people manager sees the list and a read-only sheet: no New role, no Save, no Delete", async () => {
    const { api, user } = boot({ me: manager, path: "/people/roles" });
    await ready();
    expect(screen.queryByRole("button", { name: /New role/ })).toBeNull();
    await user.keyboard("n");
    expect(screen.queryByRole("dialog", { name: "New role" })).toBeNull();
    await user.keyboard("jjj{Enter}");
    const dlg = await screen.findByRole("dialog", { name: "Helper" });
    expect(within(dlg).queryByRole("textbox")).toBeNull();
    expect((within(dlg).getAllByRole("checkbox") as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
    expect(within(dlg).queryByRole("button", { name: /Save|Delete/ })).toBeNull();
    await user.keyboard("{Control>}{Enter}{/Control}{Shift>}X{/Shift}");
    expect(writes(api)).toHaveLength(0);
  });

  it("an audit-only role has no Roles view: /people/roles shows the audit log", async () => {
    const { api } = boot({ me: { ...member, ...customRole(["audit"]) }, path: "/people/roles" });
    await screen.findByRole("complementary", { name: "Audit log" });
    expect(screen.queryByRole("navigation", { name: "People views" })).toBeNull();
    expect(api.calls.some((c) => c.path === "/api/roles")).toBe(false);
  });

  it("at 360 px the role sheet is full width with 44 px buttons and the name in a 16 px field", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("760px") || q.includes("1080px"), media: q, addEventListener() {}, removeEventListener() {} }));
    const { user } = boot({ path: "/people/roles" });
    await ready();
    await user.keyboard("jjj{Enter}");
    const dlg = await screen.findByRole("dialog", { name: "Helper" });
    expect(dlg.className).toBe("sheet");
    expect(within(dlg).getByLabelText("Name").parentElement!.className).toBe("ctl");
    for (const b of within(dlg).getAllByRole("button")) expect(b.className).toMatch(/\bbtn\b/);
  });
});

describe("palette gr", () => {
  const ctx = { domains: [], open: vi.fn(), setCurrentDomain: () => {} };
  it("Roles for owners and people managers only", () => {
    expect(buildCommands(ctx, owner).find((c) => c.keys === "gr")).toMatchObject({ section: "Go to", label: "Roles" });
    expect(buildCommands(ctx, manager).some((c) => c.keys === "gr")).toBe(true);
    expect(buildCommands(ctx, member).some((c) => c.keys === "gr")).toBe(false);
    expect(buildCommands(ctx, { ...member, ...customRole(["audit"]) }).some((c) => c.keys === "gr")).toBe(false);
  });
});
