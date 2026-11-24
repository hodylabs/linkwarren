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

describe("AccountPanel connected sign-ins (S14)", () => {
  const IDS = { items: [{ provider: "google", email: "a@example.com", createdAt: 1_700_000_000, lastUsedAt: null }, { provider: "oidc", email: "a@example.com", createdAt: 1_700_000_000, lastUsedAt: 1_700_000_050 }] };

  it("lists linked providers; none (or an older server) shows no section", async () => {
    await boot({ "GET /api/account/identities": () => ({ body: IDS }) });
    const list = await screen.findByRole("list", { name: "Connected sign-ins" });
    expect(within(list).getByText("Google")).toBeTruthy();
    expect(within(list).getByText("Single sign-on")).toBeTruthy();
    expect(within(list).getAllByText("a@example.com")).toHaveLength(2);
  });

  it.each([
    ["an empty list", () => ({ body: { items: [] } })],
    ["an older server (404)", () => ({ status: 404, body: { error: "not_found" } })],
  ])("no identities from %s: no Connected sign-ins section", async (_, answer) => {
    const { api } = await boot({ "GET /api/account/identities": answer });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/account/identities")).toBe(true));
    await new Promise((r) => setTimeout(r, 20)); // let the answer settle before checking that nothing appeared
    expect(screen.queryByText("Connected sign-ins")).toBeNull();
  });

  it("an unlink that succeeds removes the row even when the refresh fails, and keeps focus in the panel", async () => {
    let gets = 0;
    const { user } = await boot({
      "GET /api/account/identities": () => (++gets === 1 ? { body: IDS } : { status: 500, body: { error: "internal" } }),
      "DELETE /api/account/identities/google": () => ({ status: 204 }),
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink Google" })).toBeNull());
    expect(screen.getByRole("button", { name: "Unlink Single sign-on" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Unlink Single sign-on" })));
  });

  it("an unlink cancelled while pending does not move focus when it finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gone = false;
    const { user } = await boot({
      "GET /api/account/identities": () => ({ body: gone ? { items: IDS.items.filter((i) => i.provider !== "google") } : IDS }),
      "DELETE /api/account/identities/google": async () => {
        await gate;
        gone = true;
        return { status: 204 };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    const other = screen.getByText("Laptop").closest("li")!; // a row stays focusable while the write is pending
    other.focus();
    expect(document.activeElement).toBe(other);
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink Google" })).toBeNull());
    expect(document.activeElement).toBe(other);
  });

  it("a 404 unlink (already gone) removes the row", async () => {
    let gone = false;
    const { user } = await boot({
      "GET /api/account/identities": () => ({ body: gone ? { items: IDS.items.filter((i) => i.provider !== "google") } : IDS }),
      "DELETE /api/account/identities/google": () => {
        gone = true; // unlinked in another tab before this one asked
        return { status: 404, body: { error: "not_found" } };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink Google" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("while an unlink is pending, no other dialog opens", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user } = await boot({
      "GET /api/account/identities": () => ({ body: IDS }),
      "DELETE /api/account/identities/google": async () => {
        await gate;
        return { status: 403, body: { error: "sso_required" } };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    await user.click(screen.getByText("Laptop"));
    await user.keyboard("{Shift>}d{/Shift}");
    expect(screen.queryByRole("heading", { name: "Remove passkey" })).toBeNull();
    release();
    await screen.findByRole("alert");
  });

  it("Unlink asks, then deletes and reloads the list", async () => {
    let items = IDS.items;
    const { api, user } = await boot({
      "GET /api/account/identities": () => ({ body: { items } }),
      "DELETE /api/account/identities/google": () => {
        items = items.filter((i) => i.provider !== "google");
        return { status: 204 };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    expect(screen.getByText(/Unlink Google \(a@example.com\)\?/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink Google" })).toBeNull());
    expect(writes(api)).toEqual([{ method: "DELETE", path: "/api/account/identities/google", body: undefined }]);
  });

  it("an unlink refused with sso_required says why", async () => {
    const { user } = await boot({
      "GET /api/account/identities": () => ({ body: IDS }),
      "DELETE /api/account/identities/oidc": () => ({ status: 409, body: { error: "sso_required" } }),
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Single sign-on" }));
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Your email domain requires single sign-on, so this sign-in cannot be unlinked.");
  });

  it("a session started with Google says so", async () => {
    await boot({ "GET /api/account": () => ({ body: { passkeys: account.passkeys, sessions: [ses("s9", { method: "google" as SessionItem["method"] })] } }) });
    expect(screen.getByText(/with Google/)).toBeTruthy();
  });
});

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

  it("rows are reachable by Tab and Enter selects, revealing actions", async () => {
    const { user } = await boot();
    await user.tab();
    expect(document.activeElement?.getAttribute("class")).toContain("acct-row");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /^Rename/ })).toBeTruthy();
  });

  it("a late rename answer does not close a newer rename dialog", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user } = await boot({ "PATCH /api/account/passkeys/p1": async () => { await gate; return { body: pk("p1", "A") }; } });
    await user.keyboard("jr");
    await user.keyboard("{Enter}"); // save p1: pending
    await user.keyboard("{Escape}");
    await user.keyboard("jr"); // a new dialog, for p2
    const input = await screen.findByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Second");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Second");
  });

  it("an older refresh does not replace newer account data", async () => {
    let calls = 0;
    const slow: { resolve?: () => void } = {};
    const { user } = await boot({
      "GET /api/account": async () => {
        if (++calls === 1) return { body: account };
        if (calls === 2) { await new Promise<void>((r) => (slow.resolve = r)); return { body: account }; }
        return { body: { ...account, passkeys: [pk("p1", "Renamed")] } };
      },
      "PATCH /api/account/passkeys/p1": () => ({ body: pk("p1", "Renamed") }),
    });
    await user.keyboard("jr");
    await user.keyboard("{Enter}"); // refresh #2 (slow)
    await waitFor(() => expect(calls).toBe(2));
    await user.keyboard("r"); // p1 is still selected
    await user.keyboard("{Enter}"); // refresh #3 (fast, newer)
    await waitFor(() => expect(calls).toBe(3));
    await screen.findByText("Renamed");
    slow.resolve!();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Renamed")).toBeTruthy();
    expect(screen.queryByText("Laptop")).toBeNull();
  });
});
