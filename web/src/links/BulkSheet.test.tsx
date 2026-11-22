import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Link, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeReq, type FakeRes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const dom = (id: string, host: string, o: Partial<Domain> = {}): Domain => ({
  id, host, type: "shared", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 1, isMember: false, ...o,
});
const D1 = dom("d1", "go.test", { type: "main" }), D2 = dom("d2", "b.test"), D3 = dom("d3", "c.test", { status: "pending" });
const mk = (id: string, slug: string, o: Partial<Link> = {}): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
});
const L = [mk("l1", "spring"), mk("l2", "menu"), mk("l3", "app")];
const okAll = (req: FakeReq): FakeRes => ({ body: { results: (req.body as { ids: string[] }).ids.map((id) => ({ id, ok: true })), pending: [] } });

function boot(o: { items?: Link[]; bulk?: (req: FakeReq) => FakeRes | Promise<FakeRes> } = {}) {
  history.replaceState(null, "", "/links");
  const api = fakeApi({
    "GET /api/me": () => ({ body: owner }),
    "GET /api/domains": () => ({ body: [D1, D2, D3] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: o.items ?? L, next: null } }),
    "POST /api/links/bulk": o.bulk ?? okAll,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const rows = () => screen.getAllByRole("row").slice(1);
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const posts = (api: { calls: { method: string; path: string; body: unknown }[] }) => api.calls.filter((c) => c.path === "/api/links/bulk").map((c) => c.body);
const bar = () => screen.queryByRole("region", { name: "Selected links" });
const selectAll = async (user: ReturnType<typeof userEvent.setup>) => {
  await ready();
  await user.keyboard("{Control>}a{/Control}");
};
afterEach(() => vi.unstubAllGlobals());

describe("bulk delete", () => {
  it("the confirm says what happens and Enter sends { action: delete, ids }", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("{Shift>}D{/Shift}");
    const sheet = screen.getByRole("dialog", { name: "Delete links" });
    expect(within(sheet).getByText(/^Delete 3 links\? Visits go to each domain's not-found page and the slugs stay locked/)).toBeTruthy();
    expect(document.activeElement?.textContent).toMatch(/^Delete/);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "delete", ids: ["l1", "l2", "l3"] }]));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("3 changed, 0 not changed")).toBeTruthy());
    expect(screen.queryAllByRole("row")).toHaveLength(1);
    await waitFor(() => expect(screen.getByText("3 links changed, 0 not changed")).toBeTruthy());
  });
});

describe("bulk schedule", () => {
  it("End now sends endNow: true after a confirm, and Keep fields are absent", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("s");
    const sheet = screen.getByRole("dialog", { name: "Schedule links" });
    expect(within(sheet).getByRole("radiogroup", { name: "Starts" })).toBeTruthy();
    await user.click(within(sheet).getByRole("radio", { name: "End now" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
    expect(within(sheet).getByText(/takes 3 links offline/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "schedule", ids: ["l1", "l2", "l3"], endNow: true }]));
  });

  it("a bad_window from End now reads Starts later: clear its start first", async () => {
    const { user } = boot({ bulk: () => ({ body: { results: [{ id: "l1", ok: false, error: "bad_window" }, { id: "l2", ok: true }, { id: "l3", ok: true }], pending: [] } }) });
    await selectAll(user);
    await user.keyboard("s");
    await user.click(screen.getByRole("radio", { name: "End now" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Starts later: clear its start first")).toBeTruthy());
  });
});

describe("bulk move", () => {
  it("offers only active domains, needs an old-address choice, then sends forward", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("m");
    const sheet = screen.getByRole("dialog", { name: "Move links" });
    const to = within(sheet).getByRole("radiogroup", { name: "Move to" });
    expect(within(to).queryByRole("radio", { name: "c.test" })).toBeNull();
    expect(within(to).getByRole("radio", { name: "b.test" }).getAttribute("aria-checked")).toBe("true");
    const forward = within(sheet).getByRole("radio", { name: /^Keep them working/ }) as HTMLInputElement;
    const copy = within(sheet).getByRole("radio", { name: /^Keep a copy on both domains/ }) as HTMLInputElement;
    expect(forward.checked).toBe(false);
    expect(copy.checked).toBe(false);
    expect((within(sheet).getByRole("button", { name: /^Move/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText("Pick what happens to the old addresses")).toBeTruthy();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
    await user.click(forward);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "move", ids: ["l1", "l2", "l3"], domainId: "d2", oldAddress: "forward" }]));
  });

  it("copy sends oldAddress: copy and the copy note names the target host", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("m");
    expect(screen.getByText(/an independent copy with the same slug, destination and rules, password included, is made on b\.test\./)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /^Keep a copy on both domains/ }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "move", ids: ["l1", "l2", "l3"], domainId: "d2", oldAddress: "copy" }]));
  });

  it("the choice is not remembered between runs", async () => {
    const { user } = boot({ bulk: () => ({ body: { results: L.map((l) => ({ id: l.id, ok: false, error: "taken" })), pending: [] } }) });
    await selectAll(user);
    await user.keyboard("m");
    await user.click(screen.getByRole("radio", { name: /^Keep them working/ }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getByText("0 changed, 3 not changed")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await user.keyboard("m");
    expect((screen.getByRole("radio", { name: /^Keep them working/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("a 400 target_not_active shows its text", async () => {
    const { user } = boot({ bulk: () => ({ status: 400, body: { error: "target_not_active" } }) });
    await selectAll(user);
    await user.keyboard("m");
    await user.click(screen.getByRole("radio", { name: /^Keep them working/ }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getAllByText(errorText("target_not_active")).length).toBeGreaterThan(0));
    expect(errorText("target_not_active")).toBe("Pick a domain that is active. Links cannot move to a domain that is waiting for approval or turned off.");
  });
});

describe("forwarder rows", () => {
  const fwd = mk("f1", "old", { url: "https://b.test/old", forwardTo: "l9" });
  it("show the tag, the arrow icon and a read-only detail with Delete only", async () => {
    const { user } = boot({ items: [fwd, L[0]!] });
    await ready();
    expect(within(rows()[0]!).getByText("Forwards to b.test/old")).toBeTruthy();
    expect(within(rows()[0]!).getByRole("img", { name: "Forwards to another link" })).toBeTruthy();
    expect(within(rows()[0]!).getAllByRole("cell").find((c) => c.dataset.label === "7 days")!.childElementCount).toBe(0);
    await user.click(rows()[0]!);
    const d = screen.getByRole("complementary", { name: "Selected link" });
    expect(within(d).queryByLabelText("URL")).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(within(d).getByRole("button", { name: /^Delete/ })).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Open the link it forwards to" }));
    await waitFor(() => expect(location.search).toContain("q=old"));
  });

  it("count as cannot change in a selection", async () => {
    const { user } = boot({ items: [fwd, L[0]!] });
    await selectAll(user);
    expect(within(bar()!).getByText("1 you cannot change")).toBeTruthy();
  });
});

describe("bulk redirect and password", () => {
  it("301 sends redirectCode: 301 only", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("r");
    const sheet = screen.getByRole("dialog", { name: "Redirect type" });
    expect(within(sheet).getByText("Password links stay on 302.")).toBeTruthy();
    await user.click(within(sheet).getByRole("radio", { name: "301" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "redirect", ids: ["l1", "l2", "l3"], redirectCode: 301 }]));
  });

  it("a short password shows the rule error and Ctrl+Enter sends nothing", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("p");
    const sheet = screen.getByRole("dialog", { name: "Password" });
    expect(within(sheet).getByText("Each link gets its own hash, so setting one takes a moment per link.")).toBeTruthy();
    await user.type(within(sheet).getByLabelText("New password"), "short");
    expect(within(sheet).getByText(errorText("password_short"))).toBeTruthy();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
  });

  it("setting a password resends pending ids and shows progress", async () => {
    const { api, user } = boot({
      bulk: (req) => {
        const [first, ...rest] = (req.body as { ids: string[] }).ids;
        return { body: { results: [{ id: first, ok: true }], pending: rest } };
      },
    });
    await selectAll(user);
    await user.keyboard("p");
    await user.type(screen.getByLabelText("New password"), "long-enough");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getByText("3 changed, 0 not changed")).toBeTruthy());
    expect(posts(api).map((b) => (b as { ids: string[] }).ids)).toEqual([["l1", "l2", "l3"], ["l2", "l3"], ["l3"]]);
    expect(posts(api)[0]).toEqual({ action: "password", ids: ["l1", "l2", "l3"], password: "long-enough" });
  });

  it("removing passwords asks first", async () => {
    const { api, user } = boot();
    await selectAll(user);
    await user.keyboard("p");
    await user.click(screen.getByRole("radio", { name: "Remove the password" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts(api)).toEqual([{ action: "password", ids: ["l1", "l2", "l3"], password: null }]));
  });
});

describe("bulk results", () => {
  const many = Array.from({ length: 60 }, (_, i) => mk(`m${i}`, `s${i}`));
  it("list per-link reasons, cap at 50 rows with the rest counted, Retry failed resends only the failed ids, and they stay selected", async () => {
    let n = 0;
    const { api, user } = boot({
      items: many,
      bulk: (req) => {
        const ids = (req.body as { ids: string[] }).ids;
        n++;
        // first run: the first 3 change, the rest are taken; the retry changes one more
        return { body: { results: ids.map((id, i) => (n === 1 ? i < 3 : i === 0) ? { id, ok: true } : { id, ok: false, error: "taken" }), pending: [] } };
      },
    });
    await selectAll(user);
    await user.keyboard("r");
    await user.click(screen.getByRole("radio", { name: "301" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    const sheet = await screen.findByRole("dialog", { name: "Redirect type" });
    await waitFor(() => expect(within(sheet).getByText("3 changed, 57 not changed")).toBeTruthy());
    const list = within(sheet).getByRole("list", { name: "Not changed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(within(list).getAllByText(errorText("taken"))).toHaveLength(50);
    expect(within(sheet).getByText("and 7 more")).toBeTruthy();
    expect(document.activeElement?.textContent).toMatch(/^Retry failed/);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(sheet).getByText("1 changed, 56 not changed")).toBeTruthy());
    const second = posts(api)[1] as { ids: string[] };
    expect(second.ids).toHaveLength(57);
    expect(second.ids).not.toContain("m0");
    expect(second).toMatchObject({ action: "redirect", redirectCode: 301 });
    await user.click(within(sheet).getByRole("button", { name: /^Done/ }));
    expect(within(bar()!).getByText("56 selected")).toBeTruthy();
  });
});
