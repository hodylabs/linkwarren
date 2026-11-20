import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Me, UserItem } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const dom = (id: string, host: string, type: Domain["type"]): Domain => ({
  id, host, type, status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: true,
});
const MAIN = dom("d1", "go.test", "main");
const SHARED = dom("d2", "nw.test", "shared");
const user = (id: string, email: string, o: Partial<UserItem> = {}): UserItem => ({
  id, email, name: null, role: "member", status: "active", createdAt: 1, linkCount: 0, domains: [], ...o,
});
const UA = user("ua", "a@example.com", { name: "Ann" });
const UB = user("ub", "b@example.com", { status: "disabled", domains: [{ id: "d2", host: "nw.test", via: "member" }] });
const OWNER_U = user("uo", "owner@example.com", { role: "owner" });

function boot(path: string, me: Me = owner, routes: FakeRoutes = {}) {
  history.replaceState(null, "", path);
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [MAIN, SHARED] }),
    "GET /api/users": () => ({ body: { items: [OWNER_U, UA, UB] } }),
    ...routes,
  });
  const u = userEvent.setup();
  render(<App />);
  return { api, u };
}
const puts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "PUT");
afterEach(() => vi.unstubAllGlobals());

describe("Members editor", () => {
  it("Space on a switch then Ctrl+Enter sends the full set", async () => {
    const { api, u } = boot("/domains?sel=d2", owner, { "PUT /api/domains/d2/members": () => ({ body: {} }) });
    const a = await screen.findByRole("switch", { name: "Ann" });
    expect(screen.getByRole("switch", { name: /b@example.com \(disabled\)/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: /Olive|owner@example.com/ })).toBeNull();
    a.focus();
    await u.keyboard(" ");
    await u.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]!.body).toEqual({ userIds: ["ua", "ub"] });
    expect(await screen.findByText("Members saved")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/api/users").length).toBeGreaterThan(1);
  });

  it("Ctrl+Enter inside the members section does not save the domain settings", async () => {
    const { api, u } = boot("/domains?sel=d2", owner, { "PUT /api/domains/d2/members": () => ({ body: {} }) });
    (await screen.findByRole("switch", { name: "Ann" })).focus();
    await u.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("unknown_user shows the copy and keeps the choices", async () => {
    const { u } = boot("/domains?sel=d2", owner, { "PUT /api/domains/d2/members": () => ({ status: 400, body: { error: "unknown_user" } }) });
    const a = await screen.findByRole("switch", { name: "Ann" });
    a.focus();
    await u.keyboard(" {Control>}{Enter}{/Control}");
    expect(await screen.findByText(errorText("unknown_user"))).toBeTruthy();
    expect(a.getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    ["still loading", () => new Promise<never>(() => {})],
    ["failed", () => ({ status: 500, body: { error: "internal" } })],
  ] as const)("no PUT while the user list is %s: Save is disabled and Ctrl+Enter does nothing", async (_, users) => {
    const { api, u } = boot("/domains?sel=d2", owner, { "GET /api/users": users, "PUT /api/domains/d2/members": () => ({ body: {} }) });
    const btn = await screen.findByRole("button", { name: /Save members/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await u.click(btn);
    fireEvent.keyDown(screen.getByText("Who can use it"), { key: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(puts(api)).toHaveLength(0);
  });

  it("a switch changed while the save is pending survives the refresh", async () => {
    let release!: () => void;
    let saved = false;
    const { u } = boot("/domains?sel=d2", owner, {
      "GET /api/users": () => ({ body: { items: [OWNER_U, saved ? { ...UA, domains: [{ id: "d2", host: "nw.test", via: "member" as const }] } : UA, UB] } }),
      "PUT /api/domains/d2/members": () => new Promise((r) => (release = () => { saved = true; r({ body: {} }); })),
    });
    const a = await screen.findByRole("switch", { name: "Ann" });
    const b = screen.getByRole("switch", { name: /b@example.com/ });
    a.focus();
    await u.keyboard(" {Control>}{Enter}{/Control}");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    b.focus();
    await u.keyboard(" "); // turn B off after the request was sent
    release();
    expect(await screen.findByText("Members saved")).toBeTruthy();
    await waitFor(() => expect(a.getAttribute("aria-checked")).toBe("true"));
    await new Promise((r) => setTimeout(r, 20));
    expect(b.getAttribute("aria-checked")).toBe("false");
  });

  it("the main domain says Everyone and has no switches", async () => {
    boot("/domains?sel=d1");
    expect(await screen.findByText("Everyone can use the main domain.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Ann" })).toBeNull();
  });

  it("renders nothing for a member viewer", async () => {
    boot("/domains?sel=d2", member);
    await screen.findByRole("complementary", { name: "Selected domain" });
    expect(screen.queryByText("Who can use it")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save members/ })).toBeNull();
  });
});
