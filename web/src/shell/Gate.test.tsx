import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { nav } from "../signin/next";
import { fakeApi } from "../test/fakeApi";
import { Gate } from "./Gate";

vi.mock("@simplewebauthn/browser", () => ({ browserSupportsWebAuthn: () => true, startAuthentication: vi.fn(), startRegistration: vi.fn() }));

const me = { id: "u1", email: "a@example.com", name: null, role: "member" as const, authMode: "app" as const, passkeys: 1 };

describe("Gate", () => {
  it("401 with signIn app shows the sign-in form in place, email focused", async () => {
    history.replaceState(null, "", "/links?q=x");
    fakeApi({ "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated", signIn: "app" } }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    const email = await screen.findByLabelText("Email");
    expect(document.activeElement).toBe(email);
    expect(location.pathname + location.search).toBe("/links?q=x");
    expect(screen.queryByText("app")).toBeNull();
  });

  it("401 without signIn keeps the Access copy", async () => {
    fakeApi({ "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated" } }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    expect(await screen.findByText("You are signed out. Reload the page to sign in.")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("signed in at /sign-in?next=/domains goes to /domains", async () => {
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => {});
    history.replaceState(null, "", "/sign-in?next=%2Fdomains");
    fakeApi({ "GET /api/me": () => ({ body: me }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/domains"));
    expect(screen.queryByText("app")).toBeNull();
  });

  it("signed in at /sign-in without next goes to /", async () => {
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => {});
    history.replaceState(null, "", "/sign-in");
    fakeApi({ "GET /api/me": () => ({ body: me }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("signed in elsewhere renders the app", async () => {
    history.replaceState(null, "", "/links");
    fakeApi({ "GET /api/me": () => ({ body: me }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    expect(await screen.findByText("app")).toBeTruthy();
  });
});
