import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PasskeyItem, SessionItem } from "../api";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { AccountPanel } from "./AccountPanel";

const wa = vi.hoisted(() => ({ startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ browserSupportsWebAuthn: () => true, startRegistration: wa.startRegistration }));
const named = (name: string) => Object.assign(new Error(name), { name });

const pk = (id: string, name: string, o: Partial<PasskeyItem> = {}): PasskeyItem => ({ id, name, createdAt: 1_700_000_000, lastUsedAt: null, backedUp: false, ...o });
const ses = (id: string, o: Partial<SessionItem> = {}): SessionItem => ({
  id, current: false, method: "email", createdAt: 1_700_000_000, lastSeenAt: 1_700_000_100, device: "Firefox on Linux", ipPrefix: "203.0.113.0/24", ...o,
});
const account = { passkeys: [pk("p1", "Laptop", { backedUp: true }), pk("p2", "Phone", { lastUsedAt: 1_700_000_050 })], sessions: [ses("s1", { current: true, method: "passkey" }), ses("s2", { device: null })] };

const assign = vi.fn();
beforeEach(() => {
  assign.mockClear();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

async function boot(routes: FakeRoutes = {}) {
  const api = fakeApi({ "GET /api/account": () => ({ body: account }), ...routes });
  const user = userEvent.setup();
  render(<AccountPanel />);
  await screen.findByText("Laptop");
  return { api, user };
}
const shiftD = "{Shift>}d{/Shift}";
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");

describe("AccountPanel", () => {
  it("lists passkeys and sessions with one This device tag", async () => {
    await boot();
    expect(screen.getAllByText("This device")).toHaveLength(1);
    expect(screen.getByText("Synced")).toBeTruthy();
    expect(screen.getByText(/Never used/)).toBeTruthy();
    expect(screen.getByText(/Last used/)).toBeTruthy();
    expect(screen.getByText("Unknown device")).toBeTruthy();
    expect(screen.getByText(/with a passkey/)).toBeTruthy();
    expect(screen.getByText(/with an email link/)).toBeTruthy();
    expect(screen.getAllByText("203.0.113.0/24")).toHaveLength(2);
  });

  it("J then R renames: typing letters stays text, Enter sends PATCH { name }", async () => {
    const { api, user } = await boot({ "PATCH /api/account/passkeys/p1": ({ body }) => ({ body: { ...pk("p1", "x"), ...(body as object) } }) });
    await user.keyboard("j");
    await user.keyboard("r");
    const input = await screen.findByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Desk jrka"); // j, r, k, a are hotkeys outside inputs
    expect((input as HTMLInputElement).value).toBe("Desk jrka");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([{ method: "PATCH", path: "/api/account/passkeys/p1", body: { name: "Desk jrka" } }]));
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("Esc in the rename box cancels and sends nothing", async () => {
    const { api, user } = await boot();
    await user.keyboard("jr");
    await screen.findByLabelText("Name");
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(writes(api)).toEqual([]);
  });

  it("Shift+D on a passkey: Esc sends nothing, Enter sends DELETE", async () => {
    const { api, user } = await boot({ "DELETE /api/account/passkeys/p1": () => ({ status: 204 }) });
    await user.keyboard("j");
    await user.keyboard(shiftD);
    const dlg = await screen.findByRole("dialog", { name: "Remove passkey" });
    expect(within(dlg).getByText("Remove Laptop? You can still sign in with an email link.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Remove passkey" })).toBeNull();
    expect(writes(api)).toEqual([]);
    await user.keyboard(shiftD);
    await screen.findByRole("dialog", { name: "Remove passkey" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([{ method: "DELETE", path: "/api/account/passkeys/p1", body: undefined }]));
  });

  it("Shift+D on the current session does nothing", async () => {
    const { api, user } = await boot();
    await user.keyboard("jjj"); // p1, p2, s1 (current)
    await user.keyboard(shiftD);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^End/ })).toBeNull();
    expect(writes(api)).toEqual([]);
  });

  it("Shift+D on another session confirms, then Enter sends DELETE", async () => {
    const { api, user } = await boot({ "DELETE /api/account/sessions/s2": () => ({ status: 204 }) });
    await user.keyboard("jjjj");
    await user.keyboard(shiftD);
    expect(within(await screen.findByRole("dialog", { name: "End session" })).getByText("Sign out Unknown device?")).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(writes(api)).toEqual([{ method: "DELETE", path: "/api/account/sessions/s2", body: undefined }]));
  });

  it("Sign out everywhere: Esc cancels, Enter posts once and goes to /", async () => {
    const { api, user } = await boot({ "POST /api/account/sign-out-everywhere": () => ({ status: 204 }) });
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    expect(screen.getByText("Sign out on every device, including this one?")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(writes(api)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(writes(api)).toHaveLength(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("A with passkey_limit shows its copy", async () => {
    const { user } = await boot({ "POST /api/account/passkeys/options": () => ({ status: 409, body: { error: "passkey_limit" } }) });
    await user.keyboard("a");
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 10 passkeys\. Remove one first\./);
  });

  it.each([
    ["NotAllowedError", "Adding a passkey was cancelled."],
    ["AbortError", "Adding a passkey was cancelled."],
    ["InvalidStateError", "This device already has a passkey for this account."],
    ["SecurityError", "That passkey did not work here. Try again or use an email link."],
  ])("A with a browser %s shows its own copy", async (name, text) => {
    wa.startRegistration.mockRejectedValue(named(name));
    const { api, user } = await boot({ "POST /api/account/passkeys/options": () => ({ body: { challenge: "c" } }) });
    await user.keyboard("a");
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(writes(api).map((c) => c.path)).toEqual(["/api/account/passkeys/options"]);
  });

  it("server text is rendered as text", async () => {
    fakeApi({ "GET /api/account": () => ({ body: { passkeys: [pk("p1", "<img src=x onerror=alert(1)>")], sessions: [] } }) });
    render(<AccountPanel />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});
