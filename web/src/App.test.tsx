import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { Domain, Me } from "./api";
import { errorText } from "./copy";
import { fakeApi, type FakeRoutes } from "./test/fakeApi";
import { MEMBER_ROLE, OWNER_ROLE } from "./test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive Owner", role: "owner", ...OWNER_ROLE };
const member: Me = { id: "um", email: "member@example.com", name: null, role: "member", ...MEMBER_ROLE };
const dom = (id: string, host: string, type: Domain["type"]): Domain => ({
  id, host, type, status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 3, isMember: false,
});
const domains = [dom("d1", "go.example.com", "main"), dom("d2", "team.example.com", "shared")];

function boot(me: Me, extra: FakeRoutes = {}, path = "/links") {
  history.replaceState(null, "", path);
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: domains }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [], next: null } }),
    ...extra,
  });
  render(<App />);
  return api;
}

describe("App shell", () => {
  it("owner sees the Owner nav section", async () => {
    boot(owner);
    const nav = await screen.findByRole("navigation");
    expect(within(nav).getByText("Owner")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: /People & audit log/ })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: /Settings/ })).toBeTruthy();
    expect(await screen.findByText("Signed in with Cloudflare Access")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout");
  });

  it("member does not see the Owner section", async () => {
    const { calls } = boot(member);
    const nav = await screen.findByRole("navigation");
    expect(within(nav).queryByText("Owner")).toBeNull();
    expect(within(nav).queryByRole("link", { name: /People/ })).toBeNull();
    expect(within(nav).getByRole("link", { name: /Links/ })).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/api/users"))).toBe(false);
  });

  it("member at /people sees Not in your role and no owner API call is made", async () => {
    const { calls } = boot(member, {}, "/people");
    expect(await screen.findByText("Not in your role")).toBeTruthy();
    await screen.findByRole("button", { name: /Switch domain/ });
    expect(calls.some((c) => c.path.startsWith("/api/users") || c.path.startsWith("/api/audit"))).toBe(false);
  });

  it("owner loads the people list", async () => {
    const { calls } = boot(owner);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/users")).toBe(true));
  });

  it("/analytics shows the Analytics screen", async () => {
    boot(member, { "GET /api/analytics": () => ({ status: 500, body: { error: "internal_error" } }) }, "/analytics");
    expect(await screen.findByRole("heading", { name: "Analytics" })).toBeTruthy();
    expect(screen.queryByText("Clicks, countries, devices and referrers arrive in a later version.")).toBeNull();
    expect(screen.getByRole("link", { name: /Analytics/ }).getAttribute("aria-current")).toBe("page");
  });

  it("a member gets API & agents in the top group, and G I opens it", async () => {
    boot(member, { "GET /api/agents/connections": () => ({ body: { items: [] } }), "GET /api/keys": () => ({ body: { items: [] } }) });
    const nav = await screen.findByRole("navigation");
    const item = within(nav).getByRole("link", { name: /API & agents/ });
    expect(within(nav).queryByText("Owner")).toBeNull();
    await screen.findByRole("heading", { name: "Links" });
    const user = userEvent.setup();
    await user.keyboard("gi");
    expect(location.pathname).toBe("/agents");
    expect(await screen.findByRole("heading", { name: "API & agents" })).toBeTruthy();
    expect(screen.queryByText("Not in your role")).toBeNull();
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("the owner keeps API & agents under the Owner section", async () => {
    boot(owner);
    const nav = await screen.findByRole("navigation");
    const sep = within(nav).getByText("Owner");
    const item = within(nav).getByRole("link", { name: /API & agents/ });
    expect(sep.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).getAllByRole("link", { name: /API & agents/ })).toHaveLength(1);
  });

  it.each(["/nope", "/"])("%s lands on Links", async (path) => {
    boot(owner, {}, path);
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
    await waitFor(() => expect(location.pathname).toBe("/links")); // the router replace lands after the first render
  });

  it("nav links navigate without a page load", async () => {
    boot(owner);
    const link = await screen.findByRole("link", { name: /Domains/ });
    link.click();
    expect(location.pathname).toBe("/domains");
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeTruthy();
  });

  it("the logo is a home link to Links and the rail shows the app version", async () => {
    boot(owner, {}, "/domains");
    const home = await screen.findByRole("link", { name: "linkwarren home" });
    expect(home.getAttribute("href")).toBe("/links");
    home.click();
    expect(location.pathname).toBe("/links");
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
    expect(screen.getByText(/^Dashboard v\d+\.\d+\.\d+/)).toBeTruthy();
  });

  it("an empty links list offers to create the first link", async () => {
    boot(owner);
    expect(await screen.findByText("No links here yet.")).toBeTruthy();
    screen.getByRole("button", { name: "Create a link" }).click();
    expect(await screen.findByRole("dialog", { name: "New link" })).toBeTruthy();
  });

  it.each([
    [403, "not_invited", "This email is not invited to this linkwarren. Ask the owner to invite you."],
    [403, "disabled", "Your access has been turned off. Ask the owner."],
    [401, "unauthenticated", "You are signed out. Reload the page to sign in."],
  ])("/api/me %i %s shows its copy", async (status, error, text) => {
    fakeApi({ "GET /api/me": () => ({ status, body: { error } }) });
    render(<App />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("/api/me answered by a login redirect shows the signed-out copy", async () => {
    fakeApi({ "GET /api/me": () => ({ signIn: true }) });
    render(<App />);
    expect(await screen.findByText("You are signed out. Reload the page to sign in.")).toBeTruthy();
  });

  it("/api/me with a dropped connection says so, not signed out", async () => {
    fakeApi({ "GET /api/me": () => { throw new TypeError("Failed to fetch"); } });
    render(<App />);
    expect(await screen.findByText(errorText("offline"))).toBeTruthy();
    expect(screen.queryByText("You are signed out. Reload the page to sign in.")).toBeNull();
  });

  it("a later API call answered by a login redirect shows the signed-out banner over the shell", async () => {
    boot(owner, { "GET /api/domains": () => ({ signIn: true }) });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("You are signed out. Reload the page to sign in.");
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  it("a later API call with a dropped connection shows the load error, not the signed-out banner", async () => {
    boot(owner, { "GET /api/domains": () => { throw new TypeError("Failed to fetch"); } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(errorText("offline"));
    expect(screen.queryByText("You are signed out. Reload the page to sign in.")).toBeNull();
  });

  it("a 500 on the first domains load shows an error with Retry, and Retry recovers", async () => {
    localStorage.setItem("lw.domain", "d2");
    let fail = true;
    boot(owner, { "GET /api/domains": () => (fail ? { status: 500, body: { error: "internal" } } : { body: domains }) });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the dashboard data. Something went wrong (internal)");
    expect(screen.getByRole("button", { name: "Switch domain, current All domains" })).toBeTruthy();
    fail = false;
    screen.getByRole("button", { name: "Retry" }).click();
    expect(await screen.findByRole("button", { name: "Switch domain, current team.example.com" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the domain button shows the remembered domain, or All domains", async () => {
    localStorage.setItem("lw.domain", "d2");
    boot(owner);
    expect(await screen.findByRole("button", { name: "Switch domain, current team.example.com" })).toBeTruthy();
    expect(screen.getByText("Shared")).toBeTruthy();
  });

  it("an unknown remembered domain falls back to All domains", async () => {
    localStorage.setItem("lw.domain", "gone");
    boot(owner);
    expect(await screen.findByRole("button", { name: "Switch domain, current All domains" })).toBeTruthy();
  });

  it("shows the avatar initials and role", async () => {
    boot(member);
    expect(await screen.findByText("ME")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });
});
