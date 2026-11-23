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
});

describe("one search", () => {
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
