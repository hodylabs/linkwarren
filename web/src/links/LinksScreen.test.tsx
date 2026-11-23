import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";
import { resizePhoto } from "./photo";

vi.mock("./photo", async (orig) => ({ ...(await orig<typeof import("./photo")>()), resizePhoto: vi.fn(async () => "/9j/AAAA") }));

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE };
const domain: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 3, isMember: false,
};
const mk = (id: string, slug: string, o: Partial<Link> = {}): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, kind: "url", createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
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
// S12: the panel is a summary; E opens the edit sheet (the New link sheet, prefilled), whose URL field is "Goes to".
const urlInput = () => screen.getByLabelText(/^Goes to/) as HTMLInputElement;
const editSheet = () => screen.getByRole("dialog", { name: "Edit link" });
const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
  (document.activeElement as HTMLElement | null)?.blur();
  await user.keyboard("e");
  return editSheet();
};
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
    await waitFor(() => expect(api.calls.filter((c) => c.path.startsWith("/api/links")).at(-1)!.path).toContain("status=expired&mine=1"));
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

  it("the panel is a summary: no inputs, the destination as text, and Copy, Edit and QR code under the slug", async () => {
    boot({ path: "/links?sel=l1" });
    await ready();
    const p = detail();
    expect(p.querySelector("input, textarea, select")).toBeNull();
    expect(within(p).getByText("https://example.com/spring")).toBeTruthy();
    for (const k of ["C", "E", "Q"]) expect(within(p).getByRole("button", { name: new RegExp(`${k}$`) }).getAttribute("aria-keyshortcuts")).toBe(k);
    expect(within(p).getByRole("link", { name: /Link analytics/ }).getAttribute("href")).toBe("/analytics/link/l1");
    expect(within(p).getAllByText(/^You, /)).toHaveLength(2); // Created and Updated
  });

  it("J typed in the edit sheet's URL types j and moves nothing", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await openEdit(user);
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

  it("E opens the same sheet as New link, prefilled, with the URL field focused; the Edit button does the same", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("e");
    const sheet = editSheet();
    expect(document.activeElement).toBe(urlInput());
    expect(urlInput().value).toBe("https://example.com/spring");
    expect(sheet.querySelector(".fixed-slug")!.textContent).toBe("go.test/spring"); // the short link is fixed
    expect(within(sheet).queryByRole("radiogroup", { name: "Type" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(within(detail()).getByRole("button", { name: /^Edit/ }));
    expect(editSheet()).toBeTruthy();
  });

  it("editing only the URL then Ctrl+Enter sends exactly { url } and closes the sheet", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ url: "https://example.com/new" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(detail()).getByText("https://example.com/new")).toBeTruthy();
  });

  it("a URL typed while the save is pending is kept, not replaced by the saved revision", async () => {
    // The save answer is held until the test releases it; every step waits on UI state or the recorded call, never on time.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api, user } = boot({
      path: "/links?sel=l1",
      routes: { "PATCH /api/links/l1": async ({ body }) => (await held, { body: { ...L1, ...(body as object), updatedAt: 101 } }) },
    });
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/b" } });
    fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/c" } });
    expect(urlInput().value).toBe("https://example.com/c");
    release();
    expect(await within(detail()).findByText("https://example.com/b")).toBeTruthy();
    // Typed on while it saved: the sheet stays open and keeps the newer text.
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
    await openEdit(user);
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

  it("nothing changed sends no request and closes the sheet", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    await openEdit(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(bodies).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc in the sheet discards the edit with no request; Edit again starts from the saved URL", async () => {
    const bodies: unknown[] = [];
    const { api, user } = boot({ path: "/links?sel=l1", routes: patchOk(bodies) });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "zzz");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(location.search).toContain("sel=l1"); // the Esc closed only the sheet
    await openEdit(user);
    expect(urlInput().value).toBe("https://example.com/spring");
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("PATCH 400 loop shows its text next to the URL", async () => {
    const { user } = boot({ path: "/links?sel=l1", routes: { "PATCH /api/links/l1": () => ({ status: 400, body: { error: "loop" } }) } });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(editSheet()).findByText(errorText("loop"))).toBeTruthy();
    expect(urlInput().value).toBe("https://example.com/springx");
  });

  it("409 conflict says to reload, and Reload loads the new revision into the sheet", async () => {
    let rev = L1;
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [rev, L2, L3], next: null } }),
      routes: { "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }) },
    });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(editSheet()).findByText(errorText("conflict"))).toBeTruthy();
    rev = { ...L1, url: "https://example.com/theirs", updatedAt: 200 };
    await user.click(within(editSheet()).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(urlInput().value).toBe("https://example.com/theirs"));
    expect(within(editSheet()).queryByText(errorText("conflict"))).toBeNull();
  });

  it("a login redirect shows the signed-out banner and keeps the typed URL", async () => {
    const { user } = boot({
      path: "/links?sel=l1",
      routes: { "PATCH /api/links/l1": () => ({ signIn: true }) },
    });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getAllByText(errorText("network")).length).toBeGreaterThan(0));
    expect(urlInput().value).toBe("https://example.com/springx");
  });

  it("Q opens the QR code sheet on Download SVG; q typed in the edit sheet stays text", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await openEdit(user);
    await user.keyboard("q");
    expect(urlInput().value).toBe("https://example.com/springq");
    await user.keyboard("{Escape}");
    await user.keyboard("q");
    const qr = screen.getByRole("dialog", { name: "QR code" });
    expect(document.activeElement).toBe(within(qr).getByRole("button", { name: /Download SVG/ }));
    expect(within(qr).getByRole("img", { name: "QR code for go.test/spring" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("A opens the link's analytics page", async () => {
    const { user } = boot({ path: "/links?sel=l1", routes: { "GET /api/analytics": () => ({ status: 500, body: { error: "internal_error" } }) } });
    await ready();
    await user.keyboard("a");
    expect(location.pathname).toBe("/analytics/link/l1");
  });

  it("?qr=1 with a selection opens the QR code sheet on Download SVG", async () => {
    boot({ path: "/links?sel=l1&qr=1" });
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ })));
  });

  it("?qr=1 opens once: it leaves the URL, and J after closing it focuses row 2", async () => {
    const { user } = boot({ path: "/links?sel=l1&qr=1" });
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ })));
    await waitFor(() => expect(location.search).not.toContain("qr="));
    await user.keyboard("{Escape}");
    await user.keyboard("j");
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Shift+D opens the confirm, Esc cancels without DELETE", async () => {
    const { api, user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("{Shift>}D{/Shift}");
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain("go.test/spring");
    expect(dlg.textContent).toContain("the slug stays locked");
    expect(dlg.textContent).toContain("Old addresses that forward to it are deleted and locked");
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

  it("Esc with the edit sheet open closes only the sheet; Esc outside it clears the selection", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await openEdit(user);
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

  it("a member viewing a teammate's link gets no Edit or Delete, and E opens nothing", async () => {
    const { user } = boot({ me: member, path: "/links?sel=l1" });
    await ready();
    expect(within(detail()).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(detail()).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(detail()).getAllByText(/^Teammate, /)).toHaveLength(2); // Created and Updated
    await user.keyboard("e");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Links screen stats", () => {
  const stat = (id: string, o: object = {}) => ({ linkId: id, days: [0, 1, 2, 3, 4, 5, 6], clicks: 1284, qr: 783, topCountry: "US", ...o });
  const statsRoute = (seen: string[], live = "ok", fail = false) => ({
    "GET /api/analytics/links": (r: { url: URL }) => {
      const ids = r.url.searchParams.get("ids") ?? "";
      seen.push(ids);
      if (fail) return { status: 500, body: { error: "internal" } };
      return { body: { items: ids.split(",").map((i) => stat(i)), live } };
    },
  });

  it("one stats request per page: Load more asks only for the new ids", async () => {
    const seen: string[] = [];
    let n = 0;
    const { user } = boot({
      routes: statsRoute(seen),
      page: () => ({ body: ++n === 1 ? { items: [L1, L2], next: "c" } : { items: [L3], next: null } }),
    });
    await ready();
    await waitFor(() => expect(seen).toEqual(["l1,l2"]));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(seen).toEqual(["l1,l2", "l3"]));
  });

  it("sparklines: orange for an active link, grey for an expired one, with a text summary", async () => {
    const seen: string[] = [];
    const old = mk("l9", "old", { expiresAt: 5 });
    boot({ routes: statsRoute(seen), page: () => ({ body: { items: [L1, old], next: null } }) });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(2));
    // S12: colored by class (the accent or the grey of the active theme), not a fixed stroke.
    const strokes = [...document.querySelectorAll("svg.spark polyline")].map((p) => p.getAttribute("class"));
    expect(strokes).toEqual(["ln", "ln off"]);
    expect(within(rows()[0]!).getByText("1,284 clicks in 7 days")).toBeTruthy();
  });

  it("the cell stays an empty td with a data-label until stats arrive, and a failed request leaves the table usable", async () => {
    const seen: string[] = [];
    boot({ routes: statsRoute(seen, "ok", true) });
    await ready();
    await waitFor(() => expect(seen.length).toBe(1));
    const cell = rows()[0]!.querySelector('td[data-label="7 days"]')!;
    expect(cell.childNodes).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the cell has no content (so the phone card hides it) until stats load, then holds the sparkline", async () => {
    let release: (r: FakeRes) => void = () => undefined;
    boot({ routes: { "GET /api/analytics/links": () => new Promise<FakeRes>((r) => (release = r)) } });
    await ready();
    const cell = () => rows()[0]!.querySelector('td[data-label="7 days"]')!;
    expect(cell().childNodes).toHaveLength(0);
    expect(cell().textContent).toBe("");
    release({ body: { items: [stat("l1")], live: "ok" } });
    await waitFor(() => expect(cell().querySelector("svg.spark")).not.toBeNull());
  });

  it.each([
    ["off", "Live clicks are off on this instance."],
    ["unavailable", "Recent clicks could not be loaded."],
  ] as const)("live %s: dashed recent days in the sparkline and its own hint in the detail", async (live, hint) => {
    const { user } = boot({ routes: statsRoute([], live) });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    expect(rows()[0]!.querySelector("svg.spark line.gap")).not.toBeNull();
    expect(within(rows()[0]!).getByText(/Recent days not available/)).toBeTruthy();
    await user.click(rows()[0]!);
    expect(within(detail()).getByText(`${hint} These counts leave out yesterday and today.`)).toBeTruthy();
  });

  it("unknown recent days are shown as unknown when live is off", async () => {
    boot({ routes: statsRoute([], "off") });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    expect(document.querySelector("svg.spark line.gap")).not.toBeNull();
    expect(within(rows()[0]!).getByText(/Recent days not available/)).toBeTruthy();
  });

  it("live is kept per page: an off page 2 never marks page 1 as incomplete", async () => {
    const hint = "These counts leave out yesterday and today.";
    let n = 0;
    const { user } = boot({
      page: () => ({ body: ++n === 1 ? { items: [L1, L2], next: "c" } : { items: [L3], next: null } }),
      routes: {
        "GET /api/analytics/links": (r: { url: URL }) => {
          const ids = r.url.searchParams.get("ids") ?? "";
          return { body: { items: ids.split(",").map((i) => stat(i)), live: ids === "l3" ? "off" : "ok" } };
        },
      },
    });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    expect(rows().map((r) => r.querySelector("svg.spark line.gap") !== null)).toEqual([false, false, true]);
    await user.click(rows()[0]!);
    expect(within(detail()).queryByText(new RegExp(hint))).toBeNull();
  });

  it("a reload of the same scope drops the old stats until the new ones arrive", async () => {
    let n = 0;
    let release: (r: FakeRes) => void = () => undefined;
    const { user } = boot({
      path: "/links?sel=l1",
      routes: {
        "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }),
        "GET /api/analytics/links": () => (++n === 1 ? { body: { items: [stat("l1"), stat("l2"), stat("l3")], live: "ok" } } : new Promise<FakeRes>((r) => (release = r))),
      },
    });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await within(editSheet()).findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(n).toBe(2));
    expect(document.querySelectorAll("svg.spark")).toHaveLength(0);
    release({ body: { items: [stat("l1")], live: "ok" } });
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(1));
  });

  it("with live off the unknown last two days continue dashed from the last known point, never as zeros", async () => {
    boot({ routes: { "GET /api/analytics/links": (r: { url: URL }) => ({ body: { items: (r.url.searchParams.get("ids") ?? "").split(",").map((i) => stat(i, { days: [1, 2, 3, 4, 5, 0, 0] })), live: "off" } }) } });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    const svg = document.querySelector("svg.spark")!;
    const pts = svg.querySelector("polyline")!.getAttribute("points")!.split(" ");
    expect(pts).toHaveLength(5);
    const [lx, ly] = pts.at(-1)!.split(",");
    const dash = svg.querySelector("line.gap")!;
    expect([dash.getAttribute("x1"), dash.getAttribute("y1"), dash.getAttribute("x2"), dash.getAttribute("y2")]).toEqual([lx, ly, "72", ly]);
  });

  it("the detail shows Last 7 days from the loaded stats without refetching", async () => {
    const seen: string[] = [];
    const { user } = boot({ routes: statsRoute(seen) });
    await ready();
    await waitFor(() => expect(seen).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    await user.click(rows()[0]!);
    const d = detail();
    expect(within(d).getByText("Last 7 days")).toBeTruthy();
    expect(within(d).getByText("1,284")).toBeTruthy();
    expect(within(d).getByText("61%")).toBeTruthy();
    expect(within(d).getByText("US")).toBeTruthy();
    await user.click(rows()[1]!);
    expect(seen).toHaveLength(1);
  });

  it("a stats answer from a replaced list is dropped", async () => {
    let release: (r: FakeRes) => void = () => undefined;
    let n = 0;
    boot({
      routes: { "GET /api/analytics/links": () => (++n === 1 ? new Promise<FakeRes>((r) => (release = r)) : { body: { items: [], live: "ok" } }) },
    });
    await ready();
    await waitFor(() => expect(n).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(n).toBe(2));
    release({ body: { items: [stat("l1")], live: "ok" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelectorAll("svg.spark")).toHaveLength(0);
  });
});

const routeSummaryText = () => "Canada on Mobile goes to example.com/ca";

describe("Link detail rules", () => {
  const protectedLink = mk("l1", "spring", { hasPassword: true, routes: [{ countries: ["CA"], devices: ["mobile"], url: "https://example.com/ca" }] });
  const save = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(urlInput());
    await user.keyboard("{Control>}{Enter}{/Control}");
  };
  const patch = (calls: unknown[]) => ({
    "PATCH /api/links/l1": ({ body }: { body: unknown }) => {
      calls.push(body);
      return { body: { ...protectedLink, updatedAt: 101 } };
    },
  });
  const bootP = (bodies: unknown[], me?: Me) => boot({ me, path: "/links?sel=l1", page: () => ({ body: { items: [protectedLink], next: null } }), routes: patch(bodies) });
  // In the sheet each rule is a row button that turns it on (expanded, its note On) or off; the old panel used switches.
  const rule = (name: RegExp) => within(editSheet()).getByRole("button", { name });

  it("editing only the URL on a protected link sends exactly { url }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ url: "https://example.com/new" }]));
  });

  it("turning Password off sends { password: null }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    expect(within(editSheet()).getByText("Password set")).toBeTruthy();
    expect(rule(/^Password/).getAttribute("aria-expanded")).toBe("true");
    expect(rule(/^Password/).textContent).toContain("On");
    await user.click(rule(/^Password/));
    expect(rule(/^Password/).getAttribute("aria-expanded")).toBe("false");
    expect(rule(/^Password/).textContent).toContain("Off");
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ password: null }]));
  });

  it("a new password is sent and a short one is not", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    await user.click(within(editSheet()).getByRole("button", { name: "Change password" }));
    expect(document.activeElement).toBe(screen.getByLabelText("New password"));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    await save(user);
    expect(await screen.findByText(errorText("password_short"))).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ password: "longenough1" }]));
    await waitFor(() => expect(screen.queryByLabelText("New password")).toBeNull()); // saved: the sheet closed
    expect(document.body.textContent).not.toContain("longenough1");
  });

  it("Password on with nothing stored and nothing typed blocks the save, next to the password field", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patch(bodies) });
    await ready();
    await openEdit(user);
    await user.click(rule(/^Password/));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await save(user);
    const alert = await within(editSheet()).findByText(errorText("password_short"));
    expect(alert.closest(".pw")).toBeTruthy();
    expect(urlInput().closest(".f")!.querySelector(".err")).toBeNull();
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")!.split(" ")).toContain(alert.id);
    // With no other change, it still says why instead of doing nothing.
    fireEvent.change(urlInput(), { target: { value: L1.url } });
    await save(user);
    expect(within(editSheet()).getByText(errorText("password_short"))).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("a password and a route typed while the save is pending are kept", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [protectedLink], next: null } }),
      routes: { "PATCH /api/links/l1": async ({ body }) => (await held, { body: { ...protectedLink, url: "https://example.com/saved", updatedAt: 101 } }) },
    });
    await ready();
    await openEdit(user);
    fireEvent.click(within(editSheet()).getByRole("button", { name: "Change password" }));
    const pw = () => screen.getByLabelText("New password") as HTMLInputElement;
    fireEvent.change(pw(), { target: { value: "first-pass" } });
    fireEvent.keyDown(pw(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    fireEvent.change(pw(), { target: { value: "second-pass" } });
    fireEvent.change(screen.getByLabelText("Rule 1 countries"), { target: { value: "fr" } });
    release();
    expect(await within(detail()).findByText("https://example.com/saved")).toBeTruthy();
    // The summary text lands a commit before the form rebases onto the saved revision, so wait on the field itself.
    await waitFor(() => expect(urlInput().value).toBe("https://example.com/saved"));
    expect(pw().value).toBe("second-pass");
    expect((screen.getByLabelText("Rule 1 countries") as HTMLInputElement).value).toBe("fr");
  });

  it("301 with a password is explained and not sent", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    await user.click(within(editSheet()).getByRole("radio", { name: /301/ }));
    expect(within(editSheet()).getByText(errorText("password_301"))).toBeTruthy();
    await save(user);
    expect(bodies).toEqual([]);
  });

  it("adding a route sends { routes }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    await user.click(within(editSheet()).getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Rule 2 countries"), { target: { value: "us" } });
    fireEvent.change(screen.getByLabelText("Rule 2 goes to"), { target: { value: "https://example.com/us" } });
    await save(user);
    await waitFor(() =>
      expect(bodies).toEqual([{ routes: [protectedLink.routes[0], { countries: ["US"], devices: [], url: "https://example.com/us" }] }]),
    );
  });

  it("a bad country shows under its row and sends nothing", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    fireEvent.change(screen.getByLabelText("Rule 1 countries"), { target: { value: "ZZZ" } });
    await save(user);
    expect(await screen.findByText(errorText("route_country"))).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("a bad country typed into a device-only rule shows its error instead of saving nothing silently", async () => {
    const bodies: unknown[] = [];
    const deviceOnly = { ...protectedLink, routes: [{ countries: [], devices: ["mobile" as const], url: "https://example.com/m" }] };
    const user = boot({ path: "/links?sel=l1", page: () => ({ body: { items: [deviceOnly], next: null } }), routes: patch(bodies) }).user;
    await ready();
    await openEdit(user);
    fireEvent.change(screen.getByLabelText("Rule 1 countries"), { target: { value: "ZZZ" } });
    await save(user);
    expect(await screen.findByText(errorText("route_country"))).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("turning routing off sends routes: []", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await openEdit(user);
    await user.click(rule(/^Country and device routing/));
    expect(screen.queryByLabelText("Rule 1 countries")).toBeNull();
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ routes: [] }]));
  });

  it("Esc after turning routing off discards it with no request; the panel and a new edit keep the saved routes", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    const summary = routeSummaryText();
    await openEdit(user);
    await user.click(rule(/^Country and device routing/));
    expect(screen.queryByLabelText("Rule 1 countries")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(detail()).getByText(summary)).toBeTruthy();
    await openEdit(user);
    expect(screen.getByLabelText("Rule 1 countries")).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("the Campaign tags line shows non-empty utm keys and is absent without them", async () => {
    const tagged = mk("l1", "spring", { url: "https://example.com/p?utm_source=flyer&utm_campaign=spring" });
    boot({ path: "/links?sel=l1", page: () => ({ body: { items: [tagged], next: null } }) });
    await ready();
    expect(within(detail()).getByTestId("campaign-tags").textContent).toBe("Campaign tags: utm_source=flyer · utm_campaign=spring");
  });

  it("no Campaign tags line without utm params", async () => {
    boot({ path: "/links?sel=l1" });
    await ready();
    expect(within(detail()).queryByTestId("campaign-tags")).toBeNull();
  });

  it("the table row names its rules; a plain row has an empty rules cell", async () => {
    boot({ page: () => ({ body: { items: [protectedLink, L2], next: null } }) });
    await ready();
    expect(within(rows()[0]!).getByText("Password")).toBeTruthy();
    expect(within(rows()[0]!).getByText("1 route")).toBeTruthy();
    expect(within(rows()[1]!).queryByText("Password")).toBeNull();
    // The Rules column is the fourth cell (after the pick checkbox): empty on the plain row, holding the facts on the protected one.
    const rulesCell = (r: HTMLElement) => r.querySelectorAll("td")[3]!;
    expect(rulesCell(rows()[1]!).childNodes.length).toBe(0);
    expect(rulesCell(rows()[0]!).textContent).toBe("Password1 route");
  });

  it("a member viewing a teammate's link sees the rules as text and cannot edit them", async () => {
    const { user } = bootP([], member);
    await ready();
    const facts = within(detail()).getByText("Rules").closest(".sect") as HTMLElement;
    expect(within(facts).getByText("Set")).toBeTruthy(); // the password
    expect(within(facts).getByText(routeSummaryText())).toBeTruthy();
    expect(detail().querySelector("input, button[role=switch]")).toBeNull();
    await user.keyboard("e");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Links selection", () => {
  const bar = () => screen.queryByRole("region", { name: "Selected links" });
  const boxes = () => screen.queryAllByRole("checkbox") as HTMLInputElement[];
  const header = () => screen.getByRole("checkbox", { name: "Select every loaded link" }) as HTMLInputElement;
  const box = (name: string) => screen.getByRole("checkbox", { name: `Select go.test/${name}` }) as HTMLInputElement;

  it("X toggles the focused row and the bar shows 1 selected", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("j");
    await user.keyboard("x");
    expect(within(bar()!).getByText("1 selected")).toBeTruthy();
    expect(box("spring").checked).toBe(true);
    await user.keyboard("x");
    expect(bar()).toBeNull();
  });

  it("Shift+J twice selects three rows", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("j");
    await user.keyboard("{Shift>}JJ{/Shift}");
    expect(within(bar()!).getByText("3 selected")).toBeTruthy();
    expect(rows()[2]!.getAttribute("aria-selected")).toBe("true"); // the cursor moved with it
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("Ctrl+A selects every loaded row, and after Load more only what is loaded", async () => {
    let n = 0;
    const { user } = boot({ page: () => ({ body: ++n === 1 ? { items: [L1, L2], next: "100.l2" } : { items: [L3], next: null } }) });
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    expect(within(bar()!).getByText("2 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(bar()!).getByText("2 selected")).toBeTruthy();
    await user.keyboard("{Control>}a{/Control}");
    expect(within(bar()!).getByText("3 selected")).toBeTruthy();
  });

  it("Esc first clears the selection, a second Esc closes the detail", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("x");
    expect(bar()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(bar()).toBeNull();
    expect(location.search).toContain("sel=l1");
    await user.keyboard("{Escape}");
    expect(location.search).not.toContain("sel=");
  });

  it("row checkboxes are not Tab stops (the header one is); X on a row announces the count", async () => {
    const { user } = boot();
    await ready();
    expect(boxes().slice(1).every((b) => b.tabIndex === -1)).toBe(true);
    expect(header().tabIndex).toBe(0);
    await user.keyboard("j");
    await user.keyboard("x");
    expect(document.activeElement).toBe(rows()[0]);
    await waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("1 selected"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByText("Selection cleared")).toBeTruthy());
  });

  it("Shift+K extends upward and J still moves the detail after a selection", async () => {
    const { user } = boot({ path: "/links?sel=l3" });
    await ready();
    await waitFor(() => expect(rows()[2]!.getAttribute("aria-selected")).toBe("true"));
    await user.keyboard("{Shift>}K{/Shift}");
    expect(box("app").checked && box("menu").checked && !box("spring").checked).toBe(true);
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("k");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(within(bar()!).getByText("2 selected")).toBeTruthy();
  });

  it("a domain switch and a search each clear the selection", async () => {
    const other: Domain = { ...domain, id: "d2", host: "b.test" };
    const { user } = boot({ routes: { "GET /api/domains": () => ({ body: [domain, other] }) } });
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    await user.click(screen.getByRole("button", { name: /Switch domain/ }));
    await user.keyboard("2");
    await waitFor(() => expect(bar()).toBeNull());
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    expect(bar()).not.toBeNull();
    act(() => void history.pushState(null, "", "/links?q=spr"));
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("a reload keeps only the selected links that are still on page 1", async () => {
    let n = 0;
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: ++n === 1 ? [L1, L2, L3] : [L1, L2], next: null } }),
      routes: { "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }) },
    });
    await ready();
    await user.click(box("menu"));
    await user.click(box("app"));
    expect(within(bar()!).getByText("2 selected")).toBeTruthy();
    await openEdit(user);
    await user.clear(urlInput());
    await user.type(urlInput(), "https://example.com/new");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(bar()!).getByText("1 selected")).toBeTruthy();
  });

  it("a failed copy says so; Clear moves focus to the link's row", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("no"));
    const { user } = boot({ path: "/links?sel=l2" });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await ready();
    await user.keyboard("x");
    await user.keyboard("c");
    await waitFor(() => expect(screen.getByText("Could not copy")).toBeTruthy());
    await user.click(within(bar()!).getByRole("button", { name: /^Clear/ }));
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("a link with an unknown domain gets a slug label and cannot be copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = boot({ page: () => ({ body: { items: [mk("l9", "lost", { domainId: "gone" })], next: null } }) });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await ready();
    await user.click(screen.getByRole("checkbox", { name: "Select lost" }));
    await user.keyboard("c");
    await waitFor(() => expect(screen.getByText("Cannot copy: these links' domains are unknown")).toBeTruthy());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("X and Ctrl+A typed in the edit sheet's URL field type, select nothing", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await openEdit(user);
    await user.click(urlInput());
    await user.keyboard("x{Control>}a{/Control}");
    expect(urlInput().value.endsWith("x")).toBe(true);
    expect(bar()).toBeNull();
  });

  it("X inside the search input types and selects nothing", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("{Control>}k{/Control}");
    const box = await screen.findByRole("dialog");
    await user.keyboard("x");
    expect((within(box).getByRole("combobox") as HTMLInputElement).value).toBe("x");
    await user.keyboard("{Escape}");
    expect(bar()).toBeNull();
  });

  it("Shift+click selects a range from the anchor", async () => {
    const { user } = boot();
    await ready();
    await user.click(box("spring"));
    await user.keyboard("{Shift>}");
    await user.click(rows()[2]!);
    await user.keyboard("{/Shift}");
    expect(within(bar()!).getByText("3 selected")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Selected link" })).toBeNull(); // a range click is not an open
  });

  it("the header checkbox goes indeterminate with some, selects all, then clears", async () => {
    const { user } = boot();
    await ready();
    expect(header().checked).toBe(false);
    await user.click(box("menu"));
    expect(header().indeterminate).toBe(true);
    await user.click(header());
    expect(header().checked).toBe(true);
    expect(header().indeterminate).toBe(false);
    expect(boxes().filter((b) => b.checked)).toHaveLength(4);
    await user.click(header());
    expect(bar()).toBeNull();
  });

  it("with a selection C copies every short URL, one per line; without one it copies the single link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = boot({ path: "/links?sel=l1" });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    await user.keyboard("c");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://go.test/spring\nhttps://go.test/menu\nhttps://go.test/app"));
    await waitFor(() => expect(screen.getByText("Copied 3 short links")).toBeTruthy());
    await user.keyboard("{Escape}");
    await user.keyboard("c");
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("https://go.test/spring"));
  });

  it("with a selection Shift+D is the bulk delete, not the single delete confirm", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.keyboard("x");
    await user.keyboard("{Shift>}D{/Shift}");
    expect(screen.queryByRole("dialog", { name: "Delete link" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("changing the status chip clears the selection", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    expect(bar()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(bar()).toBeNull();
  });

  it("a member selecting someone else's link sees how many they cannot change", async () => {
    const own = mk("l1", "spring", { createdBy: "um" });
    const { user } = boot({ me: member, page: () => ({ body: { items: [own, L2], next: null } }) });
    await ready();
    await user.keyboard("{Control>}a{/Control}");
    expect(within(bar()!).getByText("2 selected")).toBeTruthy();
    expect(within(bar()!).getByText("1 you cannot change")).toBeTruthy();
  });

  it("the bar shows every action with its shortcut and Clear Esc", async () => {
    const { user } = boot();
    await ready();
    await user.click(box("spring"));
    const b = within(bar()!);
    for (const [name, k] of [["Delete", "Shift D"], ["Schedule", "S"], ["Move", "M"], ["Redirect", "R"], ["Password", "P"], ["Copy", "C"], ["Export", "Shift E"], ["Clear", "Esc"]])
      expect(b.getByRole("button", { name: new RegExp(`^${name}`) }).textContent).toContain(k);
    await user.click(b.getByRole("button", { name: /^Clear/ }));
    expect(bar()).toBeNull();
  });

  describe("at 360 px", () => {
    const phone = () =>
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("760px") || q.includes("1080px"), media: q, addEventListener() {}, removeEventListener() {} }));
    afterEach(() => vi.useRealTimers());

    it("the pick column is hidden until a long-press starts selection mode, then a tap toggles", async () => {
      phone();
      boot();
      await ready();
      expect(boxes()).toHaveLength(0);
      vi.useFakeTimers();
      // moving more than 10 px cancels the press
      fireEvent.pointerDown(rows()[1]!, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(rows()[1]!, { clientX: 10, clientY: 30 });
      act(() => void vi.advanceTimersByTime(600));
      expect(boxes()).toHaveLength(0);
      // a still 500 ms press starts selection mode with that row, and its own click is swallowed
      expect(fireEvent.contextMenu(rows()[0]!)).toBe(false);
      // rows stay text-selectable outside selection mode, so the press clears any text selection it began
      const clear = vi.spyOn(Selection.prototype, "removeAllRanges");
      fireEvent.pointerDown(rows()[0]!, { clientX: 10, clientY: 10 });
      act(() => void vi.advanceTimersByTime(500));
      expect(clear).toHaveBeenCalled();
      fireEvent.pointerUp(rows()[0]!);
      fireEvent.click(rows()[0]!);
      vi.useRealTimers();
      expect(box("spring").checked).toBe(true);
      expect(within(bar()!).getByText("1 selected")).toBeTruthy();
      expect(location.search).not.toContain("view=detail");
      fireEvent.click(rows()[1]!);
      expect(within(bar()!).getByText("2 selected")).toBeTruthy();
      expect(location.search).not.toContain("view=detail");
    });

    it("pointercancel ends a press; holding the checkbox itself does not undo itself", async () => {
      phone();
      boot();
      await ready();
      vi.useFakeTimers();
      fireEvent.pointerDown(rows()[0]!, { clientX: 1, clientY: 1 });
      fireEvent.pointerCancel(rows()[0]!);
      act(() => void vi.advanceTimersByTime(600));
      expect(boxes()).toHaveLength(0);
      fireEvent.pointerDown(rows()[0]!, { clientX: 1, clientY: 1 });
      act(() => void vi.advanceTimersByTime(500));
      vi.useRealTimers();
      expect(within(bar()!).getByText("1 selected")).toBeTruthy();
      // now in selection mode: a press held on the menu checkbox, then its click, selects it once
      vi.useFakeTimers();
      fireEvent.pointerDown(box("menu"), { clientX: 1, clientY: 1 });
      act(() => void vi.advanceTimersByTime(500));
      fireEvent.pointerUp(box("menu"));
      fireEvent.click(box("menu"));
      vi.useRealTimers();
      expect(box("menu").checked).toBe(true);
      expect(within(bar()!).getByText("2 selected")).toBeTruthy();
    });

    it("Esc with the pushed detail open goes back to the list and keeps the selection", async () => {
      phone();
      const { user } = boot();
      await ready();
      vi.useFakeTimers();
      fireEvent.pointerDown(rows()[0]!, { clientX: 1, clientY: 1 });
      act(() => void vi.advanceTimersByTime(500));
      vi.useRealTimers();
      act(() => void history.pushState({ detail: true }, "", "/links?sel=l2&view=detail"));
      act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Selected link" })).not.toBeNull());
      (document.activeElement as HTMLElement | null)?.blur();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(location.search).not.toContain("view=detail"));
      expect(within(bar()!).getByText("1 selected")).toBeTruthy();
    });

    it("the phone bar has Delete, Schedule, Move and More; More holds the rest", async () => {
      phone();
      const { user } = boot();
      await ready();
      vi.useFakeTimers();
      fireEvent.pointerDown(rows()[0]!, { clientX: 1, clientY: 1 });
      act(() => void vi.advanceTimersByTime(500));
      vi.useRealTimers();
      const b = within(bar()!);
      for (const name of ["Delete", "Schedule", "Move", "More", "Clear"]) expect(b.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
      for (const name of ["Redirect", "Password", "Copy", "Export"]) expect(b.queryByRole("button", { name: new RegExp(`^${name}`) })).toBeNull();
      await user.click(b.getByRole("button", { name: "More" }));
      const more = screen.getByRole("dialog", { name: "More actions" });
      expect(within(more).getAllByRole("button").map((x) => x.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^Redirect/), expect.stringMatching(/^Password/), expect.stringMatching(/^Copy/), expect.stringMatching(/^Export/)]));
    });
  });
});

describe("unsaved draft guard (S2 ruling)", () => {
  const UNSAVED = "Unsaved changes: save with Ctrl+Enter or discard with Esc in the form first.";
  it("J and K with the edit sheet open never move the selection under it; the typed URL stays", async () => {
    const { api, user } = boot({ path: "/links?sel=l2" });
    await ready();
    await openEdit(user);
    await user.clear(urlInput());
    await user.type(urlInput(), "https://changed.test/");
    editSheet().focus(); // outside the text box, so J and K are not typing
    for (const k of ["j", "k"]) {
      await user.keyboard(k);
      expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
      expect(location.search).toContain("sel=l2");
      expect(urlInput().value).toBe("https://changed.test/");
    }
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("J that loads the next page stays put when an edit became dirty while the page loaded", async () => {
    let n = 0, release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user } = boot({
      path: "/links?sel=l1",
      page: async () => {
        if (++n === 1) return { body: { items: [L1], next: "100.l1" } };
        await gate;
        return { body: { items: [L2], next: null } };
      },
    });
    await ready();
    rows()[0]!.focus();
    await user.keyboard("j");
    await openEdit(user);
    await user.type(urlInput(), "x");
    release!();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(location.search).toContain("sel=l1");
    expect(urlInput().value).toBe("https://example.com/springx");
    expect(screen.getAllByText(UNSAVED).length).toBeGreaterThan(0);
  });

  it("after Esc in the sheet discards the draft, J moves again", async () => {
    const { user } = boot({ path: "/links?sel=l2" });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    rows()[1]!.focus();
    await user.keyboard("j");
    expect(rows()[2]!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Links screen follows the role", () => {
  const mine = mk("m1", "mine", { createdBy: "um" });
  it("a Member keeps today's toolbar: New link, the select column and their own link's Delete", async () => {
    boot({ me: member, path: "/links?sel=m1", page: () => ({ body: { items: [mine], next: null } }) });
    await ready();
    expect(screen.getByRole("button", { name: /New link/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select every loaded link" })).toBeTruthy();
    expect(within(detail()).getByRole("button", { name: /^Delete/ })).toBeTruthy();
  });

  it("without links.create: no New link button, N opens nothing, and their own link is read-only", async () => {
    const me: Me = { ...member, ...customRole(["links.bulk"]) };
    const { user } = boot({ me, path: "/links?sel=m1", page: () => ({ body: { items: [mine], next: null } }) });
    await ready();
    expect(screen.queryByRole("button", { name: /New link/ })).toBeNull();
    expect(within(detail()).queryByRole("button", { name: /^Delete/ })).toBeNull();
    rows()[0]!.focus();
    await user.keyboard("n");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("without links.bulk: no select column and X selects nothing", async () => {
    const me: Me = { ...member, ...customRole(["links.create"]) };
    const { user } = boot({ me });
    await ready();
    expect(screen.queryByRole("checkbox")).toBeNull();
    rows()[0]!.focus();
    await user.keyboard("x");
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("links.editAny lets a role edit a teammate's link", async () => {
    boot({ me: { ...member, ...customRole(["links.editAny"]) }, path: "/links?sel=l3" });
    await ready();
    expect(within(detail()).getByRole("button", { name: /^Delete/ })).toBeTruthy();
  });
});

describe("contact card links (S9)", () => {
  const card = { firstName: "Ada", lastName: "Lovelace", org: "", title: "", phones: [], emails: [], websites: [],
    address: { street: "", city: "", region: "", postalCode: "", country: "" }, note: "", photo: null };
  const C1 = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: card });

  it("the list marks it as a contact card with the name, not the placeholder url", async () => {
    boot({ page: () => ({ body: { items: [C1, L2], next: null } }) });
    await ready();
    expect(rows()[0]!.textContent).toContain("Contact cardAda Lovelace");
    expect(rows()[0]!.textContent).not.toContain("vcard.invalid");
  });

  it("the panel shows the card read-only; Edit opens the sheet on the card (no URL, password or routing) and saves only the card", async () => {
    const calls: unknown[] = [];
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [C1], next: null } }),
      routes: { "PATCH /api/links/l1": ({ body }) => (calls.push(body), { body: { ...C1, ...(body as object), updatedAt: 101 } }) },
    });
    await ready();
    expect(within(detail()).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(detail()).getByText("Downloads Ada Lovelace's contact card")).toBeTruthy();
    expect(detail().querySelector("input")).toBeNull();
    await user.keyboard("e");
    const sheet = editSheet();
    expect(within(sheet).queryByLabelText(/^Goes to/)).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /^Password/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /^Country and device routing/ })).toBeNull();
    expect(document.activeElement).toBe(within(sheet).getByLabelText("First name"));
    const last = within(sheet).getByLabelText("Last name");
    await user.clear(last);
    await user.type(last, "Byron");
    await user.click(within(sheet).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ vcard: { ...card, lastName: "Byron" } });
  });

  // The list sends hasPhoto instead of the photo.
  const { photo: _, ...listCard } = card;
  it("a list card without a photo opens at once and saves without hasPhoto", async () => {
    const calls: unknown[] = [];
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...listCard, hasPhoto: false } });
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [L], next: null } }),
      routes: { "PATCH /api/links/l1": ({ body }) => (calls.push(body), { body: { ...C1, ...(body as object), updatedAt: 101 } }) },
    });
    await ready();
    expect(api.calls.some((c) => c.method === "GET" && c.path === "/api/links/l1")).toBe(false);
    await openEdit(user);
    await user.type(within(editSheet()).getByLabelText("Organization"), "X");
    await user.click(within(editSheet()).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ vcard: { ...card, org: "X" } });
  });

  it("a list card with a photo loads the single read, then the panel and the edit sheet show the photo", async () => {
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...listCard, hasPhoto: true } });
    let release: (r: FakeRes) => void = () => undefined;
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [L], next: null } }),
      routes: { "GET /api/links/l1": () => new Promise<FakeRes>((r) => (release = r)) },
    });
    await screen.findByText("Loading the contact card...");
    // Not editable until the photo is in, or a save would send the card without it.
    await user.keyboard("e");
    expect(screen.queryByRole("dialog")).toBeNull();
    release({ body: { ...C1, vcard: { ...card, photo: "/9j/AAAA" } } });
    const img = (await screen.findByRole("img", { name: "Contact photo" })) as HTMLImageElement;
    expect(detail().contains(img)).toBe(true);
    expect(img.src).toBe("data:image/jpeg;base64,/9j/AAAA");
    expect(api.calls.filter((c) => c.method === "GET" && c.path === "/api/links/l1")).toHaveLength(1);
    await openEdit(user);
    expect((within(editSheet()).getByRole("img", { name: "Contact photo" }) as HTMLImageElement).src).toBe("data:image/jpeg;base64,/9j/AAAA");
  });

  it("?qr=1 on a card with a photo waits for the single read, then focuses the QR download and leaves the URL", async () => {
    let release: (r: FakeRes) => void = () => undefined;
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...listCard, hasPhoto: true } });
    boot({
      path: "/links?sel=l1&qr=1",
      page: () => ({ body: { items: [L], next: null } }),
      routes: { "GET /api/links/l1": () => new Promise<FakeRes>((r) => (release = r)) },
    });
    await screen.findByText("Loading the contact card...");
    expect(location.search).toContain("qr=1");
    release({ body: { ...C1, vcard: { ...card, photo: "/9j/AAAA" } } });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ })));
    await waitFor(() => expect(location.search).not.toContain("qr="));
  });

  it("?qr=1 stays in the URL when the card cannot be loaded", async () => {
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...listCard, hasPhoto: true } });
    boot({
      path: "/links?sel=l1&qr=1",
      page: () => ({ body: { items: [L], next: null } }),
      routes: { "GET /api/links/l1": () => ({ status: 500, body: { error: "internal" } }) },
    });
    await screen.findByText(/could not be loaded/);
    expect(location.search).toContain("qr=1");
  });

  it("Escape during a photo resize closes the edit sheet and drops the late result", async () => {
    let finish: (b64: string) => void = () => undefined;
    vi.mocked(resizePhoto).mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: card });
    const { api, user } = boot({ path: "/links?sel=l1", page: () => ({ body: { items: [L], next: null } }) });
    await ready();
    await openEdit(user);
    fireEvent.change(within(editSheet()).getByTestId("vc-file"), { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
    within(editSheet()).getByLabelText("First name").focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit link" })).toBeNull());
    finish("/9j/LATE");
    await new Promise((r) => setTimeout(r, 0));
    await openEdit(user);
    expect(within(editSheet()).queryByRole("img", { name: "Contact photo" })).toBeNull();
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a server bad_vcard on emails.0 marks the second shown row when the first is blank", async () => {
    const L = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: card });
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [L], next: null } }),
      routes: { "PATCH /api/links/l1": () => ({ status: 400, body: { error: "bad_vcard", field: "emails.0" } }) },
    });
    await ready();
    await openEdit(user);
    await user.click(within(editSheet()).getByRole("button", { name: "Add email" }));
    await user.click(within(editSheet()).getByRole("button", { name: "Add email" }));
    await user.type(within(editSheet()).getByLabelText("Email 2"), "ada@example.com");
    await user.click(within(editSheet()).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(within(editSheet()).getByLabelText("Email 2").getAttribute("aria-invalid")).toBe("true"));
    expect(within(editSheet()).getByLabelText("Email 1").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("PR #8 review fixes", () => {
  const card = { firstName: "Ada", lastName: "Lovelace", org: "", title: "", phones: [], emails: [], websites: [],
    address: { street: "", city: "", region: "", postalCode: "", country: "" }, note: "Met at the\nspring partner day", photo: null };
  const held = () => {
    let release!: () => void;
    return { gate: new Promise<void>((r) => (release = r)), release: () => release() };
  };

  it("a save from a closed sheet that lands after the link is reopened keeps the reopened sheet's edits", async () => {
    const h = held();
    const { api, user } = boot({
      path: "/links?sel=l1",
      routes: { "PATCH /api/links/l1": async ({ body }) => (await h.gate, { body: { ...L1, ...(body as object), updatedAt: 101 } }) },
    });
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/b" } });
    fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/c" } });
    h.release();
    expect(await within(detail()).findByText("https://example.com/b")).toBeTruthy(); // the summary takes the saved revision
    expect(urlInput().value).toBe("https://example.com/c"); // the open editor keeps what was typed in it
  });

  it("a Reload that failed does not make a later save drop what was typed while it saved", async () => {
    const h = held();
    let pages = 0, patches = 0;
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => (++pages === 1 ? { body: { items: [L1, L2, L3], next: null } } : { status: 500, body: { error: "internal" } }),
      routes: {
        "PATCH /api/links/l1": async ({ body }) =>
          ++patches === 1 ? { status: 409, body: { error: "conflict" } } : (await h.gate, { body: { ...L1, ...(body as object), updatedAt: 101 } }),
      },
    });
    await ready();
    await openEdit(user);
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await within(editSheet()).findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(pages).toBe(2));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/b" } });
    fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/c" } });
    h.release();
    expect(await within(detail()).findByText("https://example.com/b")).toBeTruthy();
    expect(urlInput().value).toBe("https://example.com/c");
  });

  it("a stored window that shows as one minute does not block a URL-only edit", async () => {
    const bodies: unknown[] = [];
    const minute = 4102444800; // a whole minute
    const tight = mk("l1", "spring", { startsAt: minute + 10, expiresAt: minute + 40 });
    const { user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [tight], next: null } }),
      routes: { "PATCH /api/links/l1": ({ body }) => (bodies.push(body), { body: { ...tight, ...(body as object), updatedAt: 101 } }) },
    });
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ url: "https://example.com/new" }]));
  });

  it("a route error for rows that changed while saving shows for the form, not on the wrong row", async () => {
    const h = held();
    const two = mk("l1", "spring", { routes: [{ countries: ["CA"], devices: [], url: "https://example.com/ca" }, { countries: ["US"], devices: [], url: "https://example.com/us" }] });
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [two], next: null } }),
      routes: { "PATCH /api/links/l1": async () => (await h.gate, { status: 400, body: { error: "bad_route", index: 1 } }) },
    });
    await ready();
    await openEdit(user);
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    fireEvent.click(within(editSheet()).getByRole("button", { name: "Remove rule 1" }));
    h.release();
    const msg = await within(editSheet()).findByText(errorText("bad_route"));
    expect(msg.closest(".routes")).toBeNull();
  });

  it("a card row error for rows that changed while saving shows for the form, not on the wrong row", async () => {
    const h = held();
    const two = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...card, emails: ["a@example.com", "b@example.com"] } });
    const { api, user } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [two], next: null } }),
      routes: { "PATCH /api/links/l1": async () => (await h.gate, { status: 400, body: { error: "bad_vcard", field: "emails.1" } }) },
    });
    await ready();
    await openEdit(user);
    await user.type(within(editSheet()).getByLabelText("Organization"), "Example Co");
    await user.click(within(editSheet()).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    await user.click(within(editSheet()).getByRole("button", { name: "Remove email 1" }));
    h.release();
    expect(await within(editSheet()).findByText(errorText("bad_vcard"))).toBeTruthy();
    expect(within(editSheet()).getByLabelText("Email 1").getAttribute("aria-invalid")).toBeNull();
  });

  it("Change password keeps the Password rule On until protection is turned off", async () => {
    const { user } = boot({ path: "/links?sel=l1", page: () => ({ body: { items: [mk("l1", "spring", { hasPassword: true })], next: null } }) });
    await ready();
    await openEdit(user);
    const rule = () => within(editSheet()).getByRole("button", { name: /^Password/ });
    expect(rule().textContent).toContain("On");
    await user.click(within(editSheet()).getByRole("button", { name: "Change password" }));
    expect(rule().textContent).toContain("On");
    await user.click(rule());
    expect(rule().textContent).toContain("Off");
  });

  it("the read-only card summary shows the card's note", async () => {
    boot({ path: "/links?sel=l1", page: () => ({ body: { items: [mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: card })], next: null } }) });
    await ready();
    expect(within(detail()).getByText(/Met at the\s+spring partner day/)).toBeTruthy();
  });

  it("?qr=1 waits for the row's domain when the links load first", async () => {
    const h = held();
    boot({ path: "/links?sel=l1&qr=1", routes: { "GET /api/domains": async () => (await h.gate, { body: [domain] }) } });
    await ready();
    expect(location.search).toContain("qr=1");
    expect(screen.queryByRole("dialog", { name: "QR code" })).toBeNull();
    h.release();
    expect(await screen.findByRole("dialog", { name: "QR code" })).toBeTruthy();
    await waitFor(() => expect(location.search).not.toContain("qr="));
  });

  it("a photo still resizing holds a J that was loading the next page", async () => {
    let finish: (b64: string) => void = () => undefined;
    vi.mocked(resizePhoto).mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    const C = mk("l1", "ada", { kind: "vcard", url: "https://vcard.invalid/", vcard: { ...card, note: "" } });
    let n = 0;
    const h = held();
    const { user } = boot({
      path: "/links?sel=l1",
      page: async () => {
        if (++n === 1) return { body: { items: [C], next: "100.l1" } };
        await h.gate;
        return { body: { items: [L2], next: null } };
      },
    });
    await ready();
    rows()[0]!.focus();
    await user.keyboard("j");
    await openEdit(user);
    fireEvent.change(within(editSheet()).getByTestId("vc-file"), { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
    h.release();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(location.search).toContain("sel=l1");
    expect(editSheet()).toBeTruthy();
    finish("/9j/DONE");
    expect(await within(editSheet()).findByRole("img", { name: "Contact photo" })).toBeTruthy();
  });
});
