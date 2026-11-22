import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { transferTargets } from "./PersonSheet";
import type { Me, UserItem } from "../api";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE, authMode: "app" };
const u = (id: string, o: Partial<UserItem> = {}): UserItem => ({
  id, email: `${id}@example.com`, name: id.toUpperCase(), role: "member", roleId: "member", roleName: "Member", perms: [], status: "active", createdAt: 1_700_050_000, linkCount: 2, agentCount: 0, domains: [], ...o,
});
const USERS = [
  u("uo", { name: "Olive", role: "owner" }),
  u("ub", { name: "Bea", role: "owner" }),
  u("ud", { name: "Dana", domains: [{ id: "dp", host: "dana.test", via: "owner" }, { id: "ds1", host: "nw.link", via: "member" }] }),
  u("uc", { name: "Cy", role: "owner", domains: [{ id: "ds2", host: "qr.test", via: "owner" }] }),
  u("ui", { name: null, email: "jordan@example.com", status: "invited" }),
  u("ux", { name: "Xan", status: "disabled" }),
];
const DOMAINS = [
  { id: "d0", host: "go.test", type: "main", status: "active" },
  { id: "ds1", host: "nw.link", type: "shared", status: "active" },
  { id: "ds2", host: "qr.test", type: "shared", status: "active" },
  { id: "dp", host: "dana.test", type: "private", status: "active", ownerId: "ud" },
];

const ROLES = [
  { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 3 },
  { id: "member", name: "Member", perms: [...MEMBER_ROLE.perms], builtin: "member", people: 3 },
  { id: "hl", name: "Helper", perms: ["links.create"], builtin: null, people: 0 },
];

let list: UserItem[] = USERS;
function boot(routes: FakeRoutes = {}, me: Me = owner) {
  list = USERS;
  history.replaceState(null, "", "/people");
  const ok = (): FakeRes => ({ body: {} });
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: DOMAINS }),
    "GET /api/users": () => ({ body: { items: list } }),
    "GET /api/roles": () => ({ body: ROLES }),
    "GET /api/audit": () => ({ body: { items: [], next: null } }),
    "POST /api/users/ui/resend": () => ({ body: { emailed: true } }),
    "DELETE /api/users/ui/invite": ok,
    "PATCH /api/users/ud": ({ body }) => ({ body: { user: { ...USERS[2], ...(body as object) } } }),
    "PATCH /api/users/ux": () => ({ body: { user: USERS[5] } }),
    "DELETE /api/users/ud/sessions": () => ({ status: 204 }),
    "DELETE /api/users/ud": () => ((list = list.filter((x) => x.id !== "ud")), { body: {} }),
    "DELETE /api/users/uc": ok,
    ...routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const row = (text: string) => screen.getAllByRole("row").find((r) => r.textContent!.includes(text))!;
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
async function openPerson(text: string, routes?: FakeRoutes, me?: Me) {
  const t = boot(routes, me);
  await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(USERS.length + 1));
  row(text).focus();
  await t.user.keyboard("{Enter}");
  const dlg = await screen.findByRole("dialog");
  return { ...t, dlg };
}
afterEach(() => vi.unstubAllGlobals());

describe("People list", () => {
  it("invited rows show the date they were invited; the header has Invite person N", async () => {
    boot();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(USERS.length + 1));
    expect(row("jordan@example.com").textContent).toContain("Invited Nov 15");
    expect(screen.getByRole("button", { name: /Invite person/ }).textContent).toContain("N");
  });
});

describe("Person sheet role", () => {
  it("an owner's picker shows the person's custom role selected, among every role", async () => {
    const helper = USERS.map((x) => (x.id === "ud" ? { ...x, roleId: "hl", roleName: "Helper" } : x));
    const { dlg } = await openPerson("Dana", { "GET /api/users": () => ({ body: { items: helper } }) });
    const pick = within(dlg).getByRole("listbox", { name: "Role" });
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["Owner", "Member", "Helper"]);
    expect(within(pick).getByRole("option", { name: "Helper" }).getAttribute("aria-selected")).toBe("true");
  });

  it("picking a custom role confirms, then sends { roleId } and names the role", async () => {
    const { api, user, dlg } = await openPerson("Dana");
    within(dlg).getByRole("listbox", { name: "Role" }).focus();
    await user.keyboard("{End}{Enter}");
    const c = await screen.findByRole("dialog", { name: "Give ud@example.com the role Helper" });
    expect(c.textContent).toContain("They can do what Helper allows from their next request.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/users/ud", body: { roleId: "hl" } })]));
    expect(document.querySelector("[aria-live]")!.textContent).toBe("Gave ud@example.com the role Helper");
  });

  it("with the picker focused, A still shows their activity (no type-ahead), even with a role starting with A", async () => {
    const roles = [...ROLES, { id: "au", name: "Auditor", perms: ["audit"], builtin: null, people: 0 }];
    const { api, user, dlg } = await openPerson("Dana", { "GET /api/roles": () => ({ body: roles }) });
    within(dlg).getByRole("listbox", { name: "Role" }).focus();
    await user.keyboard("a");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(api.calls.map((c) => c.path)).toContain("/api/audit?actor=ud"));
  });

  it("a failed role list shows the error with Retry, which loads the picker", async () => {
    let n = 0;
    const { user, dlg } = await openPerson("Dana", { "GET /api/roles": () => (n++ ? { body: ROLES } : { status: 500, body: { error: "internal_error" } }) });
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toContain("Could not load the roles.");
    await user.click(within(dlg).getByRole("button", { name: "Retry" }));
    expect(await within(dlg).findByRole("listbox", { name: "Role" })).toBeTruthy();
  });

  it("a people manager picks only roles within their own permissions, never Owner; an owner's role is plain text", async () => {
    const lead: Me = { ...owner, id: "um", ...customRole(["people.manage", "links.create"], "Lead") };
    const { dlg } = await openPerson("Dana", undefined, lead);
    const pick = within(dlg).getByRole("listbox", { name: "Role" });
    expect(within(pick).queryByRole("option", { name: /Owner/ })).toBeNull();
    expect(within(pick).getByRole("option", { name: /Member/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(pick).getByRole("option", { name: "Helper" }).getAttribute("aria-disabled")).toBeNull();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    row("Bea").focus();
    await userEvent.setup().keyboard("{Enter}");
    const bea = await screen.findByRole("dialog", { name: "Bea" });
    expect(within(bea).queryByRole("listbox")).toBeNull();
    expect(within(bea).getByText("Owner")).toBeTruthy();
  });
});

describe("Person sheet", () => {
  it("Enter on a row opens it with role, status and read-only domains", async () => {
    const { dlg } = await openPerson("Dana");
    expect(dlg.getAttribute("aria-label")).toBe("Dana");
    expect(within(dlg).getByRole("listbox", { name: "Role" })).toBeTruthy();
    expect(within(dlg).getByText("Active")).toBeTruthy();
    expect(within(dlg).getByText("nw.link")).toBeTruthy();
    expect(within(dlg).getByText("dana.test")).toBeTruthy();
    expect(within(dlg).queryAllByRole("switch")).toHaveLength(0);
    // Never invited (an active person): "Added", not "Invited".
    expect(dlg.textContent).toMatch(/Added [A-Z][a-z]{2} \d+/);
    expect(dlg.textContent).not.toContain("Invited");
  });

  it("invited: shows the invited date, R re-sends once", async () => {
    const { api, user, dlg } = await openPerson("jordan@example.com");
    expect(dlg.textContent).toContain("Invited Nov 15");
    await user.keyboard("r");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "POST", path: "/api/users/ui/resend" });
    await waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Re-sent the invite to jordan@example.com"));
  });

  it("429 too_soon on resend shows its copy", async () => {
    const { user, dlg } = await openPerson("jordan@example.com", { "POST /api/users/ui/resend": () => ({ status: 429, body: { error: "too_soon" } }) });
    await user.keyboard("r");
    expect((await within(dlg).findByRole("alert")).textContent).toBe("The invite was just sent. Wait a minute before sending it again.");
  });

  it("Shift R then Enter revokes the invite and closes", async () => {
    const { api, user } = await openPerson("jordan@example.com");
    await user.keyboard("{Shift>}R{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Revoke the invite" });
    expect(c.textContent).toContain("Revoke the invite for jordan@example.com? They will not be able to sign in.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/users/ui/invite" })]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a person gone from the list while their sheet is open: the sheet closes and focus lands on the row in their place", async () => {
    // The resend reloads the list; meanwhile the invite was revoked elsewhere, so the person is gone.
    const { user } = await openPerson("jordan@example.com", { "POST /api/users/ui/resend": () => ((list = list.filter((x) => x.id !== "ui")), { body: { emailed: true } }) });
    await user.keyboard("r");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row("Xan")));
  });

  it("Shift D then Esc sends nothing; the confirm says agents stop working", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("{Shift>}D{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Turn off access" });
    expect(c.textContent).toContain("Turn off access for ud@example.com? They are signed out now, and their agents and API keys stop working.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn off access" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Dana" })).toBeTruthy();
    expect(writes(api)).toHaveLength(0);
  });

  it("Shift D then Enter disables", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("{Shift>}D{/Shift}");
    await screen.findByRole("dialog", { name: "Turn off access" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/users/ud", body: { status: "disabled" } })]));
  });

  it("Shift S then Enter signs them out everywhere", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("{Shift>}S{/Shift}");
    expect((await screen.findByRole("dialog", { name: "Sign out everywhere" })).textContent).toContain("Sign ud@example.com out on every device?");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/users/ud/sessions" })]));
  });

  it("disabled: E turns access back on", async () => {
    const { api, user } = await openPerson("Xan");
    await user.keyboard("e");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/users/ux", body: { status: "active" } })]));
  });

  it("opens on a neutral focus: Enter, Enter on an owner's sheet sends no PATCH", async () => {
    const { api, user, dlg } = await openPerson("Bea");
    expect(document.activeElement).toBe(within(dlg).getByRole("button", { name: /Activity/ }));
    expect(document.activeElement?.getAttribute("role")).not.toBe("listbox");
    await user.keyboard("{Enter}{Enter}");
    await new Promise((r) => setTimeout(r, 20));
    expect(writes(api)).toHaveLength(0);
  });

  it("ArrowRight on a member's sheet sends nothing", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("{ArrowRight}");
    await new Promise((r) => setTimeout(r, 20));
    expect(writes(api)).toHaveLength(0);
  });

  it("demote confirms and names the domains that move; Esc sends nothing, Enter sends one PATCH", async () => {
    const { api, user, dlg } = await openPerson("Cy");
    within(dlg).getByRole("listbox", { name: "Role" }).focus();
    await user.keyboard("{ArrowDown}{Enter}");
    const c = await screen.findByRole("dialog", { name: "Make uc@example.com a member" });
    expect(c.textContent).toContain("Make uc@example.com a member? They lose owner rights, and qr.test move to you.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /a member$/ })).toBeNull());
    expect(writes(api)).toHaveLength(0);
    await user.click(within(dlg).getByRole("option", { name: "Member" }));
    await screen.findByRole("dialog", { name: "Make uc@example.com a member" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/users/uc", body: { roleId: "member" } })]));
  });

  it("demoting an owner with no main or shared domains says none move", async () => {
    const { user, dlg } = await openPerson("Bea");
    await user.click(within(dlg).getByRole("option", { name: "Member" }));
    expect((await screen.findByRole("dialog", { name: "Make ub@example.com a member" })).textContent).toContain("They lose owner rights. No domains move.");
  });

  it("promote confirms; Esc sends nothing, Enter sends one PATCH", async () => {
    const { api, user, dlg } = await openPerson("Dana");
    await user.click(within(dlg).getByRole("option", { name: "Owner" }));
    const c = await screen.findByRole("dialog", { name: "Make ud@example.com an owner" });
    expect(c.textContent).toContain("Make ud@example.com an owner? They can change every setting and person.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /an owner$/ })).toBeNull());
    expect(writes(api)).toHaveLength(0);
    await user.click(within(dlg).getByRole("option", { name: "Owner" }));
    await screen.findByRole("dialog", { name: "Make ud@example.com an owner" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "PATCH", path: "/api/users/ud", body: { roleId: "owner" } });
  });

  it("after Remove, focus goes to the row that took its place", async () => {
    const { user } = await openPerson("Dana");
    await user.keyboard("{Shift>}X{/Shift}");
    await screen.findByRole("dialog", { name: "Remove ud@example.com" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(USERS.length));
    await waitFor(() => expect(document.activeElement).toBe(row("Cy")));
  });

  it("the transfer target resets after cancel", async () => {
    const { user } = await openPerson("Dana");
    await user.keyboard("{Shift>}X{/Shift}");
    await user.selectOptions(within(await screen.findByRole("dialog", { name: "Remove ud@example.com" })).getByLabelText("Move their links and domains to"), "ub");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull());
    await user.keyboard("{Shift>}X{/Shift}");
    const sel = within(await screen.findByRole("dialog", { name: "Remove ud@example.com" })).getByLabelText("Move their links and domains to") as HTMLSelectElement;
    expect(sel.value).toBe("uo");
  });

  it("role change sends PATCH role; 409 last_owner shows its copy", async () => {
    const { api, user, dlg } = await openPerson("Bea", { "PATCH /api/users/ub": () => ({ status: 409, body: { error: "last_owner" } }) });
    await user.click(within(dlg).getByRole("option", { name: "Member" }));
    await screen.findByRole("dialog", { name: "Make ub@example.com a member" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/users/ub", body: { roleId: "member" } })]));
    expect((await within(dlg).findByRole("alert")).textContent).toBe("linkwarren needs at least one active owner. Make someone else an owner first.");
  });

  it("remove defaults to you and sends transferTo; a member with private domains can move to anyone active", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("{Shift>}X{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Remove ud@example.com" });
    const sel = within(c).getByLabelText("Move their links and domains to") as HTMLSelectElement;
    expect(sel.value).toBe("uo");
    expect([...sel.options].map((o) => o.textContent)).toEqual(["You", "Bea", "Cy"]);
    expect(c.textContent).toContain("Remove ud@example.com? Their links and domains move to you. Their API keys and agent connections are deleted. This cannot be undone.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/users/ud?transferTo=uo" })]));
  });

  it("remove of someone who owns a shared domain lists only owners", async () => {
    const { api, user } = await openPerson("Cy");
    await user.keyboard("{Shift>}X{/Shift}");
    const c = await screen.findByRole("dialog", { name: "Remove uc@example.com" });
    const sel = within(c).getByLabelText("Move their links and domains to") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["You", "Bea"]);
    await user.selectOptions(sel, "ub");
    expect(c.textContent).toContain("move to Bea.");
    await user.click(within(c).getByRole("button", { name: /^Remove/ }));
    await waitFor(() => expect(writes(api)).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/users/uc?transferTo=ub" })]));
  });

  it("self: no role control, no Remove, no access actions", async () => {
    const { user, dlg } = await openPerson("You");
    expect(within(dlg).queryByRole("listbox")).toBeNull();
    expect(within(dlg).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(dlg).queryByRole("button", { name: /Turn off/ })).toBeNull();
    await user.keyboard("{Shift>}X{/Shift}");
    expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull();
  });

  it("A shows their activity in the audit log", async () => {
    const { api, user } = await openPerson("Dana");
    await user.keyboard("a");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(api.calls.map((c) => c.path)).toContain("/api/audit?actor=ud"));
    expect(screen.getByText("Only Dana")).toBeTruthy();
  });

  it("at 360 px it is a full-width sheet with 44 px buttons and a close button", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("760px") || q.includes("1080px"), media: q, addEventListener() {}, removeEventListener() {} }));
    const { dlg } = await openPerson("Dana");
    expect(dlg.className).toBe("sheet");
    expect(within(dlg).getByRole("button", { name: "Close dana" }).className).toContain("btn");
    for (const b of within(dlg).getAllByRole("button")) expect(b.className).toMatch(/\bbtn\b|^$/);
  });
});

describe("transferTargets (S8 R4: a manager's removal goes to an owner)", () => {
  const manager: Me = { id: "um", email: "m@example.com", name: "Mo", role: "member", ...MEMBER_ROLE, authMode: "app" };
  const people = [u("um"), u("ua"), u("ob", { role: "owner", createdAt: 5 }), u("oa", { role: "owner", createdAt: 5 }), u("o1", { role: "owner", createdAt: 2 }), u("od", { role: "owner", status: "disabled", createdAt: 1 })];
  it("a non-owner gets only active owners, first owner first, never themselves", () => {
    expect(transferTargets(people, manager, "ua", false).map((x) => x.id)).toEqual(["o1", "oa", "ob"]);
  });
  it("an owner keeps the free choice, themselves first", () => {
    const me: Me = { ...owner, id: "oa" };
    expect(transferTargets(people, me, "ua", false).map((x) => x.id)).toEqual(["oa", "um", "ob", "o1"]);
    expect(transferTargets(people, me, "ua", true).map((x) => x.id)).toEqual(["oa", "ob", "o1"]);
  });
});
