import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me } from "../api";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import type { CloudflareSettings } from "./api";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member" };
const CFG: CloudflareSettings = {
  configured: true, outsideReady: true, accountName: "Northwind", cnameTarget: "t.example.com", fallbackOrigin: "active",
  hostnames: { used: 2, limit: 100 }, attachedCount: 3, controlsEnabled: false,
};
const perms = (ssl: "ok" | "missing") => [
  { key: "zone_read", state: "ok" }, { key: "dns_edit", state: "ok" }, { key: "routes_edit", state: "ok" },
  { key: "ssl_edit", state: ssl }, { key: "config_rules_edit", state: "unknown" }, { key: "waf_edit", state: "unknown" },
];

function boot(o: { me?: Me; cfg?: Partial<CloudflareSettings>; routes?: FakeRoutes } = {}) {
  history.replaceState(null, "", "/settings");
  const api = fakeApi({
    "GET /api/me": () => ({ body: o.me ?? owner }),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/settings/cloudflare": () => ({ body: { ...CFG, ...o.cfg } }),
    ...o.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare settings", () => {
  it("shows the connected callout with its numbers", async () => {
    boot();
    const callout = await screen.findByText(/Connected to the account/);
    expect(callout.textContent).toBe(
      "Connected to the account Northwind. 3 domains in this account are attached directly; outside domains use a CNAME through Cloudflare for SaaS (2 of 100 free hostnames used).",
    );
  });

  it("C runs one check and shows a missing ssl_edit with the callout", async () => {
    const { api, user } = boot({ routes: { "POST /api/settings/cloudflare/check": () => ({ body: { token: "active", accountName: "Northwind", permissions: perms("missing") } }) } });
    await screen.findByText(/Connected to the account/);
    await user.keyboard("c");
    await screen.findByText(/The token can't add outside domains yet/);
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]!.body).toEqual({});
    expect(screen.getAllByText(/Checked on first use/)).toHaveLength(2);
  });

  it("Space on the controls switch sends controlsEnabled true; a 500 restores it", async () => {
    const { api, user } = boot({ routes: { "PATCH /api/settings/cloudflare": () => ({ status: 500, body: { error: "internal" } }) } });
    const sw = await screen.findByRole("switch", { name: "Cloudflare controls in domain settings" });
    sw.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]!.body).toEqual({ controlsEnabled: true });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("alert").textContent).toContain("internal");
  });

  it("an older toggle that fails after newer ones succeeded does not flip the switch back", async () => {
    let fail!: () => void;
    let n = 0;
    const { api, user } = boot({
      routes: { "PATCH /api/settings/cloudflare": ({ body }) => (++n === 1 ? new Promise((r) => (fail = () => r({ status: 500, body: { error: "internal" } }))) : { body }) },
    });
    const sw = await screen.findByRole("switch", { name: "Cloudflare controls in domain settings" });
    await user.click(sw);
    await user.click(sw);
    await user.click(sw);
    await waitFor(() => expect(writes(api)).toHaveLength(3));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    fail();
    await new Promise((r) => setTimeout(r, 20));
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("overlapping toggles that both fail restore the saved value", async () => {
    const fails: (() => void)[] = [];
    const { api, user } = boot({
      routes: { "PATCH /api/settings/cloudflare": () => new Promise((r) => fails.push(() => r({ status: 500, body: { error: "internal" } }))) },
    });
    const sw = await screen.findByRole("switch", { name: "Cloudflare controls in domain settings" });
    await user.click(sw); // on
    await user.click(sw); // off
    await waitFor(() => expect(writes(api)).toHaveLength(2));
    fails[0]!();
    fails[1]!();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("internal"));
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("a settings load that a toggle overtook keeps the toggled value", async () => {
    let release!: () => void;
    let gets = 0;
    const { user } = boot({
      cfg: { fallbackOrigin: "missing" },
      routes: {
        "GET /api/settings/cloudflare": () => (++gets === 1 ? { body: { ...CFG, fallbackOrigin: "missing" } }
          : new Promise((r) => (release = () => r({ body: { ...CFG, fallbackOrigin: "active", controlsEnabled: false } })))),
        "POST /api/settings/cloudflare/setup": () => ({ body: { target: "t.example.com", fallbackOrigin: "active" } }),
        "PATCH /api/settings/cloudflare": ({ body }) => ({ body }),
      },
    });
    await user.click(await screen.findByRole("button", { name: /Set up outside domains/ }));
    await waitFor(() => expect(release).toBeTypeOf("function")); // the reload after setup is in flight
    const sw = screen.getByRole("switch", { name: "Cloudflare controls in domain settings" });
    await user.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Set up outside domains/ })).toBeNull()); // the rest of the load landed
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("the setup button shows only when the fallback origin is not active", async () => {
    boot();
    await screen.findByText(/Connected to the account/);
    expect(screen.queryByRole("button", { name: /Set up outside domains/ })).toBeNull();
  });

  it("setup posts and shows the result inline", async () => {
    const { api, user } = boot({
      cfg: { fallbackOrigin: "missing" },
      routes: { "POST /api/settings/cloudflare/setup": () => ({ body: { target: "t.example.com", fallbackOrigin: "active" } }) },
    });
    await user.click(await screen.findByRole("button", { name: /Set up outside domains/ }));
    expect(await screen.findByText("Outside domains are ready.")).toBeTruthy();
    expect(writes(api)).toHaveLength(1);
  });

  it("a double click on setup sends one request", async () => {
    let release!: () => void;
    const { api, user } = boot({
      cfg: { fallbackOrigin: "missing" },
      routes: { "POST /api/settings/cloudflare/setup": () => new Promise((r) => (release = () => r({ body: { target: "t.example.com", fallbackOrigin: "active" } }))) },
    });
    const btn = await screen.findByRole("button", { name: /Set up outside domains/ });
    await user.dblClick(btn);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(writes(api)).toHaveLength(1);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByText("Outside domains are ready.")).toBeTruthy();
    expect(writes(api)).toHaveLength(1);
  });

  it("setup 409 fallback_in_use shows its copy", async () => {
    const { user } = boot({
      cfg: { fallbackOrigin: "pending" },
      routes: { "POST /api/settings/cloudflare/setup": () => ({ status: 409, body: { error: "fallback_in_use" } }) },
    });
    await user.click(await screen.findByRole("button", { name: /Set up outside domains/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("different fallback origin");
  });

  it("not configured: callout and no controls", async () => {
    boot({ cfg: { configured: false } });
    expect(await screen.findByText(/Cloudflare is not connected\. Set the CF_API_TOKEN secret/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Check token/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("a member sees Owner only", async () => {
    boot({ me: member });
    expect(await screen.findByText("Owner only")).toBeTruthy();
    expect(screen.queryByText(/Connected to the account/)).toBeNull();
  });
});

describe("Resync", () => {
  const batches = (steps: { next: string | null; ok?: number; failed?: { host: string; error: string }[] }[]) => {
    const sent: unknown[] = [];
    let i = 0;
    return { sent, route: ({ body }: { body: unknown }) => (sent.push(body), { body: { ok: 0, failed: [], ...steps[Math.min(i++, steps.length - 1)] } }) };
  };

  it("loops with the returned cursor until next is null", async () => {
    const b = batches([{ next: "d4", ok: 3 }, { next: "d7", ok: 3 }, { next: null, ok: 1 }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    expect(await screen.findByText("Checked 7. All repaired.")).toBeTruthy();
    expect(b.sent).toEqual([{}, { after: "d4" }, { after: "d7" }]);
  });

  it("a new run after a finished one starts from the first domain with fresh counts", async () => {
    const sent: unknown[] = [];
    const steps = [{ next: "d4", ok: 3 }, { next: null, ok: 1 }];
    const route = ({ body }: { body: unknown }) => ({ body: { failed: [], ...steps[sent.push(body) % 2 === 1 ? 0 : 1] } });
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    expect(await screen.findByText("Checked 4. All repaired.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Resync domains" }));
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(sent).toEqual([{}, { after: "d4" }, {}, { after: "d4" }]);
    expect(await screen.findByText("Checked 4. All repaired.")).toBeTruthy();
  });

  it("stops with Retry when the cursor does not move", async () => {
    const b = batches([{ next: "d4" }, { next: "d4" }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(b.sent).toHaveLength(2);
  });

  it("stops with Retry when the same domain is unreachable twice", async () => {
    const down = { host: "a.test", error: "cloudflare_unreachable" };
    const b = batches([{ next: "d2", failed: [down] }, { next: "d3", failed: [down] }, { next: null }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(b.sent).toHaveLength(2);
    expect(screen.getAllByText("a.test")).toHaveLength(1);
  });

  it("Retry after a stall does not duplicate the stalled host", async () => {
    const down = { host: "a.test", error: "cloudflare_unreachable" };
    const b = batches([{ next: "d2", failed: [down] }, { next: "d3", failed: [down] }, { next: "d3", failed: [down] }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(b.sent).toHaveLength(3));
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getAllByText("a.test")).toHaveLength(1);
  });

  it("a cloudflare_error failure is not unreachable: the run goes on", async () => {
    const bad = { host: "a.test", error: "cloudflare_error" };
    const b = batches([{ next: "d2", failed: [bad] }, { next: "d3", failed: [bad] }, { next: null }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    await waitFor(() => expect(b.sent).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("every stored failure code has copy", async () => {
    const codes = ["cloudflare_error", "cloudflare_forbidden", "internal_error", "outside_not_configured", "hostname_limit", "hostname_in_use"];
    const b = batches([{ next: null, failed: codes.map((error, i) => ({ host: `h${i}.test`, error })) }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    await screen.findByText("h0.test");
    expect(document.body.textContent).not.toContain("Something went wrong (");
  });

  it("lists failures", async () => {
    const b = batches([{ next: null, ok: 1, failed: [{ host: "x.test", error: "not_verified" }] }]);
    const { user } = boot({ routes: { "POST /api/settings/cloudflare/resync": b.route } });
    await user.click(await screen.findByRole("button", { name: "Resync domains" }));
    expect(await screen.findByText("x.test")).toBeTruthy();
    expect(screen.getByText(/Cloudflare has not confirmed this domain yet/)).toBeTruthy();
  });
});
