import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { OWNER_ROLE } from "../test/roles";
import { parseCsvLines, linksFromCsv } from "../setup/parseLinks";
import { toCsv } from "./bulk";

// S12: the optional link name in the dashboard, and the one search (the top bar) with its removable q chip.
const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
const domain: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 2, isMember: false,
};
const mk = (id: string, slug: string, o: Partial<Link> = {}): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, kind: "url", createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
});
const NAMED = mk("l1", "spring", { name: "Spring poster" }), PLAIN = mk("l2", "menu");

function boot(path: string, routes: FakeRoutes = {}) {
  history.replaceState(null, "", path);
  const api = fakeApi({
    "GET /api/me": () => ({ body: owner }),
    "GET /api/domains": () => ({ body: [domain] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [NAMED, PLAIN], next: null } }),
    "GET /api/links/check": () => ({ body: { status: "available" } }),
    ...routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const rows = () => screen.getAllByRole("row").slice(1);
const ready = () => waitFor(() => expect(rows().length).toBe(2));
const ready1 = () => waitFor(() => expect(rows().length).toBe(1));
const detail = () => screen.getByRole("complementary", { name: "Selected link" });
afterEach(() => vi.unstubAllGlobals());

describe("link name in the dashboard", () => {
  it("a named row leads with the name and keeps the short link under it; an unnamed row is unchanged", async () => {
    boot("/links");
    await ready();
    expect(within(rows()[0]!).getByText("Spring poster", { selector: ".lname" })).toBeTruthy();
    expect(rows()[0]!.querySelector("small .mchip")!.textContent).toBe("go.test/spring");
    expect(rows()[1]!.querySelector(".lname")).toBeNull();
    expect(rows()[1]!.querySelector(".t > .mchip")!.textContent).toBe("go.test/menu");
    expect(rows()[1]!.querySelector("small .mchip")).toBeNull();
  });

  it("the panel title is the name only when set", async () => {
    const { user } = boot("/links?sel=l1");
    await ready();
    expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy();
    await user.click(rows()[1]!);
    await waitFor(() => expect(detail().querySelector(".title")).toBeNull());
    expect(detail().querySelector(".short")!.textContent).toBe("go.test/menu");
  });

  it("the edit sheet sends a changed name, trimmed, and an emptied one as null", async () => {
    const bodies: unknown[] = [];
    const { user } = boot("/links?sel=l1", {
      "PATCH /api/links/l1": ({ body }) => (bodies.push(body), { body: { ...NAMED, ...(body as object), updatedAt: 101 } }),
    });
    await ready();
    await user.keyboard("e");
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.value).toBe("Spring poster");
    fireEvent.change(name, { target: { value: "  Spring sale  " } });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ name: "Spring sale" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.keyboard("e");
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "" } });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toEqual([{ name: "Spring sale" }, { name: null }]));
  });

  it("New link sends the name only when one is typed; a control character is refused next to the field", async () => {
    const posts: unknown[] = [];
    const { user } = boot("/links", { "POST /api/links": ({ body }) => (posts.push(body), { status: 201, body: { ...PLAIN, id: "n1", slug: "a" } }) });
    await ready();
    await user.keyboard("n");
    const sheet = screen.getByRole("dialog", { name: "New link" });
    fireEvent.change(within(sheet).getByLabelText(/^Goes to/), { target: { value: "https://example.com/a" } });
    fireEvent.change(within(sheet).getByLabelText(/^Short link/), { target: { value: "a" } });
    await within(sheet).findByText(/Available/);
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: "a\tb" } });
    await user.click(within(sheet).getByRole("button", { name: /^Create link/ }));
    expect(within(sheet).getByText(errorText("bad_link_name"))).toBeTruthy();
    expect(posts).toEqual([]);
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: "Spring" } });
    await user.click(within(sheet).getByRole("button", { name: /^Create link/ }));
    await waitFor(() => expect(posts).toEqual([{ domainId: "d1", slug: "a", url: "https://example.com/a", redirectCode: 302, name: "Spring" }]));
  });

  it("the palette lists a named link by its name, with the short link beside it", async () => {
    const { user } = boot("/links", { "GET /api/links": (r) => ({ body: { items: r.url.searchParams.get("q") === "poster" ? [NAMED] : [NAMED, PLAIN], next: null } }) });
    await ready();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: /Search or shortcut/ }), "poster");
    const item = await within(screen.getByRole("listbox")).findByText("Spring poster");
    expect(item.closest("[role=option]")!.textContent).toContain("go.test/spring");
  });

  it("CSV export carries the name and a CSV import reads it back", () => {
    const csv = toCsv([NAMED, PLAIN], () => "go.test", () => "You");
    const { rows: r, lines } = parseCsvLines(csv);
    const { body, errors } = linksFromCsv(r, "go.test", lines);
    expect(errors).toEqual([]);
    expect(body.links.map((l) => [l.slug, l.name ?? null])).toEqual([["spring", "Spring poster"], ["menu", null]]);
  });

  it("the CSV round trip keeps names the formula guard touches, and names that start with an apostrophe", () => {
    const names = ["@Team", "=sum", "-1 off", "'quoted", "'@both", "it's fine"];
    const links = names.map((name, i) => mk(`n${i}`, `s${i}`, { name }));
    const csv = toCsv(links, () => "go.test", () => "You");
    expect(csv).toContain(",'@Team");
    const { rows: r, lines } = parseCsvLines(csv);
    expect(linksFromCsv(r, "go.test", lines).body.links.map((l) => l.name)).toEqual(names);
  });
});

describe("one search", () => {
  it("clearing the search on Links drops only q: the selected link stays open", async () => {
    const { user } = boot("/links?q=spring&sel=l1");
    await ready();
    expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(location.search).toBe("?sel=l1"));
    expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy();
  });

  it("a palette pick past the loaded page still opens its panel: the link is read by id and listed first", async () => {
    const { api } = boot("/links?q=spring&sel=l1", {
      "GET /api/links": () => ({ body: { items: [PLAIN], next: "100.l2" } }),
      "GET /api/links/l1": () => ({ body: NAMED }),
    });
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(api.calls.filter((c) => c.path === "/api/links/l1")).toHaveLength(1);
  });

  it("J after a link read by id moves to the rows a page really adds, and a page of nothing new moves nowhere", async () => {
    const NEXT = mk("l3", "next");
    let page = 0;
    const { user } = boot("/links?sel=l1", {
      "GET /api/links": (r) => {
        if (!r.url.searchParams.get("cursor")) { page = 0; return { body: { items: [PLAIN], next: "c1" } }; }
        page++;
        return { body: page === 1 ? { items: [NAMED], next: "c2" } : { items: [NAMED, NEXT], next: null } };
      },
      "GET /api/links/l1": () => ({ body: NAMED }),
    });
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
    rows()[0]!.focus();
    await user.keyboard("j"); // to menu, the last loaded row
    await waitFor(() => expect(location.search).toBe("?sel=l2"));
    await user.keyboard("j"); // the next page holds only spring, already listed: stay on menu
    await waitFor(() => expect(page).toBe(1));
    expect(location.search).toBe("?sel=l2");
    await user.keyboard("j"); // the page after adds next: J lands on it, not on spring
    await waitFor(() => expect(location.search).toBe("?sel=l3"));
    expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["spring", "menu", "next"]);
  });

  it("a reload keeps the row read by id while selected and refreshes it; a link gone by then is dropped and its panel closes", async () => {
    let reads = 0;
    const { user } = boot("/links?sel=l1", {
      "GET /api/links": () => ({ body: { items: [PLAIN], next: "c1" } }),
      "GET /api/links/l1": () => (++reads === 1 ? { body: NAMED } : reads === 2 ? { body: { ...NAMED, name: "Renamed elsewhere", updatedAt: 150 } } : { status: 404, body: { error: "not_found" } }),
      "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }),
    });
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
    const conflictReload = async () => {
      await user.keyboard("e");
      fireEvent.change(screen.getByLabelText(/^Goes to/), { target: { value: "https://example.com/x" } });
      await user.keyboard("{Control>}{Enter}{/Control}");
      await user.click(await screen.findByRole("button", { name: "Reload" }));
      await user.keyboard("{Escape}");
    };
    await conflictReload();
    await waitFor(() => expect(within(detail()).getByText("Renamed elsewhere", { selector: ".title" })).toBeTruthy());
    expect(reads).toBe(2);
    await conflictReload();
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Selected link" })).toBeNull());
    expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["menu"]);
  });

  it("a read that answers after the selection moved is dropped; an older answer never replaces a newer row", async () => {
    let release!: (r: { body: unknown }) => void;
    const { user } = boot("/links?sel=l1", {
      "GET /api/links": (r) => ({ body: r.url.searchParams.get("cursor") ? { items: [{ ...NAMED, name: "Newer", updatedAt: 150 }], next: null } : { items: [PLAIN], next: "c1" } }),
      "GET /api/links/l1": () => new Promise((r) => (release = r)),
    });
    await ready1();
    // The page brings the link at a newer revision while the read is still out: the late, older answer keeps it.
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(detail()).getByText("Newer", { selector: ".title" })).toBeTruthy());
    release({ body: NAMED });
    await new Promise((r) => setTimeout(r, 0));
    expect(within(detail()).getByText("Newer", { selector: ".title" })).toBeTruthy();
    expect(rows()).toHaveLength(2);
  });

  it("a bulk delete while the retained row's refresh is out keeps it deleted when the refresh answers", async () => {
    let reads = 0;
    let release!: (r: { body: unknown }) => void;
    const { api, user } = boot("/links?sel=l1", {
      "GET /api/links": () => ({ body: { items: [PLAIN], next: "c1" } }),
      "GET /api/links/l1": () => (++reads === 1 ? { body: NAMED } : new Promise((r) => (release = r))),
      "PATCH /api/links/l1": () => ({ status: 409, body: { error: "conflict" } }),
      "POST /api/links/bulk": (r) => ({ body: { results: (r.body as { ids: string[] }).ids.map((id) => ({ id, ok: true })), pending: [] } }),
    });
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
    // A same-scope reload (Reload after a conflict) keeps the row and refreshes it; that read is held.
    await user.keyboard("e");
    fireEvent.change(screen.getByLabelText(/^Goes to/), { target: { value: "https://example.com/x" } });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(await screen.findByRole("button", { name: "Reload" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(reads).toBe(2));
    rows()[0]!.focus();
    await user.keyboard("x"); // pick spring
    await user.keyboard("{Shift>}D{/Shift}");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/links/bulk")).toBe(true));
    await waitFor(() => expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["menu"]));
    release({ body: NAMED });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["menu"]);
  });

  it("a read still out when the selection moves never brings its row back", async () => {
    let release!: (r: { body: unknown }) => void;
    const { user } = boot("/links?sel=l1", {
      "GET /api/links": () => ({ body: { items: [PLAIN], next: "c1" } }),
      "GET /api/links/l1": () => new Promise((r) => (release = r)),
    });
    await ready1();
    await user.click(rows()[0]!); // select menu while spring's read is out
    await waitFor(() => expect(location.search).toBe("?sel=l2"));
    release({ body: NAMED });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["menu"]);
  });

  it("the link read by id is never listed twice when a later page brings it, and a new list (a filter change) reads it again", async () => {
    const { api, user } = boot("/links?q=spring&sel=l1", {
      "GET /api/links": (r) => ({ body: r.url.searchParams.get("cursor") ? { items: [NAMED], next: null } : { items: [PLAIN], next: "100.l2" } }),
      "GET /api/links/l1": () => ({ body: NAMED }),
    });
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path.includes("cursor="))).toHaveLength(1));
    await waitFor(() => expect(rows().map((r) => r.querySelector(".slug")!.textContent)).toEqual(["spring", "menu"]));
    await user.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/links/l1")).toHaveLength(2));
    await waitFor(() => expect(within(detail()).getByText("Spring poster", { selector: ".title" })).toBeTruthy());
  });

  it("clearing the search on Domains drops only q, so the selected domain stays", async () => {
    const { user } = boot("/domains?q=go&sel=d1");
    await screen.findByText("go", { selector: ".qchip b" });
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(location.search).toBe("?sel=d1"));
  });

  it("the top bar's Search opens the palette; the page has no second search box", async () => {
    const { user } = boot("/links");
    await ready();
    expect(screen.queryByRole("button", { name: /Search slugs/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    expect(screen.getByRole("combobox", { name: /Search or shortcut/ })).toBeTruthy();
  });

  it("an active ?q= shows as a chip whose clear button drops the filter and reloads the list", async () => {
    const { api, user } = boot("/links?q=spring");
    await ready();
    expect(screen.getByText("spring", { selector: ".qchip b" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(location.search).toBe(""));
    expect(screen.queryByText("spring", { selector: ".qchip b" })).toBeNull();
    await waitFor(() => expect(api.calls.filter((c) => c.path.startsWith("/api/links")).at(-1)!.path).toBe("/api/links"));
  });
});
