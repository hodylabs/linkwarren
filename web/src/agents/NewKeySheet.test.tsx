import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, KeyItem, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi } from "../test/fakeApi";

const member: Me = { id: "um", email: "m@example.com", name: "Mia", role: "member" };
const dom = (id: string, host: string, o: Partial<Domain> = {}): Domain => ({
  id, host, type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false, ...o,
});
const KEY: KeyItem = { id: "k1", userId: "um", userEmail: null, name: "zap-1", prefix: "lw_abcdefg", write: true, del: true, domainIds: ["d1"], createdAt: 1, lastUsedAt: null, expiresAt: 2 };
const SECRET = "lw_secretsecretsecretsecretsecretsecretsecre";

function boot() {
  history.replaceState(null, "", "/agents");
  const api = fakeApi({
    "GET /api/me": () => ({ body: member }),
    // d3 is someone else's shared domain the member is not on: not usable, so no chip.
    "GET /api/domains": () => ({ body: [dom("d1", "go.test"), dom("d2", "team.test", { type: "shared", isMember: true }), dom("d3", "other.test", { type: "shared" })] }),
    "GET /api/agents/connections": () => ({ body: { items: [] } }),
    "GET /api/keys": () => ({ body: { items: [] } }),
    "POST /api/keys": () => ({ status: 201, body: { key: KEY, secret: SECRET } }),
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const openSheet = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByText("No API keys yet.");
  await user.keyboard("n");
  return screen.findByRole("dialog", { name: "New API key" });
};
const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST" && c.path === "/api/keys");
afterEach(() => vi.unstubAllGlobals());

describe("New API key sheet", () => {
  it("Ctrl+Enter posts the exact body", async () => {
    const { api, user } = boot();
    const dlg = await openSheet(user);
    expect(within(dlg).queryByRole("button", { name: "other.test" })).toBeNull();
    await user.type(within(dlg).getByLabelText("Name"), "zap-1");
    await user.click(within(dlg).getByRole("radio", { name: "Read and write" }));
    await user.click(within(dlg).getByLabelText("Also allow deleting links"));
    await user.click(within(dlg).getByRole("button", { name: "go.test" }));
    expect(within(dlg).getByRole("button", { name: "All domains I can use" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(within(dlg).getByRole("radio", { name: "30 days" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ name: "zap-1", write: true, del: true, domainIds: ["d1"], expiresInDays: 30 });
  });

  it("defaults: read only, all domains, 90 days", async () => {
    const { api, user } = boot();
    const dlg = await openSheet(user);
    await user.type(within(dlg).getByLabelText("Name"), "ci");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)[0]?.body).toEqual({ name: "ci", write: false, del: false, domainIds: [], expiresInDays: 90 }));
  });

  it("an invalid name shows the error and blocks submit", async () => {
    const { api, user } = boot();
    const dlg = await openSheet(user);
    await user.type(within(dlg).getByLabelText("Name"), "Bad Name");
    const err = within(dlg).getByText(errorText("key_name"));
    expect(within(dlg).getByLabelText("Name").getAttribute("aria-describedby")).toBe(err.id);
    expect(err.id).not.toBe("");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
  });

  it("the delete box is disabled with read only", async () => {
    const { user } = boot();
    const dlg = await openSheet(user);
    const box = within(dlg).getByLabelText("Also allow deleting links") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    await user.click(within(dlg).getByRole("radio", { name: "Read and write" }));
    expect(box.disabled).toBe(false);
  });

  it("shows the secret once; it is gone after Done and reopening", async () => {
    const { user } = boot();
    let dlg = await openSheet(user);
    await user.type(within(dlg).getByLabelText("Name"), "zap-1");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(dlg).findByText("Copy your key now. It is shown only once.")).toBeTruthy();
    expect(within(dlg).getByText(SECRET)).toBeTruthy();
    expect(location.href).not.toContain(SECRET);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await user.keyboard("c");
    expect(writeText).toHaveBeenCalledWith(SECRET);
    await user.click(within(dlg).getByRole("button", { name: /^Done/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New API key" })).toBeNull());
    expect(screen.queryByText(SECRET)).toBeNull();
    dlg = await openSheet(user);
    expect(within(dlg).queryByText(SECRET)).toBeNull();
    expect((within(dlg).getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("Esc before copying asks first", async () => {
    const { user } = boot();
    const dlg = await openSheet(user);
    await user.type(within(dlg).getByLabelText("Name"), "zap-1");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await within(dlg).findByText(SECRET);
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("dialog", { name: "Close without copying?" });
    await user.click(within(ask).getByRole("button", { name: /^Close/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New API key" })).toBeNull());
    expect(screen.queryByText(SECRET)).toBeNull();
  });
});
