import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { CfView, Domain, Me } from "../api";
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

describe("Domains keyboard", () => {
  it("Esc outside a field clears the selection", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("j");
    expect(location.search).toContain("sel=d1");
    await user.keyboard("{Escape}");
    expect(location.search).not.toContain("sel=");
    expect(screen.queryByRole("complementary", { name: "Selected domain" })).toBeNull(); // no empty panel
    expect(document.activeElement).toBe(rows()[0]); // focus back on the row that was selected
  });

  it("with the disable confirm open, Ctrl+K and G L do nothing, and one Esc closes only the confirm", async () => {
    const { user } = boot({ path: "/domains?sel=d1" });
    await ready();
    await screen.findByRole("complementary", { name: "Selected domain" });
    await user.click(rows()[0]!);
    await user.keyboard("{Shift>}D{/Shift}");
    expect(screen.getByRole("dialog", { name: "Disable domain" })).toBeTruthy();
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("gl");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(location.pathname).toBe("/domains");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(location.search).toContain("sel=d1");
  });
});

describe("Domain settings (owner)", () => {
  it("a 409 conflict on save refreshes the domain and keeps the typed values", async () => {
    let gets = 0;
    const { user } = boot({
      list: () => (gets++, [MAIN, PEND]),
      routes: { "PATCH /api/domains/d1": () => ({ status: 409, body: { error: "conflict" } }) },
      path: "/domains?sel=d1",
    });
    await screen.findByLabelText("The bare domain");
    const before = gets;
    await user.type(screen.getByLabelText("The bare domain"), "https://x.com/{Control>}{Enter}{/Control}");
    expect(await screen.findByText(errorText("conflict"))).toBeTruthy();
    await waitFor(() => expect(gets).toBeGreaterThan(before));
    expect((screen.getByLabelText("The bare domain") as HTMLInputElement).value).toBe("https://x.com/");
  });

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

  it("an edit typed while the save is pending stays; the saved field takes the server value", async () => {
    let cur = MAIN;
    let release!: () => void;
    const { user } = boot({
      list: () => [cur, PEND],
      routes: {
        "PATCH /api/domains/d1": ({ body }) =>
          new Promise((r) => (release = () => r({ body: (cur = { ...cur, bareRedirect: `${(body as { bareRedirect: string }).bareRedirect}norm` }) }))),
      },
      path: "/domains?sel=d1",
    });
    await screen.findByLabelText("The bare domain");
    await user.type(screen.getByLabelText("The bare domain"), "https://x.com/{Control>}{Enter}{/Control}");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await user.type(screen.getByLabelText("A missing or deleted link"), "https://y.com/");
    release();
    await waitFor(() => expect((screen.getByLabelText("The bare domain") as HTMLInputElement).value).toBe("https://x.com/norm"));
    expect((screen.getByLabelText("A missing or deleted link") as HTMLInputElement).value).toBe("https://y.com/");
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
    // The answer is held until both Enters are in, so the second one always lands while the first is in flight
    // (before, a fast 409 closed the confirm between them and the second Enter reopened it, clearing the error).
    let release!: () => void;
    const { api, user } = boot({
      list: () => [dom("d1", "go.test", { type: "main", caseSensitive: true }), PEND],
      routes: { "PATCH /api/domains/d1": () => new Promise((r) => (release = () => r({ status: 409, body: { error: "case_conflict" } }))) },
      path: "/domains?sel=d1",
    });
    await user.click(await screen.findByRole("switch", { name: "Case-sensitive slugs" }));
    expect(screen.getByRole("dialog").textContent).toContain("Turn off case-sensitive slugs for go.test?");
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
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

const OUT: CfView = {
  kind: "outside", dns: "missing", ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1,
  instructions: { type: "CNAME", name: "cafe", target: "edge.example.net", apex: false }, attachOnApproval: false, attached: true, securityLevel: null, rateLimit: null,
};
const GREEN: CfView = { ...OUT, dns: "found", ownership: "verified", certificate: "issued" };
const PEND_CF = { ...PEND, cloudflare: GREEN };

describe("Ownership, approve and reject", () => {
  it("managers see Ownership and certificate; a member who cannot manage does not", async () => {
    boot({ list: () => [MAIN, { ...PEND, cloudflare: OUT }], path: "/domains?sel=d2" });
    await screen.findByRole("heading", { name: "Ownership and certificate" });
    expect(panel().textContent).toContain("cafe → edge.example.net");
    expect(within(panel()).getByText("DNS record missing")).toBeTruthy();
    cleanup();
    boot({ me: member, list: () => [{ ...MAIN, cloudflare: OUT }], path: "/domains?sel=d1" });
    await screen.findByLabelText("The bare domain");
    expect(screen.queryByRole("heading", { name: "Ownership and certificate" })).toBeNull();
  });

  it("a disabled domain's detail never polls, even with checks not green", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api } = boot({ list: () => [MAIN, { ...PEND, status: "disabled", cloudflare: OUT }], path: "/domains?sel=d2" });
      await screen.findByRole("heading", { name: "Ownership and certificate" });
      await vi.advanceTimersByTimeAsync(20000);
      expect(api.calls.filter((c) => c.path === "/api/domains/d2/cloudflare")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an attached account domain with a refusal stored shows its copy and offers no Finish connecting", async () => {
    const acc: CfView = { ...GREEN, kind: "account", instructions: null, lastError: "route_in_use" };
    boot({ list: () => [{ ...MAIN, cloudflare: acc }], path: "/domains?sel=d1" });
    await screen.findByRole("heading", { name: "Ownership and certificate" });
    expect(panel().textContent).toContain(errorText("route_in_use"));
    expect(within(panel()).getByText("Not connected")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /Finish connecting/ })).toBeNull();
  });

  it("A on a pending unverified domain shows the not-verified text and leaves the tag", async () => {
    const { api, user } = boot({
      list: () => [MAIN, PEND_CF],
      routes: { "POST /api/domains/d2/approve": () => ({ status: 409, body: { error: "not_verified", cloudflare: OUT } }) },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    await user.keyboard("a");
    expect(await within(panel()).findByText("Checks have not passed yet")).toBeTruthy();
    expect(panel().textContent).toContain("Waiting for the DNS record");
    expect(within(panel()).queryByText("Active")).toBeNull();
    expect(api.calls.filter((c) => c.path === "/api/domains/d2/approve")[0]!.body).toEqual({});
  });

  it("A with dns_record_exists asks to confirm the takeover; Enter resends with confirmTakeover", async () => {
    let cur = PEND_CF;
    const { api, user } = boot({
      list: () => [MAIN, cur],
      routes: {
        "POST /api/domains/d2/approve": ({ body }) =>
          (body as { confirmTakeover?: boolean }).confirmTakeover ? ((cur = { ...cur, status: "active" }), { body: cur }) : { status: 409, body: { error: "dns_record_exists" } },
      },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    await user.keyboard("a");
    expect((await screen.findByRole("dialog")).textContent).toContain("Approve and send cafe.test traffic to linkwarren?");
    const dlg = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dlg).getByRole("button", { name: /^Cancel/ })); // a stray Enter cancels
    const send = within(dlg).getByRole("button", { name: /^Send traffic/ });
    send.focus();
    expect(fireEvent.keyDown(send, { key: "Enter", repeat: true })).toBe(false); // autorepeat is swallowed
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(panel()).getByText("Active")).toBeTruthy());
    expect(api.calls.filter((c) => c.path === "/api/domains/d2/approve").map((c) => c.body)).toEqual([{}, { confirmTakeover: true }]);
  });

  it("Enter on Approve then an immediate second Enter does not confirm the takeover", async () => {
    const { api, user } = boot({
      list: () => [MAIN, PEND_CF],
      routes: { "POST /api/domains/d2/approve": () => ({ status: 409, body: { error: "dns_record_exists" } }) },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    (within(panel()).getByRole("button", { name: /^Approve/ }) as HTMLElement).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Enter}"); // the double tap lands on Cancel
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.filter((c) => c.path === "/api/domains/d2/approve").map((c) => c.body)).toEqual([{}]);
  });

  it("approve with loopLinks shows the loop notice with a link to those links", async () => {
    let cur = PEND_CF;
    const { user } = boot({
      list: () => [MAIN, cur],
      routes: { "POST /api/domains/d2/approve": () => ((cur = { ...cur, status: "active" }), { body: { ...cur, loopLinks: 2 } }) },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    await user.keyboard("a");
    expect(await within(panel()).findByText(/2 existing links point at cafe.test and now loop\./)).toBeTruthy();
    expect(within(panel()).getByRole("link", { name: "Edit them" }).getAttribute("href")).toBe("/links?q=cafe.test");
    expect([...document.querySelectorAll("[aria-live]")].map((n) => n.textContent).join(" ")).toContain("2 existing links point at cafe.test and now loop");
  });

  it("Shift+R opens the reject confirm: Esc sends nothing, Enter sends DELETE and removes the row", async () => {
    let list = [MAIN, PEND_CF];
    const { api, user } = boot({
      list: () => list,
      routes: { "DELETE /api/domains/d2": () => ((list = [MAIN]), { status: 204 }) },
      path: "/domains?sel=d2",
    });
    await screen.findByLabelText("The bare domain");
    await user.keyboard("{Shift>}R{/Shift}");
    expect(screen.getByRole("dialog").textContent).toContain("Reject cafe.test? Its 4 links are deleted. This cannot be undone.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches(api)).toHaveLength(0);
    await user.keyboard("{Shift>}R{/Shift}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(patches(api)).toEqual([{ method: "DELETE", path: "/api/domains/d2", body: undefined }]);
    expect(location.search).not.toContain("sel=d2");
  });

  it("Shift+R inside an input types R", async () => {
    const { api, user } = boot({ list: () => [MAIN, PEND_CF], path: "/domains?sel=d2" });
    const input = await screen.findByLabelText("The bare domain");
    await user.type(input, "{Shift>}R{/Shift}");
    expect((input as HTMLInputElement).value).toBe("R");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches(api)).toHaveLength(0);
  });

  it("members see no Reject and Shift+R does nothing", async () => {
    const { api, user } = boot({ me: member, list: () => [MAIN, PEND_CF], path: "/domains?sel=d2" });
    await screen.findByLabelText("The bare domain");
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
    await user.keyboard("{Shift>}R{/Shift}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches(api)).toHaveLength(0);
  });

  it("F finishes connecting an active account domain that is not attached", async () => {
    const half: CfView = { ...OUT, kind: "account", instructions: null, dns: "missing", ownership: "pending", certificate: "issued", attached: false };
    const { api, user } = boot({
      list: () => [MAIN, dom("d4", "acc.test", { cloudflare: half })],
      routes: { "POST /api/domains/d4/approve": () => ({ body: { ...dom("d4", "acc.test"), cloudflare: { ...half, dns: "found", ownership: "verified" } } }) },
      path: "/domains?sel=d4",
    });
    await screen.findByLabelText("The bare domain");
    expect(within(panel()).getByRole("button", { name: /Finish connecting/ })).toBeTruthy();
    await user.keyboard("f");
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/domains/d4/approve")).toHaveLength(1));
    expect(within(panel()).queryByText("Approve domain")).toBeNull();
  });
});

describe("Cloudflare controls in the detail", () => {
  const ACC: CfView = { ...GREEN, kind: "account", instructions: null, securityLevel: "high", rateLimit: 40 };
  const settings = { configured: true, outsideReady: true, accountName: "A", cnameTarget: null, fallbackOrigin: null, hostnames: null, attachedCount: 0, controlsEnabled: true };
  const gets = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === "/api/settings/cloudflare");

  it("an owner sees the stored High and 40 on an account domain", async () => {
    boot({ list: () => [{ ...MAIN, cloudflare: ACC }], routes: { "GET /api/settings/cloudflare": () => ({ body: settings }) }, path: "/domains?sel=d1" });
    expect((await screen.findByLabelText("Rate limit") as HTMLInputElement).value).toBe("40");
    expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");
  });

  it("a member never reads the owner-only settings", async () => {
    const { api } = boot({ me: member, list: () => [{ ...MAIN, ownerId: "um", cloudflare: ACC }], routes: { "GET /api/settings/cloudflare": () => ({ body: settings }) }, path: "/domains?sel=d1" });
    await screen.findByLabelText("The bare domain");
    expect(screen.queryByLabelText("Rate limit")).toBeNull();
    expect(gets(api)).toHaveLength(0);
  });

  it("an outside domain renders no controls and asks nothing", async () => {
    const { api } = boot({ list: () => [{ ...MAIN, cloudflare: OUT }], routes: { "GET /api/settings/cloudflare": () => ({ body: settings }) }, path: "/domains?sel=d1" });
    await screen.findByLabelText("The bare domain");
    expect(screen.queryByLabelText("Rate limit")).toBeNull();
    expect(gets(api)).toHaveLength(0);
  });
});
