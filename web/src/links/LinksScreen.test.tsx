import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const domain: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 3, isMember: false,
};
const mk = (id: string, slug: string, o: Partial<Link> = {}): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
});
const L1 = mk("l1", "spring"), L2 = mk("l2", "menu"), L3 = mk("l3", "app", { createdBy: "u9" });

function boot(opts: { me?: Me; routes?: FakeRoutes; page?: () => FakeRes | Promise<FakeRes>; path?: string } = {}) {
  history.replaceState(null, "", opts.path ?? "/links");
  const api = fakeApi({
    "GET /api/me": () => ({ body: opts.me ?? owner }),
    "GET /api/domains": () => ({ body: [domain] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": opts.page ?? (() => ({ body: { items: [L1, L2, L3], next: null } })),
    ...opts.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const rows = () => screen.getAllByRole("row").slice(1);
const urlInput = () => screen.getByLabelText("URL") as HTMLInputElement;
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const detail = () => screen.getByRole("complementary", { name: "Selected link" });
afterEach(() => vi.unstubAllGlobals());

describe("Links screen list", () => {
  it("first load has no cursor, Load more sends it and appends", async () => {
    const seen: string[] = [];
    const { user } = boot({
      page: () => {
        const n = seen.push("x");
        return { body: n === 1 ? { items: [L1, L2], next: "100.l2" } : { items: [L3], next: null } };
      },
    });
    await ready();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a scope change shows no false empty state while the new list loads", async () => {
    let n = 0;
    const { user } = boot({ page: () => (++n === 1 ? { body: { items: [L1], next: null } } : new Promise<FakeRes>(() => undefined)) });
    await ready();
    await user.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(screen.queryAllByRole("row")).toHaveLength(1));
    expect(screen.queryByText(/^No links/)).toBeNull();
  });

  it("sends cursor only on the second request", async () => {
    const { api, user } = boot({ page: () => ({ body: { items: [L1], next: "100.l1" } }) });
    await ready();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path.startsWith("/api/links")).length).toBe(2));
    const paths = api.calls.filter((c) => c.path.startsWith("/api/links")).map((c) => c.path);
    expect(paths[0]).not.toContain("cursor");
    expect(paths[1]).toContain("cursor=100.l1");
  });

  it("J and K move selection and focus", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("j");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("j");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard("k");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("Load more after a filter change never sends the old cursor or mixes rows", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { api, user } = boot({
      page: async () => {
        if (++n === 1) return { body: { items: [L1], next: "100.l1" } };
        await gate; // the new first page is slow
        return { body: { items: [L2], next: null } };
      },
    });
    await ready();
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await user.keyboard("jj");
    release!();
    await waitFor(() => expect(screen.getByText("menu")).toBeTruthy());
    expect(rows()).toHaveLength(1);
    expect(api.calls.some((c) => c.path.includes("cursor="))).toBe(false);
  });

  it("two rapid loads send one request and no duplicate rows", async () => {
    let n = 0;
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: async () => {
        if (++n === 1) return { body: { items: [L1], next: "100.l1" } };
        await new Promise((r) => setTimeout(r, 30));
        return { body: { items: [L2], next: null } };
      },
    });
    await ready();
    await user.keyboard("jj");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.calls.filter((c) => c.path.includes("cursor=")).length).toBe(1);
  });

  it("J on the last row loads the next page", async () => {
    let n = 0;
    const { user } = boot({ page: () => ({ body: ++n === 1 ? { items: [L1], next: "100.l1" } : { items: [L2], next: null } }) });
    await ready();
    await user.keyboard("j");
    await user.keyboard("j");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(rows()[1]!.getAttribute("aria-selected")).toBe("true"));
  });

  it("?sel selects that row and filters send status and mine", async () => {
    const { api, user } = boot({ path: "/links?sel=l2" });
    await ready();
    await waitFor(() => expect(rows()[1]!.getAttribute("aria-selected")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "Expired" }));
    await user.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(api.calls.at(-1)!.path).toContain("status=expired&mine=1"));
  });

  it("count shows the scope total with no filter", async () => {
    boot();
    expect(await screen.findByText("3 links")).toBeTruthy();
  });
});

describe("Link detail", () => {
  const patchOk = (calls: unknown[]) => ({
    "PATCH /api/links/l1": ({ body }: { body: unknown }) => {
      calls.push(body);
      return { body: { ...L1, ...(body as object), updatedAt: 101 } };
    },
  });

  it("J typed in the URL input types j and moves nothing", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.click(urlInput());
    await user.keyboard("j");
    expect(urlInput().value.endsWith("j")).toBe(true);
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("C copies the short link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = boot({ path: "/links?sel=l1" });
    vi.stubGlobal("navigator", { clipboard: { writeText } }); // after userEvent.setup, which installs its own stub
    await ready();
    await user.keyboard("c");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://go.test/spring"));
  });

  it("E focuses the URL field", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("e");
    expect(document.activeElement).toBe(urlInput());
  });

  it("editing only the URL then Ctrl+Enter sends exactly { url }", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await user.click(urlInput());
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ url: "https://example.com/new" }]));
  });

  it("a URL typed while the save is pending is kept, not replaced by the saved revision", async () => {
    // The save answer is held until the test releases it; every step waits on UI state or the recorded call, never on time.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api } = boot({
      path: "/links?sel=l1",
      routes: { "PATCH /api/links/l1": async ({ body }) => (await held, { body: { ...L1, ...(body as object), updatedAt: 101 } }) },
    });
    await waitFor(() => expect(urlInput().value).toBe("https://example.com/spring"));
    urlInput().focus();
    fireEvent.change(urlInput(), { target: { value: "https://example.com/b" } });
    fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/c" } });
    expect(urlInput().value).toBe("https://example.com/c");
    release();
    expect(await within(detail()).findByText("https://example.com/b")).toBeTruthy();
    expect(urlInput().value).toBe("https://example.com/c");
    expect(document.activeElement).toBe(urlInput());
  });

  it("clearing a date sends that field as null", async () => {
    const bodies: unknown[] = [];
    const dated = { ...L1, expiresAt: 4102444800 };
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [dated], next: null } }),
      routes: patchOk(bodies),
    });
    await ready();
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "" } });
    await user.click(urlInput());
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ expiresAt: null }]));
  });

  it("double Enter on the delete confirm sends one DELETE", async () => {
    const { api, user } = boot({
      path: "/links?sel=l1",
      routes: { "DELETE /api/links/l1": async () => { await new Promise((r) => setTimeout(r, 30)); return { status: 204 }; } },
    });
    await ready();
    await user.keyboard("{Shift>}D{/Shift}");
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.calls.filter((c) => c.method === "DELETE").length).toBe(1);
  });

  it("nothing changed sends no request", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    await user.click(urlInput());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(bodies).toEqual([]);
  });

  it("Esc in the form restores the saved URL with no request", async () => {
    const bodies: unknown[] = [];
    const { api, user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    await user.type(urlInput(), "zzz");
    await user.keyboard("{Escape}");
    expect(urlInput().value).toBe("https://example.com/spring");
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("PATCH 400 loop shows its text next to the URL", async () => {
    const { user } = boot({ path: "/links?sel=l1", routes: { "PATCH /api/links/l1": () => ({ status: 400, body: { error: "loop" } }) } });
    await ready();
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(detail()).findByText(errorText("loop"))).toBeTruthy();
    expect(urlInput().value).toBe("https://example.com/springx");
  });

  it("409 conflict says to reload", async () => {
    const { user } = boot({ path: "/links?sel=l1", routes: { "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }) } });
    await ready();
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(detail()).findByText(errorText("conflict"))).toBeTruthy();
    expect(within(detail()).getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("a network failure shows the signed-out banner and keeps the typed URL", async () => {
    const { user } = boot({
      path: "/links?sel=l1",
      routes: { "PATCH /api/links/l1": () => { throw new Error("redirect"); } },
    });
    await ready();
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getAllByText(errorText("network")).length).toBeGreaterThan(0));
    expect(urlInput().value).toBe("https://example.com/springx");
  });

  it("Shift+D opens the confirm, Esc cancels without DELETE", async () => {
    const { api, user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("{Shift>}D{/Shift}");
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain("go.test/spring");
    expect(dlg.textContent).toContain("the slug stays locked");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("with the delete confirm open, Ctrl+K, ? and G D do nothing, and one Esc closes only the confirm", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("{Shift>}D{/Shift}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("?");
    await user.keyboard("gd");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Delete link" })).toBeTruthy();
    expect(location.pathname).toBe("/links");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(location.search).toContain("sel=l1");
  });

  it("Esc outside a field clears the selection; Esc in the URL field only reverts", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.click(urlInput());
    await user.keyboard("{Escape}");
    expect(location.search).toContain("sel=l1");
    await user.click(rows()[0]!);
    await user.keyboard("{Escape}");
    expect(location.search).not.toContain("sel=");
    expect(screen.queryByRole("complementary", { name: "Selected link" })).toBeNull(); // no empty panel
    expect(document.activeElement).toBe(rows()[0]); // focus back on the row that was selected
  });

  it("Shift+D then Enter deletes and removes the row", async () => {
    const { api, user } = boot({ path: "/links?sel=l1", routes: { "DELETE /api/links/l1": () => ({ status: 204 }) } });
    await ready();
    await user.keyboard("{Shift>}D{/Shift}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/links/l1")).toBe(true));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText("spring")).toBeNull();
  });

  it("a member viewing a teammate's link is read-only with no Save or Delete", async () => {
    boot({ me: member, path: "/links?sel=l1" });
    await ready();
    expect(urlInput().readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(detail()).getByText(/Created by Teammate/)).toBeTruthy();
  });
});
