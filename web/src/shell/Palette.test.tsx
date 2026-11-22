import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { AppProvider, useApp } from "../state";
import { Palette } from "./Palette";
import type { Domain, Me } from "../api";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { MEMBER_ROLE, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive Owner", role: "owner", ...OWNER_ROLE };
const member: Me = { id: "um", email: "member@example.com", name: null, role: "member", ...MEMBER_ROLE };
const dom = (id: string, host: string, type: Domain["type"]): Domain => ({
  id, host, type, status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 3, isMember: false,
});
const domains = [dom("d1", "go.example.com", "main"), dom("d2", "team.example.com", "shared")];
const link = (id: string, slug: string) => ({ id, domainId: "d1", slug, slugKey: slug, url: "https://example.com/" + slug, redirectCode: 302, startsAt: null, expiresAt: null, passQuery: true, hasPassword: false, routes: [], forwardTo: null, createdBy: "uo", updatedBy: "uo", createdAt: 1, updatedAt: 1 });

async function boot(me: Me, extra: FakeRoutes = {}, path = "/links") {
  history.replaceState(null, "", path);
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: domains }),
    "GET /api/users": () => ({ body: { items: [{ id: "up", email: "pat@example.com", name: "Pat Person", role: "member", status: "active", createdAt: 1, linkCount: 0, domains: [] }] } }),
    "GET /api/links": () => ({ body: { items: [], next: null } }),
    ...extra,
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: /Switch domain/ });
  return { api, user };
}
const box = () => screen.getByRole("combobox", { name: /Search or shortcut/ });
const rail = () => screen.getByRole("button", { name: /Switch domain/ });

afterEach(() => vi.useRealTimers());

describe("Ctrl+K palette", () => {
  it("opens with focus in the box, even after a previous g", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    expect(document.activeElement).toBe(box());
    await user.keyboard("g");
    expect(screen.getByText(/G …/)).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}k{/Control}");
    expect(document.activeElement).toBe(box());
    expect(screen.queryByText(/G …/)).toBeNull();
    expect((box() as HTMLInputElement).value).toBe("");
  });

  it("Ctrl+K toggles", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("typing gd navigates to /domains and closes", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}gd");
    expect(location.pathname).toBe("/domains");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("typing go is search text and shows Domains results", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}go");
    expect((box() as HTMLInputElement).value).toBe("go");
    expect(screen.queryByText(/G …/)).toBeNull();
    expect(await screen.findByRole("group", { name: "Domains" })).toBeTruthy();
    expect(within(screen.getByRole("listbox")).getAllByText("go.example.com").length).toBeGreaterThan(0);
    expect(location.pathname).toBe("/links");
  });

  it("spring ends as the text spring", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}spring");
    expect((box() as HTMLInputElement).value).toBe("spring");
  });

  it("Backspace removes a buffered letter, then edits text", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}g{Backspace}");
    expect(screen.queryByText(/G …/)).toBeNull();
    await user.keyboard("zz{Backspace}");
    expect((box() as HTMLInputElement).value).toBe("z");
  });

  it("Esc closes from the box and focus returns to the opener", async () => {
    const { user } = await boot(owner);
    rail().focus();
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(rail());
  });

  it("Esc closes even when focus is on the panel, not the box", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    (screen.getByRole("dialog") as HTMLElement).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mousedown on the scrim closes; mousedown in the panel then mouseup on the scrim does not", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    const dialog = screen.getByRole("dialog");
    const scrim = dialog.parentElement!;
    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(scrim);
    fireEvent.click(scrim);
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tab stays inside the dialog", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    await user.tab();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("Ctrl+K while the switcher is open does nothing", async () => {
    const { user } = await boot(owner);
    await user.click(rail());
    expect(screen.getByRole("dialog", { name: "Switch domain" })).toBeTruthy();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Switch domain" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /Search or shortcut/ })).toBeNull();
  });

  it("a stale links search answer does not replace the newer one", async () => {
    let release!: () => void;
    const firstDone = new Promise<void>((r) => (release = r));
    const { user } = await boot(owner, {
      "GET /api/links": async ({ url }) => {
        const q = url.searchParams.get("q");
        if (q === "spr") {
          await firstDone;
          return { body: { items: [link("l1", "spr-old")], next: null } };
        }
        if (q === "spring") return { body: { items: [link("l2", "spring-new")], next: null } };
        return { body: { items: [], next: null } };
      },
    });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(box(), "spr");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    await user.type(box(), "ing");
    expect(await screen.findByText("spring-new")).toBeTruthy();
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("spr-old")).toBeNull();
    expect(screen.getByText("spring-new")).toBeTruthy();
  });

  it("a link result opens the links screen on that link", async () => {
    const { user } = await boot(owner, {
      "GET /api/links": ({ url }) => ({ body: { items: url.searchParams.get("q") ? [link("l9", "spring")] : [], next: null } }),
    });
    await user.keyboard("{Control>}k{/Control}spring");
    await screen.findByRole("group", { name: "Links" });
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBeGreaterThan(0));
    await user.keyboard("{Enter}");
    expect(location.pathname + location.search).toBe("/links?q=spring&sel=l9");
  });

  it("members never see gp or gs, but get gi (R9)", async () => {
    const { user } = await boot(member);
    await user.keyboard("{Control>}k{/Control}");
    const list = screen.getByRole("listbox");
    expect(within(list).queryByText(/People/)).toBeNull();
    expect(within(list).getByText("API & agents")).toBeTruthy();
    expect(within(list).queryByText(/Settings/)).toBeNull();
    await user.keyboard("gp");
    expect(location.pathname).toBe("/links");
  });

  it("owners see them", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    expect(within(screen.getByRole("listbox")).getByText(/People/)).toBeTruthy();
  });

  it("a failed search says so instead of Nothing matches, and Enter creates nothing", async () => {
    const { user } = await boot(owner, {
      "GET /api/links": ({ url }) => (url.searchParams.get("q") ? { status: 500, body: { error: "internal" } } : { body: { items: [], next: null } }),
    });
    await user.keyboard("{Control>}k{/Control}qzx");
    expect(await screen.findByText(/Could not search links/)).toBeTruthy();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull();
  });

  it("Enter on the Nothing-matches state opens newLink with the slug", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}qzx");
    expect(await screen.findByText(/Nothing matches "qzx"\. Press Enter to create a link with that slug\./)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "New link" })).toBeTruthy();
    expect((screen.getByLabelText(/^Short link/) as HTMLInputElement).value).toBe("qzx");
  });

  it("Enter on Nothing matches sets the overlay to newLink with the slug", async () => {
    fakeApi({ "GET /api/domains": () => ({ body: domains }), "GET /api/users": () => ({ body: { items: [] } }), "GET /api/links": () => ({ body: { items: [], next: null } }) });
    const Probe = () => <output data-testid="ov">{JSON.stringify(useApp().overlay)}</output>;
    const user = userEvent.setup();
    render(<AppProvider me={owner}><Probe /><Palette /></AppProvider>);
    await user.type(box(), "qzx");
    await screen.findByText(/Nothing matches/);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("ov").textContent).toBe('{"kind":"newLink","slug":"qzx"}');
  });

  it("a paste after a buffered g keeps the g", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}g");
    await user.paste("xyz");
    expect((box() as HTMLInputElement).value).toBe("gxyz");
    expect(screen.queryByText(/G …/)).toBeNull();
  });

  it("G then x keeps the typed case", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}Gx");
    expect((box() as HTMLInputElement).value).toBe("Gx");
  });

  it("focus returns to the original opener after palette to switcher or shortcuts", async () => {
    const { user } = await boot(owner);
    rail().focus();
    await user.keyboard("{Control>}k{/Control}sd{Escape}");
    expect(document.activeElement).toBe(rail());
    await user.keyboard("{Control>}k{/Control}?{Escape}");
    expect(document.activeElement).toBe(rail());
  });

  it("Nothing-matches for text that is not a slug has no create hint", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}q z/");
    expect(await screen.findByText(/Nothing matches "q z\/"\.$/)).toBeTruthy();
  });

  it("footer matches the mockup", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    const d = screen.getByRole("dialog");
    for (const t of ["move", "open", "back a letter", "all shortcuts", "close"]) expect(within(d).getByText(new RegExp(t))).toBeTruthy();
  });

  it("? and sd reach the shortcuts sheet and the switcher", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    await user.keyboard("{Escape}{Control>}k{/Control}sd");
    expect(screen.getByRole("dialog", { name: "Switch domain" })).toBeTruthy();
  });
});

describe("G chords from the shell", () => {
  it("G then L/D navigate outside inputs", async () => {
    const { user } = await boot(owner, {}, "/analytics");
    await user.keyboard("gd");
    expect(location.pathname).toBe("/domains");
    await user.keyboard("gl");
    expect(location.pathname).toBe("/links");
    await user.keyboard("gp");
    expect(location.pathname).toBe("/people");
  });

  it("members cannot reach owner screens by chord", async () => {
    const { user } = await boot(member);
    await user.keyboard("gp");
    expect(location.pathname).toBe("/links");
    await user.keyboard("ga");
    expect(location.pathname).toBe("/analytics");
  });

  it("does nothing inside a text field", async () => {
    const { user } = await boot(owner);
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("x");
    await user.keyboard("{Escape}");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("gd");
    expect(location.pathname).toBe("/links");
    expect(input.value).toBe("gd");
    input.remove();
  });

  it("times out and ignores other keys in between", async () => {
    await boot(owner, {}, "/analytics");
    vi.useFakeTimers({ toFake: ["Date"] });
    const press = (key: string) => fireEvent.keyDown(document.body, { key });
    press("g");
    vi.setSystemTime(Date.now() + 5000);
    press("d");
    expect(location.pathname).toBe("/analytics");
    press("g");
    press("x");
    press("d");
    expect(location.pathname).toBe("/analytics");
    press("g");
    press("d");
    expect(location.pathname).toBe("/domains");
  });

  it("is off while an overlay is open", async () => {
    const { user } = await boot(owner);
    await user.click(rail());
    await user.keyboard("gd");
    expect(location.pathname).toBe("/links");
  });
});
