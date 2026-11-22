import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { CfView, Domain, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const MAIN: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: true,
};

const OUT: CfView = {
  kind: "outside", dns: "missing", ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1, securityLevel: null, rateLimit: null,
  instructions: { type: "CNAME", name: "go", target: "edge.example.net", apex: false }, attachOnApproval: false, attached: true,
};
const GREEN: CfView = { ...OUT, dns: "found", ownership: "verified", certificate: "issued" };
const ACC: CfView = { ...OUT, kind: "account", instructions: null, attachOnApproval: true, attached: false };
const made = (cloudflare?: CfView, host = "go.harbor.com") => ({ status: 201, body: { ...MAIN, id: "d9", host, type: "private" as const, status: "pending" as const, ...(cloudflare ? { cloudflare } : {}) } });

function boot(me: Me, routes: FakeRoutes = {}, fakeTimers = false) {
  history.replaceState(null, "", "/domains");
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [MAIN] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    ...routes,
  });
  const user = userEvent.setup(fakeTimers ? { advanceTimers: (ms) => vi.advanceTimersByTime(ms) } : {});
  render(<App />);
  return { api, user };
}
const field = () => screen.getByLabelText(/Domain or subdomain/);
const done = () => screen.findByRole("button", { name: /^Done/ });
const polls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === "/api/domains/d9/cloudflare");
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole("button", { name: /Add domain/ });
  await user.keyboard("n");
  return screen.findByRole("dialog", { name: "Add a domain" });
};
const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST");
// The clock moves only when a test advances it, so load on the machine never adds or drops a poll. Only setTimeout is
// faked; the `jest` shim lets Testing Library's findBy/waitFor advance that fake clock in fixed steps instead of waiting on wall time.
const fakeClock = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
};
let hidden = false;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  hidden = false;
});

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
    expect(screen.queryByText(/Cloudflare is not connected on this linkwarren/)).toBeNull(); // shown only after create, when not configured
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
    await done();
    await user.keyboard("{Enter}"); // Done has focus
    await waitFor(() => expect(location.search).toContain("sel=d9"));
    expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull();
    expect(api.calls.filter((c) => c.method === "GET" && c.path === "/api/domains").length).toBeGreaterThan(1);
  });

  it("a double Ctrl+Enter sends once", async () => {
    const { api, user } = boot(owner, { "POST /api/domains": () => ({ status: 201, body: { ...MAIN, id: "d9", host: "a.test" } }) });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "a.test");
    await user.keyboard("{Control>}{Enter}{Enter}{/Control}");
    await done();
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

  it("a failed list refresh after add still shows the status view and announces", async () => {
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
    await done();
    // The refresh failure message is not overwritten by "Added <host>".
    expect(document.querySelector("[aria-live]")!.textContent).toBe("Added, but the list could not be refreshed");
  });

  it("a submission dismissed with Esc does not close a newer sheet when it finishes", async () => {
    let release!: () => void;
    const { user } = boot(owner, {
      "POST /api/domains": () => new Promise((r) => (release = () => r({ status: 201, body: { ...MAIN, id: "d9", host: "a.test" } }))),
    });
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "a.test{Control>}{Enter}{/Control}");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await user.keyboard("{Escape}");
    await open(user);
    await user.type(screen.getByLabelText(/Domain or subdomain/), "b.test");
    release();
    await waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Added a.test"));
    expect(screen.getByRole("dialog", { name: "Add a domain" })).toBeTruthy();
    expect((screen.getByLabelText(/Domain or subdomain/) as HTMLInputElement).value).toBe("b.test");
    expect(location.search).not.toContain("sel=d9");
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

  it("success switches to the status view without closing; Enter on Done opens the domain", async () => {
    const { user } = boot(owner, { "POST /api/domains": () => made(OUT) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    const btn = await done();
    const dlg = screen.getByRole("dialog", { name: "Add a domain" });
    expect(dlg.textContent).toContain("harbor.com isn't in your Cloudflare account, so it connects with one DNS record at its DNS provider. Cloudflare then checks ownership and issues the certificate.");
    expect(dlg.textContent).toContain("go → edge.example.net");
    expect(dlg.textContent).toContain("Waiting for the DNS record");
    expect(document.activeElement).toBe(btn);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull();
    expect(location.search).toContain("sel=d9");
  });

  it("not configured: the manual setup note shows after create", async () => {
    const { user } = boot(owner, { "POST /api/domains": () => made({ ...OUT, kind: "manual", instructions: null }) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    expect(screen.getByText(/Cloudflare is not connected on this linkwarren/)).toBeTruthy();
    expect(screen.queryByText("Check")).toBeNull();
  });

  it("account, owner: linkwarren attaches it directly", async () => {
    const { user } = boot(owner, { "POST /api/domains": () => made({ ...ACC, attachOnApproval: false, attached: true, dns: "found", ownership: "verified", certificate: "issued" }) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    expect(screen.getByText("harbor.com is in your Cloudflare account, so linkwarren attaches it directly.")).toBeTruthy();
  });

  it("account, member: the owner attaches it on approval", async () => {
    const { user } = boot(member, { "POST /api/domains": () => made(ACC) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    expect(screen.getByText("harbor.com is in your Cloudflare account, so linkwarren attaches it directly. The owner attaches it when they approve the domain.")).toBeTruthy();
  });

  it("a member adding an outside domain sees the record footer line", async () => {
    const { user } = boot(member, { "POST /api/domains": () => made(OUT) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    expect(screen.getByText("You can create links on it straight away. They start working once the record is found and the owner approves the domain.")).toBeTruthy();
  });

  describe("an owner account create whose attach failed", () => {
    const HALF: CfView = { ...ACC, attachOnApproval: false, attached: false, dns: "missing", ownership: "pending", lastError: "cloudflare_error" };
    const CONNECTED: CfView = { ...HALF, attached: true, dns: "found", ownership: "verified", certificate: "issued", lastError: null };
    const activeMade = () => ({ status: 201, body: { ...made(HALF).body, status: "active" as const } });

    it("stops polling and offers Finish connecting; F sends the approve call", async () => {
      fakeClock();
      const { api, user } = boot(owner, {
        "POST /api/domains": activeMade,
        "POST /api/domains/d9/approve": () => ({ body: { ...activeMade().body, cloudflare: CONNECTED } }),
      }, true);
      await open(user);
      await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
      await done();
      const dlg = screen.getByRole("dialog", { name: "Add a domain" });
      expect(dlg.textContent).toContain("Use Finish connecting to try again.");
      expect(dlg.textContent).not.toContain("Checks keep running");
      await vi.advanceTimersByTimeAsync(20000);
      expect(polls(api)).toHaveLength(0);
      expect(within(dlg).getByRole("button", { name: /Finish connecting/ }).getAttribute("aria-keyshortcuts")).toBe("F");
      await user.keyboard("f");
      await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/domains/d9/approve")).toHaveLength(1));
      expect(await within(dlg).findByText("In your Cloudflare account")).toBeTruthy();
      expect(within(dlg).queryByRole("button", { name: /Finish connecting/ })).toBeNull();
    });

    it("an unsettled view from Finish connecting is polled until a newer poll result settles it", async () => {
      fakeClock();
      const WAITING: CfView = { ...HALF, attached: true, lastError: null, dns: "missing", ownership: "verified" };
      const { api, user } = boot(owner, {
        "POST /api/domains": activeMade,
        "POST /api/domains/d9/approve": () => ({ body: { ...activeMade().body, cloudflare: WAITING } }),
        "GET /api/domains/d9/cloudflare": () => ({ body: CONNECTED }),
      }, true);
      await open(user);
      await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
      await done();
      await user.keyboard("f");
      await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/domains/d9/approve")).toHaveLength(1));
      // The answer has landed (and polling started from it) once the button is gone.
      await waitFor(() => expect(screen.queryByRole("button", { name: /Finish connecting/ })).toBeNull());
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls(api)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20000);
      expect(polls(api)).toHaveLength(1); // settled: polling stops
    });

    it("409 dns_record_exists opens the takeover confirm on Cancel; Enter on Send traffic resends with confirmTakeover", async () => {
      const bodies: unknown[] = [];
      const { user } = boot(owner, {
        "POST /api/domains": activeMade,
        "POST /api/domains/d9/approve": ({ body }) => (bodies.push(body), (body as { confirmTakeover?: boolean }).confirmTakeover
          ? { body: { ...activeMade().body, cloudflare: CONNECTED } }
          : { status: 409, body: { error: "dns_record_exists" } }),
      });
      await open(user);
      await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
      await done();
      await user.click(screen.getByRole("button", { name: /Finish connecting/ }));
      const confirm = await screen.findByRole("dialog", { name: "Send traffic to linkwarren" });
      expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: /Cancel/ }));
      within(confirm).getByRole("button", { name: /Send traffic/ }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(bodies).toEqual([{}, { confirmTakeover: true }]));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send traffic to linkwarren" })).toBeNull());
    });
  });

  it("polls every 5 s, one at a time, and stops when all green", async () => {
    fakeClock();
    let n = 0;
    const { api, user } = boot(owner, {
      "POST /api/domains": () => made(OUT),
      "GET /api/domains/d9/cloudflare": () => ({ body: ++n >= 2 ? GREEN : OUT }),
    }, true);
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    expect(polls(api)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls(api)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls(api)).toHaveLength(2);
    await waitFor(() => expect(screen.getByText("Record found, ownership verified")).toBeTruthy());
    await vi.advanceTimersByTimeAsync(20000);
    expect(polls(api)).toHaveLength(2);
  });

  it("a slow poll is never stacked: the next one waits for the answer", async () => {
    fakeClock();
    let release!: () => void;
    const { api, user } = boot(owner, {
      "POST /api/domains": () => made(OUT),
      "GET /api/domains/d9/cloudflare": () => new Promise((r) => (release = () => r({ body: OUT }))),
    }, true);
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    await vi.advanceTimersByTimeAsync(5000);
    hidden = true; // a visibility flip while one is in flight must not start a second loop
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(polls(api)).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls(api)).toHaveLength(2);
  });

  it("Esc closes the status view and no poll is sent after it", async () => {
    fakeClock();
    const { api, user } = boot(owner, { "POST /api/domains": () => made(OUT), "GET /api/domains/d9/cloudflare": () => ({ body: OUT }) }, true);
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls(api)).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add a domain" })).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(polls(api)).toHaveLength(1);
  });

  it("a hidden tab pauses polling and a visible one resumes it", async () => {
    fakeClock();
    const { api, user } = boot(owner, { "POST /api/domains": () => made(OUT), "GET /api/domains/d9/cloudflare": () => ({ body: OUT }) }, true);
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await done();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(polls(api)).toHaveLength(0);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls(api)).toHaveLength(1);
  });

  it("dns_record_exists for the owner shows the takeover text; Ctrl+Shift+Enter resends with confirmTakeover", async () => {
    const { api, user } = boot(owner, {
      "POST /api/domains": ({ body }) => ((body as { confirmTakeover?: boolean }).confirmTakeover ? made(GREEN) : { status: 409, body: { error: "dns_record_exists" } }),
    });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    expect(await screen.findByText("go.harbor.com already has DNS records in your account. Adding it sends its traffic to linkwarren.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add anyway/ })).toBeTruthy();
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await done();
    expect(posts(api)).toHaveLength(2);
    expect(posts(api)[1]!.body).toEqual({ host: "go.harbor.com", type: "private", confirmTakeover: true });
  });

  it("editing the host after a takeover warning drops it: Ctrl+Shift+Enter sends nothing", async () => {
    const { api, user } = boot(owner, { "POST /api/domains": () => ({ status: 409, body: { error: "dns_record_exists" } }) });
    await open(user);
    await user.type(field(), "go.harbor.com{Control>}{Enter}{/Control}");
    await screen.findByRole("button", { name: /Add anyway/ });
    await user.type(field(), "x");
    expect(screen.queryByRole("button", { name: /Add anyway/ })).toBeNull();
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(posts(api)).toHaveLength(1);
  });

  it("pending_limit shows its copy inline", async () => {
    const { user } = boot(member, { "POST /api/domains": () => ({ status: 409, body: { error: "pending_limit" } }) });
    await open(user);
    await user.type(field(), "a.test{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toBe("You already have 3 domains waiting for approval.");
  });
});
