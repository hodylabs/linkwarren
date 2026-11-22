import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AuditItem, Me, UserItem } from "../api";
import { fakeApi, type FakeRes, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const u = (id: string, o: Partial<UserItem> = {}): UserItem => ({
  id, email: `${id}@example.com`, name: id.toUpperCase(), role: "member", status: "active", createdAt: 1, linkCount: 2, domains: [], ...o,
});
const USERS = [
  u("uo", { name: "Olive", role: "owner", linkCount: 9 }),
  u("ud", { name: "Dana", domains: [{ id: "d1", host: "nw.link", via: "member" }, { id: "d2", host: "x.test", via: "owner" }, { id: "d3", host: "y.test", via: "owner" }] }),
  u("ui", { name: null, email: "jordan@example.com", status: "invited" }),
  u("ux", { name: "Xan", status: "disabled" }),
];
const au = (id: number, o: Partial<AuditItem> = {}): AuditItem => ({
  id, at: 1_700_000_000, actorId: "ud", actorEmail: "ud@example.com", actorName: "Dana", via: null, action: "link.update", targetType: "link",
  targetId: `l${id}`, detail: { host: "go.test", slug: `s${id}` }, ...o,
});

function boot(opts: { me?: Me; audit?: (url: URL) => FakeRes | Promise<FakeRes>; routes?: FakeRoutes; path?: string } = {}) {
  history.replaceState(null, "", opts.path ?? "/people");
  const api = fakeApi({
    "GET /api/me": () => ({ body: opts.me ?? owner }),
    "GET /api/domains": () => ({ body: [{ id: "d1", host: "go.test" }, { id: "d2", host: "b.test" }] }),
    "GET /api/users": () => ({ body: { items: USERS } }),
    "GET /api/audit": ({ url }) => (opts.audit ? opts.audit(url) : { body: { items: [au(2), au(1)], next: null } }),
    ...opts.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const rows = () => screen.getAllByRole("row").slice(1);
const auditPaths = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path.startsWith("/api/audit")).map((c) => c.path);
afterEach(() => vi.unstubAllGlobals());

describe("People screen", () => {
  it("lists people with role, domains and links, and the pending count", async () => {
    boot();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows()[0]!.textContent).toContain("You");
    expect(rows()[0]!.textContent).toContain("All 2");
    expect(rows()[1]!.textContent).toContain("nw.link, 2 own");
    expect(rows()[2]!.textContent).toContain("Main only");
    expect(rows()[2]!.textContent).toContain("Invited");
    expect(rows()[3]!.textContent).toContain("Disabled");
    expect(screen.getByText("3 people, 1 invite pending")).toBeTruthy();
  });

  it("the audit footer states the retention", async () => {
    boot();
    await screen.findByText("Activity across every domain");
    expect(screen.getByText(/Kept for 3 years/)).toBeTruthy();
  });

  it("the Invited chip shows only invited users, Disabled only disabled", async () => {
    const { user } = boot();
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(screen.getByRole("button", { name: "Invited" }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("jordan@example.com");
    await user.click(screen.getByRole("button", { name: "Disabled" }));
    expect(rows()[0]!.textContent).toContain("Xan");
  });

  it("filter chips are one at a time: Via agents then Links", async () => {
    const { api, user } = boot();
    await screen.findByText("Activity across every domain");
    await user.click(screen.getByRole("button", { name: "Via agents" }));
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?via=present"));
    await user.click(screen.getByRole("button", { name: "Links" }));
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?target=link"));
    expect(screen.getByRole("button", { name: "Via agents" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Domains" }));
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?target=domain"));
    await user.click(screen.getByRole("button", { name: "People" }));
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?target=user"));
  });

  it("selecting a person adds actor=<id> with a chip, Esc outside inputs removes it", async () => {
    const { api, user } = boot();
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(rows()[1]!);
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?actor=ud"));
    expect(location.search).toContain("sel=ud");
    expect(screen.getByText("Only Dana")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Only Dana")).toBeNull());
    expect(location.search).not.toContain("sel=");
    expect(auditPaths(api).at(-1)).toBe("/api/audit");
  });

  it("J and K select people and ?sel= preselects", async () => {
    const { api, user } = boot({ path: "/people?sel=ud" });
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?actor=ud"));
    await user.keyboard("j");
    await waitFor(() => expect(location.search).toContain("sel=ui"));
    await user.keyboard("k");
    await waitFor(() => expect(location.search).toContain("sel=ud"));
  });

  it("the clear button on the chip removes the actor filter", async () => {
    const { user } = boot({ path: "/people?sel=ud" });
    await user.click(await screen.findByRole("button", { name: "Clear person filter" }));
    expect(screen.queryByText("Only Dana")).toBeNull();
  });

  it("rows read as plain text: who, via, text, code; markup in values is not rendered", async () => {
    boot({
      audit: () => ({
        body: {
          items: [
            au(3, { via: "Claude", action: "link.create", detail: { host: "go.test", slug: "spring" } }),
            au(2, { action: "weird.<b>x</b>", targetType: "t", targetId: "<img src=x onerror=alert(1)>" }),
          ],
          next: null,
        },
      }),
    });
    await screen.findByText("via Claude");
    expect(screen.getByText("go.test/spring").tagName).toBe("CODE");
    expect(screen.getByText("weird.<b>x</b>")).toBeTruthy();
    expect(document.querySelector(".log img")).toBeNull();
    expect(document.querySelector(".log li b")?.textContent).toBe("Dana");
  });

  it("Load more sends cursor=<next> and never an empty cursor", async () => {
    const { api, user } = boot({
      audit: (url) =>
        url.searchParams.get("cursor") === "2"
          ? { body: { items: [au(1)], next: null } }
          : { body: { items: [au(3), au(2)], next: "2" }},
    });
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(auditPaths(api)).toContain("/api/audit?cursor=2"));
    expect(auditPaths(api).some((p) => p.includes("cursor="))).toBe(true);
    expect(auditPaths(api).filter((p) => p.endsWith("cursor="))).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("a successful Load more retry clears the earlier error", async () => {
    let tries = 0;
    const { user } = boot({
      audit: (url) =>
        url.searchParams.get("cursor") !== "2"
          ? { body: { items: [au(3), au(2)], next: "2" } }
          : ++tries === 1
            ? { status: 500, body: { error: "internal" } }
            : { body: { items: [au(1)], next: null } },
    });
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a selected person hidden by a filter leaves the first visible row tabbable", async () => {
    const { user } = boot({ path: "/people?sel=ud" });
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(screen.getByRole("button", { name: "Invited" }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.tabIndex).toBe(0);
  });

  it("changing the filter starts from the first page without the old cursor", async () => {
    const { api, user } = boot({ audit: () => ({ body: { items: [au(3)], next: "3" } }) });
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await user.click(screen.getByRole("button", { name: "Links" }));
    await waitFor(() => expect(auditPaths(api).at(-1)).toBe("/api/audit?target=link"));
  });

  it("a stale answer for an older filter is dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user } = boot({
      audit: async (url) => {
        if (url.search === "") {
          await gate;
          return { body: { items: [au(9, { detail: { host: "old.test", slug: "x" } })], next: null } };
        }
        return { body: { items: [au(8, { detail: { host: "new.test", slug: "y" } })], next: null } };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Links" }));
    await screen.findByText("new.test/y");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("old.test/x")).toBeNull();
    expect(screen.getByText("new.test/y")).toBeTruthy();
  });

  it("an audit error shows copy and keeps the screen", async () => {
    boot({ audit: () => ({ status: 500, body: { error: "internal" } }) });
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("a member sees the Owner only pane and no users or audit request", async () => {
    const { api } = boot({ me: member });
    await screen.findByText("Owner only");
    expect(api.calls.filter((c) => c.path.startsWith("/api/users") || c.path.startsWith("/api/audit"))).toHaveLength(0);
  });
});
