import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Me } from "../api";
import { fakeApi } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive Owner", role: "owner" };
const dom = (id: string, host: string, type: Domain["type"], status: Domain["status"] = "active"): Domain => ({
  id, host, type, status, ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 7, isMember: false,
});
const domains = [dom("d3", "priv.example.com", "private", "pending"), dom("d2", "team.example.com", "shared"), dom("d1", "go.example.com", "main"), dom("d4", "off.example.com", "private", "disabled")];

async function boot(me: Me = owner) {
  history.replaceState(null, "", "/links");
  fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: domains }),
    "GET /api/users": () => ({ body: { items: [] } }),
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await screen.findByRole("button", { name: /Switch domain/ });
  return { user, view };
}
const railHost = () => screen.getByRole("button", { name: /Switch domain/ }).textContent;
const sw = () => screen.getByRole("dialog", { name: "Switch domain" });

describe("DomainSwitcher", () => {
  it("lists groups in order with sub text and numbers", async () => {
    const { user } = await boot();
    await user.keyboard("{Control>}k{/Control}sd");
    const d = sw();
    const text = d.textContent!;
    expect(text.indexOf("Main")).toBeLessThan(text.indexOf("Shared"));
    expect(text.indexOf("Shared")).toBeLessThan(text.indexOf("Private"));
    expect(text).toContain("7 links");
    expect(text).toContain("waiting for approval");
    expect(text).toContain("disabled");
    expect(text).toContain("Every domain you can see");
    expect(within(d).getByText("go.example.com").closest("[role=option]")!.textContent).toContain("1");
  });

  it("members see Shared with you", async () => {
    const { user } = await boot({ ...owner, role: "member", id: "um" });
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    expect(sw().textContent).toContain("Shared with you");
  });

  it("2 picks the second domain and closes", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(railHost()).toContain("team.example.com");
  });

  it("2 in a non-empty filter is typed", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("t2");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("t2");
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("0 selects all domains", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("1");
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("0");
    expect(railHost()).toContain("All domains");
  });

  it("Enter on a filtered item switches", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("team{Enter}");
    expect(railHost()).toContain("team.example.com");
  });

  it("arrows move the selection", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(railHost()).toContain("team.example.com");
  });

  it("the choice persists across a remount", async () => {
    const { user, view } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("2");
    view.unmount();
    await boot();
    await waitFor(() => expect(railHost()).toContain("team.example.com"));
  });

  it("survives localStorage throwing", async () => {
    const { user } = await boot();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("2");
    expect(railHost()).toContain("team.example.com");
    vi.restoreAllMocks();
  });

  it("Esc and outside click close it", async () => {
    const { user } = await boot();
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Switch domain/ }));
  });
});
