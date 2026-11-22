import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "../shell/Gate";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { nav } from "./next";
import { SignIn } from "./SignIn";

const wa = vi.hoisted(() => ({ supported: true, startAuthentication: vi.fn(), startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => wa.supported,
  startAuthentication: wa.startAuthentication,
  startRegistration: wa.startRegistration,
}));

const TOKEN = "A".repeat(42) + "b";
const me = (passkeys: number) => ({ id: "u1", email: "a@example.com", name: null, role: "member", authMode: "app", passkeys });
let assign: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  wa.supported = true;
  wa.startAuthentication.mockReset();
  wa.startRegistration.mockReset();
  assign = vi.fn<(url: string) => void>();
  vi.spyOn(nav, "assign").mockImplementation(assign);
});
afterEach(() => vi.restoreAllMocks());

const notAllowed = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

function form(routes: FakeRoutes = {}) {
  const api = fakeApi(routes);
  render(<SignIn next="/links" />);
  return { api, user: userEvent.setup() };
}

describe("SignIn form", () => {
  it("Enter posts the email and next, then shows the Sent copy; Esc returns with the address kept", async () => {
    const { api, user } = form({ "POST /auth/email": () => ({ status: 202, body: { ok: true } }) });
    expect(screen.getByRole("heading", { name: `Sign in to ${location.host}` })).toBeTruthy();
    await user.type(screen.getByLabelText("Email"), "a@example.com{Enter}");
    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(screen.getByText("If a@example.com can sign in here, a link is on its way. It works once, for 15 minutes.")).toBeTruthy();
    expect(api.calls).toEqual([{ method: "POST", path: "/auth/email", body: { email: "a@example.com", next: "/links" } }]);
    await user.keyboard("{Escape}");
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect(email.value).toBe("a@example.com");
    expect(document.activeElement).toBe(email);
  });

  it("429 shows too_many_attempts", async () => {
    const { user } = form({ "POST /auth/email": () => ({ status: 429, body: { error: "too_many_attempts" } }) });
    await user.type(screen.getByLabelText("Email"), "a@example.com{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many tries. Wait 15 minutes and try again.");
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("the email input is a 16 px username email field; Tab order is email, send, passkey", async () => {
    const { user } = form();
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.autocomplete).toBe("username");
    expect(document.activeElement).toBe(email);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Send me a sign-in link/ }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use a passkey" }));
  });

  it("an unsupported browser hides the passkey button", () => {
    wa.supported = false;
    form();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
  });

  it("the passkey button posts options then verify and goes to next", async () => {
    wa.startAuthentication.mockResolvedValue({ id: "cred" });
    const { api, user } = form({
      "POST /auth/passkey/options": () => ({ body: { challenge: "c" } }),
      "POST /auth/passkey/verify": () => ({ body: { next: "/links" } }),
    });
    await user.click(screen.getByRole("button", { name: "Use a passkey" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/links"));
    expect(wa.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "c" } });
    expect(api.calls.map((c) => [c.path, c.body])).toEqual([
      ["/auth/passkey/options", {}],
      ["/auth/passkey/verify", { response: { id: "cred" }, next: "/links" }],
    ]);
  });

  it("a cancelled passkey shows passkey_cancelled and sends no verify", async () => {
    wa.startAuthentication.mockRejectedValue(notAllowed());
    const { api, user } = form({ "POST /auth/passkey/options": () => ({ body: { challenge: "c" } }) });
    await user.click(screen.getByRole("button", { name: "Use a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Passkey sign-in was cancelled.");
    expect(api.calls.map((c) => c.path)).toEqual(["/auth/passkey/options"]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("a rejected passkey shows passkey_failed", async () => {
    wa.startAuthentication.mockResolvedValue({ id: "cred" });
    const { user } = form({
      "POST /auth/passkey/options": () => ({ body: { challenge: "c" } }),
      "POST /auth/passkey/verify": () => ({ status: 400, body: { error: "passkey_failed" } }),
    });
    await user.click(screen.getByRole("button", { name: "Use a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That passkey did not work here. Try again or use an email link.");
  });
});

function landing(routes: FakeRoutes) {
  history.replaceState(null, "", `/sign-in#token=${TOKEN}`);
  const seen: number[] = [];
  const api = fakeApi(routes);
  const replace = vi.spyOn(history, "replaceState");
  replace.mockImplementation(function (this: History, ...a: Parameters<History["replaceState"]>) {
    seen.push(api.calls.length);
    return History.prototype.replaceState.apply(this, a);
  });
  render(<Gate>{() => <p>app</p>}</Gate>);
  return { api, seen, user: userEvent.setup() };
}

const verifyOk = (next: string, passkeys: number): FakeRoutes => ({
  "POST /auth/email/verify": () => ({ body: { next } }),
  "GET /api/me": () => ({ body: me(passkeys) }),
});

describe("SignIn landing", () => {
  it("drops the token from the URL before any request and sends nothing until Enter", async () => {
    const { api, seen, user } = landing(verifyOk("/links", 2));
    expect(seen[0]).toBe(0);
    expect(location.pathname + location.search + location.hash).toBe("/sign-in");
    expect(screen.getByText("This link works once.")).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(api.calls).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sign in/ }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Signed in as/)).toBeTruthy();
    expect(api.calls[0]).toEqual({ method: "POST", path: "/auth/email/verify", body: { token: TOKEN } });
    expect(JSON.stringify(api.calls.slice(1))).not.toContain(TOKEN);
  });

  it("success shows who is signed in; with passkeys Continue goes to next", async () => {
    const { user } = landing(verifyOk("/domains", 2));
    await user.keyboard("{Enter}");
    expect((await screen.findByText(/Signed in as/)).textContent).toBe("Signed in as a@example.com");
    expect(assign).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Continue/ }));
    await user.keyboard("{Enter}");
    expect(assign).toHaveBeenCalledWith("/domains");
  });

  it("Not you? Sign out posts sign-out and shows the form", async () => {
    const { api, user } = landing({ ...verifyOk("/domains", 2), "POST /api/account/sign-out": () => ({ status: 204 }) });
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Not you? Sign out" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/account/sign-out" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("with no passkeys Continue shows the Offer; Esc goes to the returned next", async () => {
    const { user } = landing(verifyOk("/domains", 0));
    await user.keyboard("{Enter}");
    await screen.findByText(/Signed in as/);
    await user.keyboard("{Enter}");
    expect(await screen.findByText("You are signed in. Add a passkey to sign in with one tap next time.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Add a passkey/ }));
    await user.keyboard("{Escape}");
    expect(assign).toHaveBeenCalledWith("/domains");
  });

  it("Add a passkey registers one and goes to next", async () => {
    wa.startRegistration.mockResolvedValue({ id: "new" });
    const { api, user } = landing({
      ...verifyOk("/domains", 0),
      "POST /api/account/passkeys/options": () => ({ body: { challenge: "r" } }),
      "POST /api/account/passkeys": () => ({ status: 201, body: { id: "p1", name: "Passkey", createdAt: 1, lastUsedAt: null, backedUp: false } }),
    });
    await user.keyboard("{Enter}");
    await screen.findByText(/Signed in as/);
    await user.keyboard("{Enter}");
    await screen.findByText(/Add a passkey to sign in/);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/domains"));
    expect(wa.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "r" } });
    expect(api.calls.at(-1)).toMatchObject({ path: "/api/account/passkeys", body: { response: { id: "new" } } });
  });

  it("an unsupported browser skips the Offer", async () => {
    wa.supported = false;
    const { user } = landing(verifyOk("/domains", 0));
    await user.keyboard("{Enter}");
    await screen.findByText(/Signed in as/);
    await user.keyboard("{Enter}");
    expect(assign).toHaveBeenCalledWith("/domains");
  });

  it("a returned next of //evil.example goes to /", async () => {
    const { user } = landing(verifyOk("//evil.example", 2));
    await user.keyboard("{Enter}");
    await screen.findByText(/Signed in as/);
    await user.keyboard("{Enter}");
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("link_invalid shows its copy above the form", async () => {
    const { user } = landing({ "POST /auth/email/verify": () => ({ status: 400, body: { error: "link_invalid" } }) });
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("This sign-in link has expired or was already used. Ask for a new one.");
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("verify ok but /api/me failing still says signed in, with Continue and no sign-out or offer", async () => {
    const { user } = landing({ "POST /auth/email/verify": () => ({ body: { next: "/domains" } }), "GET /api/me": () => ({ status: 500, body: { error: "internal" } }) });
    await user.keyboard("{Enter}");
    expect(await screen.findByText("You are signed in.")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Not you? Sign out" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(assign).toHaveBeenCalledWith("/domains");
  });

  it("cancelling the Offer prompt says adding was cancelled, not sign-in", async () => {
    wa.startRegistration.mockRejectedValue(notAllowed());
    const { user } = landing({ ...verifyOk("/domains", 0), "POST /api/account/passkeys/options": () => ({ body: { challenge: "r" } }) });
    await user.keyboard("{Enter}");
    await screen.findByText(/Signed in as/);
    await user.keyboard("{Enter}");
    await screen.findByText(/Add a passkey to sign in/);
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Adding a passkey was cancelled.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("a token that is not 43 characters is dropped from the URL and explained above the form", async () => {
    history.replaceState(null, "", "/sign-in#token=" + "A".repeat(20));
    const api = fakeApi({ "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated", signIn: "app" } }) });
    render(<Gate>{() => <p>app</p>}</Gate>);
    expect((await screen.findByRole("alert")).textContent).toBe("This sign-in link is incomplete. Copy the whole link from the email, or ask for a new one.");
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(location.hash).toBe("");
    expect(JSON.stringify(api.calls)).not.toContain("AAAA");
  });

  it("after the token is used, Gate no longer holds it: a failed verify shows the form and a second send has no token", async () => {
    const { api, user } = landing({ "POST /auth/email/verify": () => ({ status: 400, body: { error: "link_invalid" } }), "POST /auth/email": () => ({ status: 202, body: { ok: true } }) });
    await user.keyboard("{Enter}");
    await screen.findByText(/expired or was already used/);
    await user.type(screen.getByLabelText("Email"), "a@example.com{Enter}");
    await screen.findByText("Check your email");
    expect(api.calls.filter((c) => JSON.stringify(c.body ?? "").includes(TOKEN))).toHaveLength(1);
    expect(api.calls.some((c) => c.path === "/api/me")).toBe(false);
  });
});
