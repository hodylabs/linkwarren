import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { AppProvider, useApp } from "../state";
import { fakeApi } from "../test/fakeApi";
import { Rail } from "./Rail";

const base: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
afterEach(() => vi.unstubAllGlobals());

function boot(me: Me, signOut: () => { status: number; body?: unknown } = () => ({ status: 204 })) {
  const api = fakeApi({
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
