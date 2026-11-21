import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { Domain, Me } from "./api";
import { fakeApi, type FakeRoutes } from "./test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive Owner", role: "owner" };
const member: Me = { id: "um", email: "member@example.com", name: null, role: "member" };
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

  it("member at /people sees Owner only and no owner API call is made", async () => {
    const { calls } = boot(member, {}, "/people");
    expect(await screen.findByText("Owner only")).toBeTruthy();
    await screen.findByRole("button", { name: /Switch domain/ });
    expect(calls.some((c) => c.path.startsWith("/api/users") || c.path.startsWith("/api/audit"))).toBe(false);
  });

  it("owner loads the people list", async () => {
    const { calls } = boot(owner);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/users")).toBe(true));
  });

  it("/analytics shows its coming-soon text", async () => {
    boot(member, {}, "/analytics");
    expect(await screen.findByText("Clicks, countries, devices and referrers arrive in a later version.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Analytics/ }).getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["/agents", "Agent connections and API keys arrive in a later version."],
    ["/settings", "Instance settings and the first-run setup arrive in a later version."],
  ])("owner at %s sees its coming-soon text", async (path, text) => {
    boot(owner, {}, path);
    expect(await screen.findByText(text)).toBeTruthy();
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

  it("/api/me failing with network shows the signed-out copy", async () => {
    fakeApi({ "GET /api/me": () => { throw new TypeError("Failed to fetch"); } });
    render(<App />);
    expect(await screen.findByText("You are signed out. Reload the page to sign in.")).toBeTruthy();
  });

  it("a later API call failing with network shows the signed-out banner over the shell", async () => {
    boot(owner, { "GET /api/domains": () => { throw new TypeError("Failed to fetch"); } });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("You are signed out. Reload the page to sign in.");
    expect(screen.getByRole("navigation")).toBeTruthy();
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
