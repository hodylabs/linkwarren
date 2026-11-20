import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const MAIN: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: true,
};

function boot(me: Me, routes: FakeRoutes = {}) {
  history.replaceState(null, "", "/domains");
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [MAIN] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    ...routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole("button", { name: /Add domain/ });
  await user.keyboard("n");
  return screen.findByRole("dialog", { name: "Add a domain" });
};
const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST");
afterEach(() => vi.unstubAllGlobals());

describe("Add a domain sheet", () => {
  it("owner sees three types, default Private", async () => {
    const { user } = boot(owner);
    await open(user);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Main", "Shared", "Private"]);
    expect(screen.getByRole("radio", { name: "Private" }).getAttribute("aria-checked")).toBe("true");
  });

  it("member sees only Private as text plus the approval note", async () => {
    const { user } = boot(member);
    await open(user);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(within(screen.getByRole("dialog", { name: "Add a domain" })).getByText("Private")).toBeTruthy();
    expect(screen.getByText(/start working once the owner approves the domain/)).toBeTruthy();
  });

  it("Ctrl+Enter sends exactly host and type, normalized like the server, then navigates and reloads", async () => {
    let list = [MAIN];
    const { api, user } = boot(owner, {
      "GET /api/domains": () => ({ body: list }),
      "POST /api/domains": ({ body }) => {
        list = [...list, { ...MAIN, id: "d9", host: (body as { host: string }).host, type: "private" }];
        return { status: 201, body: list[1] };
      },
    });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "Go.Example.com.{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ host: "go.example.com", type: "private" });
    await waitFor(() => expect(location.search).toContain("sel=d9"));
    expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull();
    expect(api.calls.filter((c) => c.method === "GET" && c.path === "/api/domains").length).toBeGreaterThan(1);
  });

  it("a double Ctrl+Enter sends once", async () => {
    const { api, user } = boot(owner, { "POST /api/domains": () => ({ status: 201, body: { ...MAIN, id: "d9", host: "a.test" } }) });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "a.test");
    await user.keyboard("{Control>}{Enter}{Enter}{/Control}");
    await waitFor(() => expect(location.search).toContain("sel=d9"));
    expect(posts(api)).toHaveLength(1);
  });

  it("409 host_taken shows the copy and keeps the input", async () => {
    const { user } = boot(owner, { "POST /api/domains": () => ({ status: 409, body: { error: "host_taken" } }) });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "go.test{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toBe(errorText("host_taken"));
    expect((screen.getByLabelText(/Domain or subdomain/) as HTMLInputElement).value).toBe("go.test");
    expect(screen.getByRole("dialog", { name: "Add a domain" })).toBeTruthy();
  });

  it("Esc closes with no request", async () => {
    const { api, user } = boot(owner);
    await open(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull();
    expect(posts(api)).toHaveLength(0);
  });

  it("an empty host sends nothing", async () => {
    const { api, user } = boot(owner);
    await open(user);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posts(api)).toHaveLength(0);
    expect((await screen.findByRole("alert")).textContent).toBe(errorText("invalid_host"));
  });

  it("a failed list refresh after add still closes and announces", async () => {
    let fail = false;
    const { user } = boot(owner, {
      "GET /api/domains": () => (fail ? { status: 500, body: { error: "internal" } } : { body: [MAIN] }),
      "POST /api/domains": () => {
        fail = true;
        return { status: 201, body: { ...MAIN, id: "d9", host: "a.test" } };
      },
    });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "a.test{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull());
    // The refresh failure message is not overwritten by "Added <host>".
    expect(document.querySelector("[aria-live]")!.textContent).toBe("Added, but the list could not be refreshed");
  });

  it("a member's POST body is exactly host and type private", async () => {
    const { api, user } = boot(member, { "POST /api/domains": () => ({ status: 201, body: { ...MAIN, id: "d9", host: "a.test" } }) });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "a.test{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toEqual({ host: "a.test", type: "private" });
  });

  it("the Type label is a heading", async () => {
    const { user } = boot(owner);
    await open(user);
    expect(screen.getByRole("heading", { name: "Type" })).toBeTruthy();
  });
});
