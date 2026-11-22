import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
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

  it("Q focuses Download SVG, but not while typing in the URL field", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
    await user.click(urlInput());
    await user.keyboard("q");
    expect(urlInput().value).toBe("https://example.com/springq");
    await user.tab({ shift: true });
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("q");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ }));
  });

  it("?qr=1 with a selection focuses Download SVG on load", async () => {
    boot({ path: "/links?sel=l1&qr=1" });
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ })));
  });

  it("?qr=1 focuses once: it leaves the URL, and J after it focuses row 2", async () => {
    const { user } = boot({ path: "/links?sel=l1&qr=1" });
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Download SVG/ })));
    await waitFor(() => expect(location.search).not.toContain("qr="));
    await user.keyboard("j");
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
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
    const strokes = [...document.querySelectorAll("svg.spark polyline")].map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["#FD8D27", "#B9BEC5"]);
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
    expect(rows()[0]!.querySelector("svg.spark line[stroke-dasharray]")).not.toBeNull();
    expect(within(rows()[0]!).getByText(/Recent days not available/)).toBeTruthy();
    await user.click(rows()[0]!);
    expect(within(detail()).getByText(`${hint} These counts leave out yesterday and today.`)).toBeTruthy();
  });

  it("unknown recent days are shown as unknown when live is off", async () => {
    boot({ routes: statsRoute([], "off") });
    await ready();
    await waitFor(() => expect(document.querySelectorAll("svg.spark")).toHaveLength(3));
    expect(document.querySelector("svg.spark line[stroke-dasharray]")).not.toBeNull();
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
    expect(rows().map((r) => r.querySelector("svg.spark line[stroke-dasharray]") !== null)).toEqual([false, false, true]);
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
    await user.type(urlInput(), "x");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await within(detail()).findByRole("button", { name: "Reload" }));
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
    const dash = svg.querySelector("line[stroke-dasharray]")!;
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

  it("editing only the URL on a protected link sends exactly { url }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ url: "https://example.com/new" }]));
  });

  it("switching Password off sends { password: null }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    expect(within(detail()).getByText("Password set")).toBeTruthy();
    await user.click(within(detail()).getByRole("switch", { name: "Password" }));
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ password: null }]));
  });

  it("a new password is sent and a short one is not", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await user.click(within(detail()).getByRole("button", { name: "Change password" }));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    await save(user);
    expect(await screen.findByText(errorText("password_short"))).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ password: "longenough1" }]));
    await waitFor(() => expect((screen.queryByLabelText("New password") as HTMLInputElement | null)?.value ?? "").toBe(""));
  });

  it("Password on with nothing stored and nothing typed blocks the save, next to the password field", async () => {
    const bodies: unknown[] = [];
    const { user } = boot({ path: "/links?sel=l1", routes: patch(bodies) });
    await ready();
    await user.click(within(detail()).getByRole("switch", { name: "Password" }));
    fireEvent.change(urlInput(), { target: { value: "https://example.com/new" } });
    await save(user);
    const alert = await within(detail()).findByText(errorText("password_short"));
    expect(alert.closest(".pw")).toBeTruthy();
    expect(urlInput().closest(".field")!.parentElement!.querySelector(".err")).toBeNull();
    const input = screen.getByLabelText("New password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    // With no other change, it still says why instead of doing nothing.
    fireEvent.change(urlInput(), { target: { value: L1.url } });
    await save(user);
    expect(within(detail()).getByText(errorText("password_short"))).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("a password and a route typed while the save is pending are kept", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { api } = boot({
      path: "/links?sel=l1",
      page: () => ({ body: { items: [protectedLink], next: null } }),
      routes: { "PATCH /api/links/l1": async ({ body }) => (await held, { body: { ...protectedLink, url: "https://example.com/saved", updatedAt: 101 } }) },
    });
    await ready();
    fireEvent.click(within(detail()).getByRole("button", { name: "Change password" }));
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
    await user.click(within(detail()).getByRole("radio", { name: /301/ }));
    expect(within(detail()).getByText(errorText("password_301"))).toBeTruthy();
    await save(user);
    expect(bodies).toEqual([]);
  });

  it("adding a route sends { routes }", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await user.click(within(detail()).getByRole("button", { name: "Add rule" }));
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
    fireEvent.change(screen.getByLabelText("Rule 1 countries"), { target: { value: "ZZZ" } });
    await save(user);
    expect(await screen.findByText(errorText("route_country"))).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("switching routing off sends routes: []", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    await user.click(within(detail()).getByRole("switch", { name: "Country and device routing" }));
    await save(user);
    await waitFor(() => expect(bodies).toEqual([{ routes: [] }]));
  });

  it("Esc after toggling routing restores the saved summary with no request", async () => {
    const bodies: unknown[] = [];
    const { user } = bootP(bodies);
    await ready();
    const summary = routeSummaryText();
    await user.click(within(detail()).getByRole("switch", { name: "Country and device routing" }));
    expect(screen.queryByLabelText("Rule 1 countries")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Rule 1 countries")).toBeTruthy();
    expect(within(detail()).getByText(summary)).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it("the Campaign tags line shows non-empty utm keys and is absent without them", async () => {
    const tagged = mk("l1", "spring", { url: "https://example.com/p?utm_source=flyer&utm_campaign=spring" });
    boot({ path: "/links?sel=l1", page: () => ({ body: { items: [tagged], next: null } }) });
    await ready();
    expect(within(detail()).getByTestId("campaign-tags").textContent).toBe("Campaign tags: utm_source=flyer \u00b7 utm_campaign=spring");
  });

  it("no Campaign tags line without utm params", async () => {
    boot({ path: "/links?sel=l1" });
    await ready();
    expect(within(detail()).queryByTestId("campaign-tags")).toBeNull();
  });

  it("table row shows the lock and geo icons; a plain row has an empty rules cell", async () => {
    boot({ page: () => ({ body: { items: [protectedLink, L2], next: null } }) });
    await ready();
    expect(within(rows()[0]!).getByLabelText("Password")).toBeTruthy();
    expect(within(rows()[0]!).getByLabelText("Country and device routing")).toBeTruthy();
    expect(within(rows()[1]!).queryByLabelText("Password")).toBeNull();
    // The Rules column is the fourth cell (after the pick checkbox): empty on the plain row, holding the icons on the protected one.
    const rulesCell = (r: HTMLElement) => r.querySelectorAll("td")[3]!;
    expect(rulesCell(rows()[1]!).childNodes.length).toBe(0);
    expect(rulesCell(rows()[0]!).querySelector("svg[aria-label='Password']")).toBeTruthy();
  });

  it("a member viewing a teammate's link sees the rules read-only", async () => {
    bootP([], member);
    await ready();
    const sw = within(detail()).getByRole("switch", { name: "Password" }) as HTMLButtonElement;
    expect(sw.matches(":disabled")).toBe(true);
    expect((within(detail()).getByRole("switch", { name: "Country and device routing" }) as HTMLButtonElement).matches(":disabled")).toBe(true);
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

  it("X and Ctrl+A typed in the detail's URL field type, select nothing", async () => {
    const { user } = boot({ path: "/links?sel=l1" });
    await ready();
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
      fireEvent.pointerDown(rows()[0]!, { clientX: 10, clientY: 10 });
      act(() => void vi.advanceTimersByTime(500));
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
