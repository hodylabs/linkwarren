import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const dm: Domain = {
  id: "dm", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false,
};
const dx: Domain = { ...dm, id: "dx", host: "alt.test" };
const dd: Domain = { ...dm, id: "dd", host: "off.test", status: "disabled" };
const created: Link = {
  id: "new1", domainId: "dm", slug: "spring", slugKey: "spring", url: "https://x.com/a", redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100,
};

type Opts = { me?: Me; routes?: FakeRoutes; check?: (slug: string, domain: string) => FakeRes | Promise<FakeRes> };
function boot(o: Opts = {}) {
  history.replaceState(null, "", "/links");
  const api = fakeApi({
    "GET /api/me": () => ({ body: o.me ?? owner }),
    "GET /api/domains": () => ({ body: [dm, dx, dd] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [], next: null } }),
    "GET /api/links/check": (r) => (o.check ?? (() => ({ body: { status: "available" } })))(r.url.searchParams.get("slug")!, r.url.searchParams.get("domain")!),
    "POST /api/links": () => ({ status: 201, body: created }),
    ...o.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() => expect(screen.getByRole("button", { name: /New link/ })).toBeTruthy());
  await user.click(screen.getByRole("button", { name: /New link/ }));
  return screen.getByRole("dialog", { name: "New link" });
};
const dest = () => screen.getByLabelText(/^Goes to/) as HTMLInputElement;
const slugBox = () => screen.getByLabelText(/^Short link/) as HTMLInputElement;
const posts = (api: { calls: { method: string; body: unknown }[] }) => api.calls.filter((c) => c.method === "POST").map((c) => c.body);
const checks = (api: { calls: { path: string }[] }) => api.calls.filter((c) => c.path.startsWith("/api/links/check"));
const setVal = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
afterEach(() => vi.unstubAllGlobals());

describe("New link sheet", () => {
  it("focuses Goes to first and Esc cancels without a POST", async () => {
    const { api, user } = boot();
    await open(user);
    expect(document.activeElement).toBe(dest());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull();
    expect(posts(api)).toEqual([]);
  });

  it("a stale answer never overwrites a newer one, and a domain change re-checks", async () => {
    const gates = new Map<string, (r: FakeRes) => void>();
    const { api, user } = boot({ check: (slug, d) => new Promise((res) => gates.set(`${d}/${slug}`, res)) });
    await open(user);
    await user.type(slugBox(), "spr");
    await waitFor(() => expect(checks(api)).toHaveLength(1));
    await user.type(slugBox(), "ing");
    await waitFor(() => expect(checks(api)).toHaveLength(2));
    gates.get("dm/spring")!({ body: { status: "available" } });
    await screen.findByText(/Available/);
    gates.get("dm/spr")!({ body: { status: "taken" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Available/)).toBeTruthy();
    expect(screen.queryByText("Taken on this domain")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Domain"), "dx");
    await waitFor(() => expect(checks(api)).toHaveLength(3));
    expect(checks(api)[2]!.path).toContain("domain=dx");
  });

  it("lists only usable domains and Alt+D focuses the domain select", async () => {
    const { user } = boot();
    const sheet = await open(user);
    const options = within(sheet).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["go.test", "alt.test"]);
    await user.keyboard("{Alt>}d{/Alt}");
    expect(document.activeElement).toBe(screen.getByLabelText("Domain"));
  });

  it("Ctrl+Enter sends exactly the four fields", async () => {
    const { api, user } = boot();
    await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    await screen.findByText(/Available/);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toEqual([{ domainId: "dm", slug: "spring", url: "https://x.com/a", redirectCode: 302 }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
    expect(location.search).toBe("?sel=new1");
  });

  it("Ctrl+Shift+Enter also copies the short URL", async () => {
    const { api, user } = boot();
    await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    await screen.findByText(/Available/);
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("https://go.test/spring"));
  });

  it("a 409 taken shows at the slug, keeps the sheet and the values", async () => {
    const { user } = boot({ routes: { "POST /api/links": () => ({ status: 409, body: { error: "taken" } }) } });
    await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText(errorText("taken"))).toBeTruthy();
    expect(slugBox().getAttribute("aria-invalid")).toBe("true");
    expect(dest().value).toBe("https://x.com/a");
    expect(slugBox().value).toBe("spring");
    expect(screen.getByText("Taken on this domain")).toBeTruthy();
  });

  it("is blocked client side while the check says taken", async () => {
    const { api, user } = boot({ check: () => ({ body: { status: "taken" } }) });
    await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    await screen.findByText("Taken on this domain");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toEqual([]);
  });

  it("n, t and s stay text in the destination; t outside inputs opens the campaign tags", async () => {
    const { user } = boot();
    const sheet = await open(user);
    await user.type(dest(), "nts");
    expect(dest().value).toBe("nts");
    expect(within(sheet).queryByLabelText("Source")).toBeNull();
    sheet.focus();
    await user.keyboard("t");
    expect(within(sheet).getByLabelText("Source")).toBeTruthy();
    await user.keyboard("s");
    expect(within(sheet).getByLabelText("Starts")).toBeTruthy();
  });

  it("campaign tags are disabled until the destination is a URL, then write into it", async () => {
    const { user } = boot();
    const sheet = await open(user);
    sheet.focus();
    await user.keyboard("t");
    expect(within(sheet).getByText("Enter a full URL first")).toBeTruthy();
    expect((within(sheet).getByLabelText("Source") as HTMLInputElement).disabled).toBe(true);
    setVal(dest(), "https://x.com/a");
    await user.type(within(sheet).getByLabelText("Source"), "flyer");
    expect(dest().value).toBe("https://x.com/a?utm_source=flyer");
  });

  it("Ends before Starts blocks submit with the bad_window text", async () => {
    const { api, user } = boot();
    const sheet = await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    sheet.focus();
    await user.keyboard("s");
    setVal(screen.getByLabelText("Starts"), "2030-01-02T10:00");
    setVal(screen.getByLabelText("Ends"), "2030-01-01T10:00");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText(errorText("bad_window"))).toBeTruthy();
    expect(posts(api)).toEqual([]);
  });

  it("sends startsAt and expiresAt only when set", async () => {
    const { api, user } = boot();
    const sheet = await open(user);
    await user.type(slugBox(), "spring");
    setVal(dest(), "https://x.com/a");
    sheet.focus();
    await user.keyboard("s");
    setVal(screen.getByLabelText("Ends"), "2030-01-01T10:00");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const body = posts(api)[0] as Record<string, unknown>;
    expect(typeof body.expiresAt).toBe("number");
    expect("startsAt" in body).toBe(false);
  });

  it("owner confirms Release lock in the sheet: Enter deletes, then the re-check shows available", async () => {
    let released = false;
    const { api, user } = boot({
      check: () => ({ body: { status: released ? "available" : "locked" } }),
      routes: { "DELETE /api/locks/dm/spring": () => ((released = true), { status: 204 }) },
    });
    await open(user);
    await user.type(slugBox(), "spring");
    await user.click(await screen.findByRole("button", { name: "Release lock" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Release lock/ }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
    await screen.findByText(/Available/);
  });

  it("Esc in the Release lock confirm cancels only the confirm", async () => {
    const { api, user } = boot({ check: () => ({ body: { status: "locked" } }) });
    await open(user);
    await user.type(slugBox(), "spring");
    await user.click(await screen.findByRole("button", { name: "Release lock" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New link" })).toBeTruthy();
    expect(slugBox().value).toBe("spring");
    expect(api.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("a failed release shows its error inside the confirm", async () => {
    const { user } = boot({ check: () => ({ body: { status: "locked" } }), routes: { "DELETE /api/locks/dm/spring": () => ({ status: 403, body: { error: "forbidden" } }) } });
    await open(user);
    await user.type(slugBox(), "spring");
    await user.click(await screen.findByRole("button", { name: "Release lock" }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText(errorText("forbidden"))).toBeTruthy();
  });

  it("a member gets no Release lock", async () => {
    const { user } = boot({ me: member, check: () => ({ body: { status: "locked" } }) });
    await open(user);
    await user.type(slugBox(), "spring");
    await screen.findByText(/Locked: this slug was deleted/);
    expect(screen.queryByRole("button", { name: "Release lock" })).toBeNull();
  });

  it("with no usable domain submit is disabled and nothing is sent", async () => {
    const { api, user } = boot({ routes: { "GET /api/domains": () => ({ body: [dd] }) } });
    await open(user);
    expect(screen.getByText(/No domain is available to you/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Create link/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toEqual([]);
  });

  it("a suggestion fills the slug", async () => {
    const { user } = boot();
    await open(user);
    setVal(dest(), "https://northwind.io/campaigns/spring-2027");
    await user.click(await screen.findByRole("button", { name: "spring27" }));
    expect(slugBox().value).toBe("spring27");
  });
});
