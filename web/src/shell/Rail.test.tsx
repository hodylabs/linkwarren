import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { AppProvider, useApp } from "../state";
import { fakeApi } from "../test/fakeApi";
import { Rail } from "./Rail";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const base: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
afterEach(() => vi.unstubAllGlobals());

function boot(me: Me, signOut: () => { status: number; body?: unknown } = () => ({ status: 204 }), instance?: object) {
  const api = fakeApi({
    ...(instance ? { "GET /api/instance": () => ({ body: instance }) } : {}),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "POST /api/account/sign-out": signOut,
  });
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const Probe = () => <span>overlay:{useApp().overlay?.kind ?? "none"}</span>;
  render(<AppProvider me={me}><Rail /><Probe /></AppProvider>);
  return { api, assign, user: userEvent.setup() };
}

describe("Rail footer", () => {
  it("access mode keeps the Access link and has no account button", () => {
    boot({ ...base, authMode: "access" });
    expect(screen.getByText("Signed in with Cloudflare Access")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByRole("button", { name: "Sign-in and security" })).toBeNull();
  });
  it("a Me without a mode reads as access mode", () => {
    boot(base);
    expect(screen.getByRole("link", { name: "Sign out" })).toBeTruthy();
  });
  it("app mode shows both buttons; the first opens the sheet, Sign out posts once", async () => {
    const { api, assign, user } = boot({ ...base, authMode: "app" });
    expect(screen.getByText("Signed in to linkwarren")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign-in and security" }));
    expect(screen.getByText("overlay:account")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(api.calls.filter((c) => c.method === "POST" && c.path === "/api/account/sign-out")).toHaveLength(1);
  });
  it("a failed sign-out is announced inline and does not reload; a retry can succeed", async () => {
    let fail = true;
    const { api, assign, user } = boot({ ...base, authMode: "app" }, () => (fail ? { status: 500, body: { error: "internal" } } : { status: 204 }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong (internal)");
    expect(assign).not.toHaveBeenCalled();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(api.calls.filter((c) => c.path === "/api/account/sign-out")).toHaveLength(2);
  });
});

describe("Rail update notice", () => {
  const INST = { name: "", logoVersion: null, configured: true, dashboardHost: "links.example.com", mainDomainId: null, linkDefaults: { redirectCode: 302, passQuery: true } };
  const URL_ = "https://github.com/hodylabs/linkwarren/releases/tag/v0.4.0";
  it("shows a v0.4.0 available link to the release notes in a new tab, reachable by Tab", async () => {
    const { user } = boot(base, undefined, { ...INST, update: { current: "0.3.0", latest: "0.4.0", url: URL_ } });
    const a = await screen.findByRole("link", { name: "v0.4.0 available" });
    expect(a.getAttribute("href")).toBe(URL_);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.closest(".ver")?.textContent).toContain(`Dashboard v${__APP_VERSION__}`);
    for (let i = 0; i < 30 && document.activeElement !== a; i++) await user.tab();
    expect(document.activeElement).toBe(a);
  });
  it("nothing when update is null or missing", async () => {
    boot(base, undefined, { ...INST, update: null });
    await screen.findByText(`Dashboard v${__APP_VERSION__}`, { exact: false });
    await waitFor(() => expect(screen.queryByRole("link", { name: /available/ })).toBeNull());
  });
});

describe("Rail follows the role", () => {
  const nav = () => screen.getAllByRole("navigation", { name: "Screens" })[0]!;
  const items = () => [...nav().querySelectorAll("a, .nav-sep")].map((e) => e.textContent);
  it("a Member gets today's rail and the role name", () => {
    boot({ ...base, id: "um", role: "member", ...MEMBER_ROLE });
    expect(items()).toEqual(["LinksG L", "QR codesG Q", "DomainsG D", "AnalyticsG A", "API & agentsG I"]);
    expect(screen.getByText("Member")).toBeTruthy();
  });
  it("the owner keeps the Owner group", () => {
    boot(base);
    expect(items()).toEqual(["LinksG L", "QR codesG Q", "DomainsG D", "AnalyticsG A", "Owner", "People & audit logG P", "API & agentsG I", "SettingsG S"]);
  });
  it("a custom role shows its name and only the screens it may open", () => {
    boot({ ...base, id: "uh", ...customRole(["settings"], "Site admin") });
    expect(items()).toEqual(["LinksG L", "DomainsG D", "AnalyticsG A", "Manage", "API & agentsG I", "SettingsG S"]);
    expect(screen.getByText("Site admin")).toBeTruthy();
  });
});
