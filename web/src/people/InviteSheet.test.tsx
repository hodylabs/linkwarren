import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me, UserItem } from "../api";
import { buildCommands } from "../shell/palette";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE, authMode: "app" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE, authMode: "app" };
const USERS: UserItem[] = [
  { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", roleId: "owner", roleName: "Owner", perms: [], status: "active", createdAt: 1, linkCount: 0, agentCount: 0, domains: [] },
];
const DOMAINS = [
  { id: "d0", host: "go.test", type: "main", status: "active" },
  { id: "ds1", host: "nw.link", type: "shared", status: "active" },
  { id: "ds2", host: "qr.test", type: "shared", status: "active" },
  { id: "dp", host: "mine.test", type: "private", status: "active", ownerId: "uo" },
];
const SETTINGS = { emailFrom: "links@example.com", emailConfigured: true, dashboardHost: "example.com", dashboardUrl: "https://example.com/dashboard" };

function boot(opts: { me?: Me; invite?: (body: unknown) => FakeRes; settings?: unknown; routes?: FakeRoutes } = {}) {
  history.replaceState(null, "", "/people");
  const api = fakeApi({
    "GET /api/me": () => ({ body: opts.me ?? owner }),
    "GET /api/domains": () => ({ body: DOMAINS }),
    "GET /api/users": () => ({ body: { items: USERS } }),
    "GET /api/audit": () => ({ body: { items: [], next: null } }),
    "GET /api/settings": () => ({ body: opts.settings ?? SETTINGS }),
    "GET /api/roles": () => ({ body: [
      { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
      { id: "member", name: "Member", perms: [...MEMBER_ROLE.perms], builtin: "member", people: 0 },
      { id: "hl", name: "Helper", perms: ["people.manage"], builtin: null, people: 0 },
    ] }),
    "POST /api/users/invite": ({ body }) => (opts.invite ? opts.invite(body) : { status: 201, body: { user: {}, emailed: true } }),
    ...opts.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const ready = () => screen.findByRole("button", { name: /Invite person/ });
const sheet = () => screen.getByRole("dialog", { name: "Invite a person" });
const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST" && c.path === "/api/users/invite");
afterEach(() => vi.unstubAllGlobals());

async function openInvite() {
  const t = boot();
  await ready();
  await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
  await t.user.keyboard("n");
  await screen.findByRole("dialog", { name: "Invite a person" });
  return t;
}

describe("Invite sheet", () => {
  it("N opens it for an owner with the email box focused", async () => {
    await openInvite();
    expect(document.activeElement).toBe(within(sheet()).getByLabelText("Email"));
    expect(within(sheet()).getByText("Esc")).toBeTruthy();
  });

  it("N typed in the search box does not open it", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search and go" });
    await user.keyboard("n");
    expect(screen.queryByRole("dialog", { name: "Invite a person" })).toBeNull();
  });

  it("a member has no invite button and N does nothing", async () => {
    const { user } = boot({ me: member });
    await screen.findByText("Not in your role");
    expect(screen.queryByRole("button", { name: /Invite person/ })).toBeNull();
    await user.keyboard("n");
    expect(screen.queryByRole("dialog", { name: "Invite a person" })).toBeNull();
  });

  it("main domains are fixed rows, shared are switches; Space on the first switch then Ctrl+Enter sends exactly that", async () => {
    const { api, user } = await openInvite();
    const s = sheet();
    expect(within(s).getByText("Main, always included")).toBeTruthy();
    expect(within(s).getAllByRole("switch").map((x) => x.getAttribute("aria-label"))).toEqual(["nw.link", "qr.test"]);
    expect(within(s).queryByText("mine.test")).toBeNull();
    await user.keyboard("jordan@example.com");
    await user.tab(); // role
    await user.tab(); // first shared switch (the main row is not focusable)
    expect(document.activeElement?.getAttribute("aria-label")).toBe("nw.link");
    await user.keyboard(" ");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ email: "jordan@example.com", roleId: "member", domainIds: ["ds1"] });
  });

  it("defaults to Member; picking Helper with the keyboard sends its roleId", async () => {
    const { api, user } = await openInvite();
    const pick = await within(sheet()).findByRole("listbox", { name: "Role" });
    expect(within(pick).getByRole("option", { name: "Member" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("jordan@example.com");
    await user.tab();
    expect(document.activeElement).toBe(pick);
    await user.keyboard("{ArrowDown}{Enter}{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ email: "jordan@example.com", roleId: "hl", domainIds: [] });
  });

  it("400 bad_role (the picked role deleted meanwhile): reloads the roles, falls back to Member, keeps the email", async () => {
    let n = 0;
    const roles = [
      { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
      { id: "member", name: "Member", perms: [...MEMBER_ROLE.perms], builtin: "member", people: 0 },
      { id: "hl", name: "Helper", perms: ["people.manage"], builtin: null, people: 0 },
    ];
    const { api, user } = boot({
      invite: (body) => ((body as { roleId: string }).roleId === "hl" ? { status: 400, body: { error: "bad_role" } } : { status: 201, body: { user: {}, emailed: true } }),
      routes: { "GET /api/roles": () => ({ body: n++ ? roles.filter((r) => r.id !== "hl") : roles }) },
    });
    await ready();
    await user.keyboard("n");
    const pick = await within(await screen.findByRole("dialog", { name: "Invite a person" })).findByRole("listbox", { name: "Role" });
    await user.keyboard("jordan@example.com");
    await user.click(within(pick).getByRole("option", { name: "Helper" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await within(sheet()).findByRole("alert")).textContent).toBe("That role no longer exists. Reload and try again.");
    await waitFor(() => expect(within(sheet()).queryByRole("option", { name: "Helper" })).toBeNull());
    expect(within(sheet()).getByRole("option", { name: "Member" }).getAttribute("aria-selected")).toBe("true");
    expect((within(sheet()).getByLabelText("Email") as HTMLInputElement).value).toBe("jordan@example.com");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(posts(api)[1]!.body).toEqual({ email: "jordan@example.com", roleId: "member", domainIds: [] });
  });

  it("bad_role, then the roles reload fails: error and Retry show, sending is blocked; Retry picks a valid role and keeps the email", async () => {
    let n = 0;
    const roles = [
      { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
      { id: "member", name: "Member", perms: [...MEMBER_ROLE.perms], builtin: "member", people: 0 },
      { id: "hl", name: "Helper", perms: ["people.manage"], builtin: null, people: 0 },
    ];
    const { api, user } = boot({
      invite: (body) => ((body as { roleId: string }).roleId === "hl" ? { status: 400, body: { error: "bad_role" } } : { status: 201, body: { user: {}, emailed: true } }),
      routes: { "GET /api/roles": () => (++n === 2 ? { status: 500, body: { error: "internal" } } : { body: n === 1 ? roles : roles.filter((r) => r.id !== "hl") }) },
    });
    await ready();
    await user.keyboard("n");
    const pick = await within(await screen.findByRole("dialog", { name: "Invite a person" })).findByRole("listbox", { name: "Role" });
    await user.keyboard("jordan@example.com");
    await user.click(within(pick).getByRole("option", { name: "Helper" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    const retry = await within(sheet()).findByRole("button", { name: "Retry" });
    expect(within(sheet()).queryByRole("listbox", { name: "Role" })).toBeNull();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(1);
    await user.click(retry);
    await waitFor(() => expect(within(sheet()).getByRole("option", { name: "Member" }).getAttribute("aria-selected")).toBe("true"));
    expect((within(sheet()).getByLabelText("Email") as HTMLInputElement).value).toBe("jordan@example.com");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(posts(api)[1]!.body).toEqual({ email: "jordan@example.com", roleId: "member", domainIds: [] });
  });

  it("the hint promises private domains only for a role that may add them", async () => {
    const { user } = await openInvite();
    const hint = /and can add a passkey and their own private domains\./;
    expect(sheet().textContent).toMatch(hint);
    await user.click(within(sheet()).getByRole("option", { name: "Helper" }));
    expect(sheet().textContent).not.toMatch(hint);
    expect(sheet().textContent).toContain("They sign in with their email, and can add a passkey.");
    await user.click(within(sheet()).getByRole("option", { name: "Owner" }));
    expect(sheet().textContent).toMatch(hint);
  });

  it("success closes the sheet, reloads people and announces", async () => {
    const { api, user } = await openInvite();
    const before = api.calls.filter((c) => c.path === "/api/users").length;
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite a person" })).toBeNull());
    expect(api.calls.filter((c) => c.path === "/api/users").length).toBeGreaterThan(before);
    expect(document.querySelector("[aria-live]")!.textContent).toBe("Invited jordan@example.com");
  });

  it("Owner hides the domains and sends no domain ids", async () => {
    const { api, user } = await openInvite();
    await user.keyboard("jordan@example.com");
    await user.click(within(sheet()).getByRole("option", { name: "Owner" }));
    expect(within(sheet()).queryByText("Domains they can use")).toBeNull();
    expect(within(sheet()).queryAllByRole("switch")).toHaveLength(0);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ email: "jordan@example.com", roleId: "owner", domainIds: [] });
  });

  it("409 email_taken shows its copy and keeps the values", async () => {
    const { user } = boot({ invite: () => ({ status: 409, body: { error: "email_taken" } }) });
    await ready();
    await user.keyboard("n");
    await screen.findByRole("dialog", { name: "Invite a person" });
    await user.keyboard("jordan@example.com");
    await user.click(within(sheet()).getByRole("switch", { name: "qr.test" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await within(sheet()).findByRole("alert")).textContent).toBe("This email is already in linkwarren.");
    expect((within(sheet()).getByLabelText("Email") as HTMLInputElement).value).toBe("jordan@example.com");
    expect(within(sheet()).getByRole("switch", { name: "qr.test" }).getAttribute("aria-checked")).toBe("true");
  });

  it("not emailed: shows the dashboard address, C copies it", async () => {
    const { user } = boot({ invite: () => ({ status: 201, body: { user: {}, emailed: false, emailReason: "not_configured" } }) });
    await ready();
    await user.keyboard("n");
    await screen.findByRole("dialog", { name: "Invite a person" });
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    await within(sheet()).findByText(/Invite saved/);
    expect(within(sheet()).getByText("Email is not set up yet. Set it up in Settings, or send them the dashboard address.")).toBeTruthy();
    expect(sheet().textContent).toContain("Invite saved. No email was sent. Send them this address: https://example.com/dashboard/");
    expect(within(sheet()).getByRole("button", { name: /Close/ })).toBeTruthy();
    await user.keyboard("c");
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("https://example.com/dashboard/"));
  });

  it("a saved invite that was not emailed says why", async () => {
    const { user } = boot({ invite: () => ({ status: 201, body: { user: {}, emailed: false, emailReason: "too_many" } }) });
    await ready();
    await user.keyboard("n");
    await screen.findByRole("dialog", { name: "Invite a person" });
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    expect(await within(sheet()).findByText("Too many emails were sent this hour. Try again later.")).toBeTruthy();
  });

  it("the footer says who sends it, or that email is not set up", async () => {
    await openInvite();
    expect(await within(sheet()).findByText("Sent from links@example.com")).toBeTruthy();
  });

  it("without email set up the footer says so", async () => {
    const { user } = boot({ settings: { ...SETTINGS, emailConfigured: false } });
    await ready();
    await user.keyboard("n");
    expect(await within(await screen.findByRole("dialog", { name: "Invite a person" })).findByText("Email is not set up yet")).toBeTruthy();
  });

  it("Esc sends nothing", async () => {
    const { api, user } = await openInvite();
    await user.keyboard("jordan@example.com{Escape}");
    expect(screen.queryByRole("dialog", { name: "Invite a person" })).toBeNull();
    expect(posts(api)).toHaveLength(0);
  });

  it("no text mentions Google, a one-time code or Access", async () => {
    await openInvite();
    await within(sheet()).findByText("Sent from links@example.com");
    const t = sheet().textContent!;
    expect(t).toContain("They get an email with a link to sign in. They sign in with their email, and can add a passkey and their own private domains.");
    expect(t).not.toMatch(/Google|one-time|Access/i);
  });

  it("at 360 px it is a full-width sheet with 44 px buttons and a close button", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("760px") || q.includes("1080px"), media: q, addEventListener() {}, removeEventListener() {} }));
    await openInvite();
    expect(sheet().className).toBe("sheet");
    expect(within(sheet()).getByRole("button", { name: "Close invite a person" }).className).toContain("btn");
    expect(within(sheet()).getByRole("button", { name: /Send invite/ }).className).toContain("btn");
  });
});

describe("Invite sheet for a people manager", () => {
  it("people.manage invites with N, as a Member only: no Owner choice", async () => {
    const { user } = boot({ me: { ...member, ...customRole(["people.manage"]) } });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
    await user.keyboard("n");
    const dlg = await screen.findByRole("dialog", { name: "Invite a person" });
    const pick = await within(dlg).findByRole("listbox", { name: "Role" });
    expect(within(pick).queryByRole("option", { name: /Owner/ })).toBeNull();
    // Member has keys and agents, which this manager lacks: shown, not pickable. Helper is within their permissions.
    expect(within(pick).getByRole("option", { name: /Member/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(pick).getByRole("option", { name: "Helper" }).getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Invite sheet role default and load errors", () => {
  const open = async (me: Me, routes?: FakeRoutes) => {
    const t = boot({ me, routes });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
    await t.user.keyboard("n");
    await screen.findByRole("dialog", { name: "Invite a person" });
    return t;
  };

  it("a people manager below Member starts on the first role they may give, and sends it", async () => {
    const { api, user } = await open({ ...member, ...customRole(["people.manage"]) });
    const pick = await within(sheet()).findByRole("listbox", { name: "Role" });
    expect(within(pick).getByRole("option", { name: "Helper" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toMatchObject({ roleId: "hl" });
  });

  it("with no role they may give it says so and sends nothing", async () => {
    const { api, user } = await open({ ...member, ...customRole(["people.manage"]) }, {
      "GET /api/roles": () => ({ body: [{ id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 }, { id: "member", name: "Member", perms: [...MEMBER_ROLE.perms], builtin: "member", people: 0 }] }),
    });
    expect((await within(sheet()).findByRole("alert")).textContent).toBe("Every role has permissions you do not have, so you cannot invite anyone. Ask an owner.");
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 20));
    expect(posts(api)).toHaveLength(0);
  });

  it("a failed role list shows the error with Retry and blocks sending until it loads", async () => {
    let n = 0;
    const { api, user } = await open(owner, { "GET /api/roles": () => (n++ ? { body: [{ id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 }, { id: "member", name: "Member", perms: [], builtin: "member", people: 0 }] } : { status: 500, body: { error: "internal_error" } }) });
    expect((await within(sheet()).findByRole("alert")).textContent).toContain("Could not load the roles.");
    await user.keyboard("jordan@example.com{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 20));
    expect(posts(api)).toHaveLength(0);
    await user.click(within(sheet()).getByRole("button", { name: "Retry" }));
    await within(sheet()).findByRole("listbox", { name: "Role" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toMatchObject({ roleId: "member" });
  });

  it("a people manager without domains.manage gets no shared-domain switches (the server refuses them); with it they do", async () => {
    await open({ ...member, ...customRole(["people.manage"]) });
    expect(within(sheet()).getByText("Main, always included")).toBeTruthy();
    expect(within(sheet()).queryAllByRole("switch")).toHaveLength(0);
  });
  it("a people manager with domains.manage gets the shared-domain switches", async () => {
    await open({ ...member, ...customRole(["people.manage", "domains.manage"]) });
    expect(within(sheet()).getAllByRole("switch")).toHaveLength(2);
  });
});

describe("palette cp", () => {
  const ctx = { domains: [], open: vi.fn(), setCurrentDomain: () => {} };
  it("Invite a person, people.manage only", () => {
    const cp = buildCommands(ctx, owner).find((c) => c.keys === "cp")!;
    expect(cp).toMatchObject({ section: "Create", label: "Invite a person" });
    cp.run();
    expect(ctx.open).toHaveBeenCalledWith({ kind: "invite" });
    expect(buildCommands(ctx, member).some((c) => c.keys === "cp")).toBe(false);
  });
});
