import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const dom = (id: string, host: string, o: Partial<Domain> = {}): Domain => ({
  id, host, type: "shared", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 2, isMember: true, ...o,
});
const MAIN = dom("d1", "go.test", { type: "main" });
const PEND = dom("d2", "cafe.test", { type: "private", status: "pending", ownerId: "um", linkCount: 4 });
const OTHER = dom("d3", "other.test", { type: "private", ownerId: "ux" });

function boot(opts: { me?: Me; list?: () => Domain[]; routes?: FakeRoutes; path?: string } = {}) {
  history.replaceState(null, "", opts.path ?? "/domains");
  const state = [MAIN, PEND];
  const api = fakeApi({
    "GET /api/me": () => ({ body: opts.me ?? owner }),
    "GET /api/domains": () => ({ body: opts.list ? opts.list() : state }),
    "GET /api/users": () => ({ body: { items: [] } }),
    ...opts.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const rows = () => screen.getAllByRole("row").slice(1);
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const panel = () => screen.getByRole("complementary", { name: "Selected domain" });
const patches = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
afterEach(() => vi.unstubAllGlobals());

describe("Domains list", () => {
  it("Needs approval chip shows only pending domains and the owner sees the waiting count", async () => {
    const { user } = boot();
    await ready();
    expect(screen.getByText("1 waiting for you")).toBeTruthy();
    expect(rows()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Needs approval" }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("cafe.test")).toBeTruthy();
  });

  it("J selects, ?sel is in the URL, and the detail shows the host", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("j");
    expect(location.search).toContain("sel=d1");
    expect(within(panel()).getByText("go.test")).toBeTruthy();
  });
});

describe("Domain settings (owner)", () => {
  it("editing only the bare redirect sends only that key; clearing sends null", async () => {
    const saved = dom("d1", "go.test", { type: "main", bareRedirect: "https://x.com/" });
    let cur = MAIN;
    const { api, user } = boot({
      list: () => [cur, PEND],
      routes: {
        "PATCH /api/domains/d1": ({ body }) => {
          cur = { ...cur, ...(body as object) } as Domain;
          return { body: cur };
        },
      },
      path: "/domains?sel=d1",
    });
    await screen.findByLabelText("The bare domain");
    await user.type(screen.getByLabelText("The bare domain"), "https://x.com/{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ bareRedirect: saved.bareRedirect });
    await user.clear(screen.getByLabelText("The bare domain"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches(api)).toHaveLength(2));
    expect(patches(api)[1]!.body).toEqual({ bareRedirect: null });
  });

  it("an unchanged form sends nothing", async () => {
    const { api, user } = boot({ path: "/domains?sel=d1" });
    await screen.findByLabelText("The bare domain");
    await user.click(screen.getByLabelText("The bare domain"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(patches(api)).toHaveLength(0);
  });

  it("case switch opens a confirm: Esc sends nothing, Enter sends caseSensitive", async () => {
    let cur = MAIN;
    const { api, user } = boot({
      list: () => [cur, PEND],
      routes: { "PATCH /api/domains/d1": ({ body }) => ((cur = { ...cur, ...(body as object) } as Domain), { body: cur }) },
      path: "/domains?sel=d1",
    });
    await user.click(await screen.findByRole("switch", { name: "Case-sensitive slugs" }));
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain("Turn on case-sensitive slugs for go.test?");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches(api)).toHaveLength(0);
    expect(screen.getByRole("switch", { name: "Case-sensitive slugs" }).getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("switch", { name: "Case-sensitive slugs" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ caseSensitive: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Case-sensitive slugs" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("a case_conflict 409 shows its copy and the switch stays at the saved state; double Enter sends once", async () => {
    const { api, user } = boot({
      list: () => [dom("d1", "go.test", { type: "main", caseSensitive: true }), PEND],
      routes: { "PATCH /api/domains/d1": () => ({ status: 409, body: { error: "case_conflict" } }) },
      path: "/domains?sel=d1",
    });
    await user.click(await screen.findByRole("switch", { name: "Case-sensitive slugs" }));
    expect(screen.getByRole("dialog").textContent).toContain("Turn off case-sensitive slugs for go.test?");
    await user.keyboard("{Enter}{Enter}");
    expect(await screen.findByText(errorText("case_conflict"))).toBeTruthy();
    expect(patches(api)).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "Case-sensitive slugs" }).getAttribute("aria-checked")).toBe("true");
  });

  it("invalid reserved text shows the error and sends no request", async () => {
    const { api, user } = boot({ path: "/domains?sel=d1" });
    await user.type(await screen.findByLabelText("Reserved slugs"), "a/b{Control>}{Enter}{/Control}");
    expect(await screen.findByText(errorText("invalid_reserved"))).toBeTruthy();
    expect(patches(api)).toHaveLength(0);
  });

  it("A on a pending domain posts approve and the tag becomes Active; Disable confirms first", async () => {
    let cur = PEND;
    const { api, user } = boot({
      list: () => [MAIN, cur],
      routes: {
        "POST /api/domains/d2/approve": () => ((cur = { ...cur, status: "active" }), { body: cur }),
        "POST /api/domains/d2/disable": () => ((cur = { ...cur, status: "disabled" }), { body: cur }),
      },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    expect(panel().textContent).toContain('4 links are already here. They show a "not active yet" page until you approve the domain.');
    await user.keyboard("a");
    await waitFor(() => expect(within(panel()).getByText("Active")).toBeTruthy());
    expect(api.calls.some((c) => c.path === "/api/domains/d2/approve")).toBe(true);
    await user.keyboard("{Shift>}d{/Shift}");
    expect(screen.getByRole("dialog").textContent).toContain("Disable cafe.test? Its short links stop working until you enable it again.");
    await user.keyboard("{Escape}");
    expect(api.calls.some((c) => c.path.endsWith("/disable"))).toBe(false);
    await user.keyboard("{Shift>}d{/Shift}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(panel()).getByText("Disabled")).toBeTruthy());
    expect(within(panel()).getByRole("button", { name: /Enable domain/ })).toBeTruthy();
  });

  it("A typed in the bare redirect input types a and posts nothing", async () => {
    const { api, user } = boot({ path: "/domains?sel=d2" });
    const input = await screen.findByLabelText("The bare domain");
    await user.type(input, "a");
    expect((input as HTMLInputElement).value).toBe("a");
    expect(patches(api)).toHaveLength(0);
  });
});

describe("Domain settings (member)", () => {
  it("sees no Approve or Disable, A sends nothing, and the main domain is read-only", async () => {
    const { api, user } = boot({ me: member, list: () => [MAIN, PEND, OTHER], path: "/domains?sel=d1" });
    const bare = (await screen.findByLabelText("The bare domain")) as HTMLInputElement;
    expect(bare.readOnly || bare.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Approve domain|Enable domain|Disable/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    await user.keyboard("a");
    expect(patches(api)).toHaveLength(0);
    expect(screen.queryByText("Shared with")).toBeNull();
  });

  it("a member who owns a private domain can edit and save its settings", async () => {
    const { api, user } = boot({
      me: member,
      list: () => [MAIN, PEND],
      routes: { "PATCH /api/domains/d2": ({ body }) => ({ body: { ...PEND, ...(body as object) } }) },
      path: "/domains?sel=d2",
    });
    await user.click(await screen.findByRole("switch", { name: "Hide from search engines" }));
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ noindex: false });
    expect(panel().textContent).toContain('Links here show a "not active yet" page until the owner approves the domain.');
  });
});
