import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "../shell/Gate";
import { fakeApi } from "../test/fakeApi";
import { nav } from "./next";

vi.mock("@simplewebauthn/browser", () => ({ browserSupportsWebAuthn: () => true, startAuthentication: vi.fn(), startRegistration: vi.fn() }));

const owner = { id: "u1", email: "owner@example.com", name: null, role: "owner" as const, authMode: "app" as const, passkeys: 1 };
let assign: ReturnType<typeof vi.fn<(url: string) => void>>;
beforeEach(() => {
  history.replaceState(null, "", "/join");
  assign = vi.fn<(url: string) => void>();
  vi.spyOn(nav, "assign").mockImplementation(assign);
});
afterEach(() => vi.restoreAllMocks());
const app = () => render(<Gate>{() => <p>app</p>}</Gate>);

describe("/join signed out", () => {
  it("names the instance as text, focuses the heading, shows the normal sign-in and lands on /links", async () => {
    const api = fakeApi({
      "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated", signIn: "app", name: "<b>Acme</b>" } }),
      "POST /auth/email": () => ({ status: 202, body: { ok: true } }),
    });
    app();
    const h = await screen.findByRole("heading", { name: "You were invited to <b>Acme</b>" });
    expect(h.querySelector("b")).toBeNull();
    expect(document.activeElement).toBe(h);
    expect(screen.getByText("Sign in with the address the invite was sent to.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a passkey" })).toBeTruthy();
    await userEvent.setup().type(screen.getByLabelText("Email"), "a@example.com{Enter}");
    await screen.findByText("Check your email");
    expect(api.calls.find((c) => c.path === "/auth/email")?.body).toEqual({ email: "a@example.com", next: "/links" });
    expect(location.pathname).toBe("/join");
  });

  it("falls back to the host when the instance has no name", async () => {
    fakeApi({ "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated", signIn: "app" } }) });
    app();
    expect(await screen.findByRole("heading", { name: `You were invited to ${location.host}` })).toBeTruthy();
  });
});

describe("/join signed in", () => {
  it("shows who is signed in, never the app or the wizard; Continue goes to /links", async () => {
    fakeApi({ "GET /api/me": () => ({ body: owner }) });
    app();
    const h = await screen.findByRole("heading", { name: "You are signed in as owner@example.com" });
    expect(document.activeElement).toBe(h);
    expect(screen.getByText("If this invite was sent to another address, sign out first, then open the invite again.")).toBeTruthy();
    expect(screen.queryByText("app")).toBeNull();
    const cont = screen.getByRole("button", { name: /Continue as owner@example.com/ });
    expect(cont.getAttribute("aria-keyshortcuts")).toBe("Enter");
    await userEvent.setup().click(cont);
    expect(assign).toHaveBeenCalledWith("/links");
  });

  it("Sign out signs out, stays on /join and shows the signed-out state", async () => {
    let out = false;
    const api = fakeApi({
      "GET /api/me": () => (out ? { status: 401, body: { error: "unauthenticated", signIn: "app", name: "Acme" } } : { body: owner }),
      "POST /api/account/sign-out": () => { out = true; return { body: { ok: true } }; },
    });
    app();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "You were invited to Acme" })).toBeTruthy();
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/account/sign-out")).toBe(true);
    expect(location.pathname).toBe("/join");
    expect(assign).not.toHaveBeenCalled();
  });

  it("a failed sign-out says so and stays signed in", async () => {
    fakeApi({ "GET /api/me": () => ({ body: owner }), "POST /api/account/sign-out": () => ({ status: 500, body: { error: "internal" } }) });
    app();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "You are signed in as owner@example.com" })).toBeTruthy();
  });

  it("in access mode Sign out is the Access logout link", async () => {
    fakeApi({ "GET /api/me": () => ({ body: { ...owner, authMode: "access" } }) });
    app();
    await waitFor(() => expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout"));
  });
});
