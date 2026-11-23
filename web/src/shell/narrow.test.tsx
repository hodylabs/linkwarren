import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { fakeApi } from "../test/fakeApi";
import { NARROW, PHONE } from "./narrow";
import { OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
const domain: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 2, isMember: false,
};
const mk = (id: string, slug: string): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, kind: "url", createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100,
});

/** Pretend the window matches these media queries. */
function viewport(matching: string[]) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matching.includes(q), media: q, addEventListener() {}, removeEventListener() {} }));
}

function boot(path = "/links") {
  history.replaceState(null, "", path);
  fakeApi({
    "GET /api/me": () => ({ body: owner }),
    "GET /api/domains": () => ({ body: [domain] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [mk("l1", "spring"), mk("l2", "menu")], next: null } }),
  });
  const user = userEvent.setup();
  render(<App />);
  return user;
}
const rows = () => screen.getAllByRole("row").slice(1);
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const panel = () => screen.queryByRole("complementary", { name: "Selected link" });
afterEach(() => vi.unstubAllGlobals());

describe("phone nav drawer", () => {
  it("opens from the menu button, traps focus, and Esc returns focus to the button", async () => {
    viewport([NARROW, PHONE]);
    const user = boot();
    await ready();
    expect(screen.queryByRole("link", { name: /Domains/ })).toBeNull(); // the nav lives in the drawer
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await user.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.querySelector(`#${menu.getAttribute("aria-controls")}`)).toBeTruthy();
    expect(document.activeElement).toBe(within(drawer).getByRole("link", { name: /Links/ }));
    // The domain switcher and the version stay reachable; sign-out is in the top bar's account menu (S12).
    expect(within(drawer).getByRole("button", { name: /Switch domain/ })).toBeTruthy();
    expect(within(drawer).getByText(/Version/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
    await user.tab({ shift: true }); // from the first item wraps to the last, the close button
    expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Close menu" }));
    await user.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
    // Shell keys work again once it is closed.
    await user.keyboard("gd");
    expect(location.pathname).toBe("/domains");
  });

  it("closes on navigation and on a backdrop tap", async () => {
    viewport([NARROW, PHONE]);
    const user = boot();
    await ready();
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: /Domains/ }));
    expect(location.pathname).toBe("/domains");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Menu" }));
    await user.click(within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: /Domains/ })); // the current page
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Menu" }).parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the palette gets a close button on phones", async () => {
    viewport([NARROW, PHONE]);
    const user = boot();
    await ready();
    await user.click(screen.getByRole("button", { name: /Search slugs/ }));
    await user.click(screen.getByRole("button", { name: "Close search and go" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("narrow list and detail", () => {
  it("a row opens the detail as a pushed view; Back returns to the list with the row selected and focused", async () => {
    viewport([NARROW]);
    const user = boot();
    await ready();
    expect(screen.getByRole("navigation", { name: "Screens" })).toBeTruthy(); // tablets keep the rail
    await user.click(rows()[1]!);
    expect(location.search).toBe("?sel=l2&view=detail");
    const back = screen.getByRole("button", { name: "All links" });
    expect(document.activeElement).toBe(back);
    expect(panel()).toBeTruthy();
    await user.click(back);
    await waitFor(() => expect(location.search).toBe("?sel=l2"));
    expect(screen.queryByRole("button", { name: "All links" })).toBeNull();
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
  });

  it("J in the detail then Back keeps the row the detail showed selected and focused", async () => {
    viewport([NARROW]);
    const user = boot();
    await ready();
    await user.click(rows()[0]!);
    expect(location.search).toBe("?sel=l1&view=detail");
    await user.keyboard("j");
    expect(location.search).toBe("?sel=l2&view=detail");
    await user.click(screen.getByRole("button", { name: "All links" }));
    await waitFor(() => expect(location.search).toBe("?sel=l2"));
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
  });

  it("browser back and Esc also return to the list", async () => {
    viewport([NARROW]);
    const user = boot();
    await ready();
    rows()[0]!.focus();
    await user.keyboard("{Enter}");
    expect(location.search).toBe("?sel=l1&view=detail");
    history.back();
    await waitFor(() => expect(location.search).toBe("?sel=l1"));
    await user.keyboard("{Enter}");
    expect(location.search).toBe("?sel=l1&view=detail");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(location.search).toBe("?sel=l1"));
  });

  it("a detail opened from a link (nothing to pop) goes back in place", async () => {
    viewport([NARROW]);
    const user = boot("/links?sel=l1&view=detail");
    await ready();
    await user.click(await screen.findByRole("button", { name: "All links" }));
    expect(location.search).toBe("?sel=l1");
  });
});

describe("desktop detail panel", () => {
  it("is absent without a selection, opens on a row, J/K keep it open, the X closes it and focuses the row", async () => {
    const user = boot();
    await ready();
    expect(panel()).toBeNull();
    await user.click(rows()[0]!);
    expect(location.search).toBe("?sel=l1"); // no pushed view on desktop
    expect(screen.queryByRole("button", { name: "All links" })).toBeNull();
    expect(panel()).toBeTruthy();
    await user.keyboard("j");
    expect(location.search).toBe("?sel=l2");
    expect(panel()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close link details" }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rows()[1]);
  });
});
