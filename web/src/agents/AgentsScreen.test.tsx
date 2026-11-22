import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ConnectionItem, Domain, KeyItem, Me, UserItem } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { canText } from "./AgentsScreen";
import { HOWTO } from "./howto";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: "Mia", role: "member" };
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const MAIN: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false,
};
const conn = (o: Partial<ConnectionItem>): ConnectionItem => ({
  id: "c1", userId: "um", userEmail: null, clientName: "Claude", redirectHost: "claude.ai", write: false, del: false,
  createdAt: now - 3 * DAY, lastUsedAt: null, calls7d: 3, ...o,
});
const key = (o: Partial<KeyItem>): KeyItem => ({
  id: "k1", userId: "um", userEmail: null, name: "zapier", prefix: "lw_abcdefg", write: false, del: false, domainIds: [],
  createdAt: now - 50 * DAY, lastUsedAt: null, expiresAt: now + 40 * DAY, ...o,
});
const dana: UserItem = { id: "ud", email: "dana@example.com", name: "Dana R.", role: "member", roleId: "member", roleName: "Member", perms: [], status: "active", createdAt: 1, linkCount: 0, agentCount: 1, domains: [] };
const mcpUrl = () => `https://${location.host}/mcp`;

function boot(me: Me, routes: FakeRoutes = {}) {
  history.replaceState(null, "", "/agents");
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [MAIN] }),
    "GET /api/users": () => ({ body: { items: [dana] } }),
    "GET /api/agents/mcp": () => ({ body: { on: true, locked: false } }),
    "GET /api/agents/connections": () => ({ body: { items: [conn({})] } }),
    "GET /api/keys": () => ({ body: { items: [key({})] } }),
    "GET /api/agents/connections/c1/calls": () => ({ body: { items: [{ at: now, tool: "search_links", status: "ok" }, { at: now, tool: "delete_link", status: "refused" }] } }),
    ...routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const loaded = () => screen.findByRole("cell", { name: "zapier" });
afterEach(() => vi.unstubAllGlobals());

describe("API & agents screen", () => {
  it("a member sees only their own rows, all marked You", async () => {
    const { api } = boot(member);
    await loaded();
    expect(api.calls.some((c) => c.path === "/api/agents/connections")).toBe(true);
    expect(api.calls.some((c) => c.path === "/api/keys")).toBe(true);
    expect(api.calls.some((c) => c.path.includes("all=1"))).toBe(false);
    const rows = screen.getAllByRole("row").slice(1).filter((r) => within(r).queryAllByRole("cell").length > 0);
    for (const r of rows) expect(within(r).getAllByRole("cell")[1]!.textContent).toMatch(/You$/);
    expect(screen.getByRole("heading", { name: "API & agents" })).toBeTruthy();
  });

  it("the owner loads everyone with ?all=1 and sees the person", async () => {
    const { api } = boot(owner, {
      "GET /api/agents/connections": () => ({ body: { items: [conn({ userId: "ud", userEmail: "dana@example.com" }), conn({ id: "c2", userId: "uo", clientName: "Codex" })] } }),
    });
    await loaded();
    expect(api.calls.some((c) => c.path === "/api/agents/connections?all=1")).toBe(true);
    expect(api.calls.some((c) => c.path === "/api/keys?all=1")).toBe(true);
    expect(screen.getAllByText("Dana R.").length).toBeGreaterThan(0);
  });

  it("C copies the MCP address and announces it, but not inside an input", async () => {
    const { user } = boot(member);
    await loaded();
    expect(await screen.findByText(mcpUrl())).toBeTruthy();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("c");
    expect(writeText).not.toHaveBeenCalled();
    input.remove();
    await user.keyboard("c");
    expect(writeText).toHaveBeenCalledWith(mcpUrl());
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("arrow keys on the client chips switch the how-to text", async () => {
    const { user } = boot(member);
    await loaded();
    const claude = screen.getByRole("button", { name: "Claude" });
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(HOWTO.claude(mcpUrl()))).toBeTruthy();
    claude.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "ChatGPT" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(HOWTO.chatgpt(mcpUrl()))).toBeTruthy();
    expect(HOWTO.chatgpt(mcpUrl())).toContain("Add custom MCP server");
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText(`claude mcp add --transport http linkwarren ${mcpUrl()}`)).toBeTruthy();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    // Wraps from the first chip to the last: Gemini.
    expect(screen.getByRole("button", { name: "Gemini" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(`gemini mcp add --transport http linkwarren ${mcpUrl()}, then sign in when prompted`)).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText(`codex mcp add linkwarren --url ${mcpUrl()}, then codex mcp login linkwarren`)).toBeTruthy();
  });

  const sw = () => screen.findByRole("switch", { name: "Agent connections (MCP)" });
  const OLD_COPY = "The owner turns them on with MCP_ENABLED.";

  it("the owner's switch reflects the state, and Space turns it off and hides the address", async () => {
    const { api, user } = boot(owner, { "PUT /api/agents/mcp": () => ({ body: { on: false, locked: false } }) });
    const s = await sw();
    expect(s.getAttribute("aria-checked")).toBe("true");
    expect(s.getAttribute("aria-describedby")).toBeTruthy();
    expect(await screen.findByText(mcpUrl())).toBeTruthy();
    expect(screen.getByText("Turning this off does not disconnect agents. Their calls are refused until you turn it back on.")).toBeTruthy();
    s.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(screen.queryByText(mcpUrl())).toBeNull());
    expect(api.calls.find((c) => c.method === "PUT" && c.path === "/api/agents/mcp")?.body).toEqual({ on: false });
    expect(screen.getByText("Agent connections off")).toBeTruthy();
    expect((await sw()).getAttribute("aria-checked")).toBe("false");
  });

  it("one update at a time: a second press while the PUT is out sends nothing, and focus stays on the switch", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { api, user } = boot(owner, { "PUT /api/agents/mcp": async () => { await held; return { body: { on: false, locked: false } }; } });
    const s = (await sw()) as HTMLButtonElement;
    s.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(s.closest("fieldset")?.getAttribute("aria-busy")).toBe("true"));
    await user.keyboard(" ");
    await user.click(s);
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(document.activeElement).toBe(s);
    release();
    await waitFor(() => expect(s.getAttribute("aria-checked")).toBe("false"));
    expect(s.closest("fieldset")?.getAttribute("aria-busy")).toBe("false");
  });

  it("owner with MCP off (not locked) sees the switch off and no MCP_ENABLED instruction", async () => {
    boot(owner, { "GET /api/agents/mcp": () => ({ body: { on: false, locked: false } }) });
    expect((await sw()).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(mcpUrl())).toBeNull();
    expect(document.body.textContent).not.toContain("MCP_ENABLED");
  });

  it("locked off: the switch is disabled with the locked text and Space sends nothing", async () => {
    const { api, user } = boot(owner, { "GET /api/agents/mcp": () => ({ body: { on: false, locked: true } }) });
    const s = (await sw()) as HTMLButtonElement;
    expect(s.disabled).toBe(true);
    expect(s.closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByText("Locked off by the deploy config (MCP_ENABLED=0).")).toBeTruthy();
    s.focus();
    await user.keyboard(" ");
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a 409 mcp_locked shows its message and reloads the state", async () => {
    let gets = 0;
    const { user } = boot(owner, {
      "GET /api/agents/mcp": () => ({ body: ++gets === 1 ? { on: true, locked: false } : { on: false, locked: true } }),
      "PUT /api/agents/mcp": () => ({ status: 409, body: { error: "mcp_locked" } }),
    });
    await user.click(await sw());
    expect(await screen.findByText("Locked off by the deploy config (MCP_ENABLED=0).")).toBeTruthy();
    expect(((await sw()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(errorText("mcp_locked"));
  });

  it("a member sees a read-only On tag, no switch, and the address", async () => {
    boot(member);
    expect(await screen.findByText(mcpUrl())).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Agent connections (MCP)" })).toBeNull();
    expect(screen.getByText("On").className).toContain("t-ok");
  });

  it("a member with MCP off sees an Off tag and the ask-the-owner copy", async () => {
    boot(member, { "GET /api/agents/mcp": () => ({ body: { on: false, locked: false } }) });
    expect(await screen.findByText("Agent connections are turned off on this instance. Ask the owner.")).toBeTruthy();
    expect(screen.getByText("Off").className).toContain("t-off");
    expect(screen.queryByText(mcpUrl())).toBeNull();
    expect(document.body.textContent).not.toContain(OLD_COPY);
  });

  it("never probes /mcp itself", async () => {
    const { api } = boot(owner);
    await sw();
    expect(api.calls.some((c) => c.path === "/mcp")).toBe(false);
  });

  it("J then Shift+D asks, and Enter disconnects", async () => {
    const { api, user } = boot(member, { "DELETE /api/agents/connections/c1": () => ({ status: 204 }) });
    await loaded();
    await user.keyboard("j");
    expect(await screen.findByText("Claude, for You")).toBeTruthy();
    await user.keyboard("{Shift>}D{/Shift}");
    const dlg = await screen.findByRole("dialog", { name: "Disconnect Claude" });
    expect(within(dlg).getByText("Disconnect Claude? It stops working at once.")).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/agents/connections/c1")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("cell", { name: "Claude" })).toBeNull());
    // Focus lands on the next row (the key), not on the page body.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("cell", { name: "zapier" }).closest("tr")));
  });

  it("a list read that started before a disconnect cannot bring the row back", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const { user } = boot(member, {
      "GET /api/agents/connections": () => {
        calls++;
        if (calls === 1) return { body: { items: [conn({})] } };
        // The second read (after the key sheet closes) answers late, with the row still in it.
        if (calls === 2) return new Promise((r) => (release = () => r({ body: { items: [conn({})] } })));
        return { body: { items: [] } };
      },
      "DELETE /api/agents/connections/c1": () => ({ status: 204 }),
    });
    await loaded();
    await user.keyboard("n");
    await screen.findByRole("dialog", { name: "New API key" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(calls).toBe(2));
    await user.keyboard("j");
    await screen.findByText("Claude, for You");
    await user.keyboard("{Shift>}D{/Shift}");
    await screen.findByRole("dialog", { name: "Disconnect Claude" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("cell", { name: "Claude" })).toBeNull());
    release!();
    await waitFor(() => expect(calls).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("cell", { name: "Claude" })).toBeNull();
  });

  it("the detail shows read as always on (not a switch) and recent calls", async () => {
    const { user } = boot(member);
    await loaded();
    await user.keyboard("j");
    expect(await screen.findByText("Always on")).toBeTruthy();
    expect(screen.getByText("Read links, domains and clicks")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Read/ })).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(await screen.findByText("search_links")).toBeTruthy();
    expect(screen.getByText("refused")).toBeTruthy();
    expect(screen.getByText("Shown in the audit log as Mia via Claude")).toBeTruthy();
  });

  it("Delete links turns on write; Change access sends both", async () => {
    const { api, user } = boot(member, { "PATCH /api/agents/connections/c1": ({ body }) => ({ body: { ...conn({}), ...(body as object) } }) });
    await loaded();
    await user.keyboard("j");
    const change = await screen.findByRole("button", { name: "Change access" });
    expect((change as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("switch", { name: "Delete links" }));
    expect(screen.getByRole("switch", { name: "Create and edit links" }).getAttribute("aria-checked")).toBe("true");
    await user.click(change);
    await waitFor(() => expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ write: true, del: true }));
    await user.click(screen.getByRole("switch", { name: "Create and edit links" }));
    expect(screen.getByRole("switch", { name: "Delete links" }).getAttribute("aria-checked")).toBe("false");
  });

  it("the owner is not offered raising someone else's connection", async () => {
    boot(owner, { "GET /api/agents/connections": () => ({ body: { items: [conn({ userId: "ud", userEmail: "dana@example.com" })] } }) });
    const user = userEvent.setup();
    await loaded();
    await user.keyboard("j");
    expect(await screen.findByText("Claude, for Dana R.")).toBeTruthy();
    const write = screen.getByRole("switch", { name: "Create and edit links" }) as HTMLButtonElement;
    const del = screen.getByRole("switch", { name: "Delete links" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    expect(screen.getAllByText("Only Dana R. can give it more access.")).toHaveLength(2);
    await user.click(write);
    expect(write.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "Change access" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the owner can lower someone else's access; the saved state is the server's answer", async () => {
    const { api } = boot(owner, {
      "GET /api/agents/connections": () => ({ body: { items: [conn({ userId: "ud", userEmail: "dana@example.com", write: true, del: true })] } }),
      "PATCH /api/agents/connections/c1": () => ({ body: conn({ userId: "ud", write: false, del: false }) }),
    });
    const user = userEvent.setup();
    await loaded();
    await user.keyboard("j");
    const write = await screen.findByRole("switch", { name: "Create and edit links" }) as HTMLButtonElement;
    expect(write.disabled).toBe(false);
    await user.click(write);
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() => expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ write: false, del: false }));
    // Saved: the row shows the new access and both switches are now offers to raise, so disabled.
    await waitFor(() => expect(within(screen.getByRole("row", { name: /Claude/ })).getByText("Read only")).toBeTruthy());
    expect((screen.getByRole("switch", { name: "Create and edit links" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a loading line until the lists arrive", async () => {
    boot(member, { "GET /api/keys": () => new Promise(() => {}) });
    expect(await screen.findByText("Loading agents")).toBeTruthy();
    expect(screen.getByText("Loading keys")).toBeTruthy();
  });

  it("Shift+C does not copy", async () => {
    const { user } = boot(member);
    await loaded();
    await screen.findByText(mcpUrl());
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await user.keyboard("{Shift>}C{/Shift}");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keys show Unused 6 weeks or Expired, and Revoke asks first", async () => {
    const { api, user } = boot(member, {
      "GET /api/keys": () => ({ body: { items: [key({}), key({ id: "k2", name: "old", createdAt: now - 100 * DAY, lastUsedAt: now - DAY, expiresAt: now - DAY })] } }),
      "DELETE /api/keys/k2": () => ({ status: 204 }),
    });
    await loaded();
    expect(screen.getByText("Unused 6 weeks")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    await user.click(screen.getByRole("cell", { name: "old" }));
    await user.click(await screen.findByRole("button", { name: /^Revoke/ }));
    await screen.findByRole("dialog", { name: "Revoke old" });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/keys/k2")).toBe(true));
    // The last row went: focus moves to the row before it.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("cell", { name: "zapier" }).closest("tr")));
  });
});

describe("canText", () => {
  const hosts = new Map([["d1", "go.test"], ["d2", "qr.test"]]);
  it("names what the key can do and where", () => {
    expect(canText(key({}), hosts)).toBe("Read links");
    expect(canText(key({ write: true }), hosts)).toBe("Create links");
    expect(canText(key({ write: true, del: true, domainIds: ["d1"] }), hosts)).toBe("Create and delete links on go.test");
    expect(canText(key({ domainIds: ["d1", "d2"] }), hosts)).toBe("Read links on 2 domains");
  });
});
