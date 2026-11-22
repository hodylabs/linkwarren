import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Domain, Me } from "../api";
import { AppProvider } from "../state";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { CfControls } from "./CfControls";

const owner: Me = { id: "uo", email: "o@example.com", name: null, role: "owner" };
const cf = (kind: string, securityLevel: string | null, rateLimit: number | null) => ({ kind, dns: "unknown", ownership: "unknown", certificate: "unknown", errors: [], lastError: null, checkedAt: null, instructions: null, attachOnApproval: false, securityLevel, rateLimit });
const dom = (kind: string, securityLevel: string | null = null, rateLimit: number | null = null): Domain => ({
  id: "d1", host: "go.test", type: "shared", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: true, cloudflare: cf(kind, securityLevel, rateLimit) as Domain["cloudflare"],
});

function boot(domain: Domain, controlsEnabled: boolean, routes: FakeRoutes = {}) {
  const api = fakeApi({ "GET /api/domains": () => ({ body: [] }), "GET /api/users": () => ({ body: { items: [] } }), ...routes });
  const user = userEvent.setup();
  render(<AppProvider me={owner}><CfControls domain={domain} controlsEnabled={controlsEnabled} /></AppProvider>);
  return { api, user };
}
const patches = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "PATCH");
afterEach(() => vi.unstubAllGlobals());

describe("CfControls", () => {
  it("is hidden for outside domains", () => {
    boot(dom("outside"), true);
    expect(screen.queryByText("Cloudflare")).toBeNull();
  });
  it("is hidden when controls are off", () => {
    boot(dom("account"), false);
    expect(screen.queryByText("Cloudflare")).toBeNull();
  });

  it("High then Ctrl+Enter sends only securityLevel", async () => {
    const { api, user } = boot(dom("account"), true, { "PATCH /api/domains/d1/cloudflare": () => ({ body: { securityLevel: "high", rateLimit: null } }) });
    await user.click(screen.getByRole("radio", { name: "High" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ securityLevel: "high" });
  });

  it("Ctrl+Enter stays inside the controls and does not reach a parent form", async () => {
    const outer = vi.fn();
    const api = fakeApi({ "GET /api/domains": () => ({ body: [] }), "PATCH /api/domains/d1/cloudflare": () => ({ body: { securityLevel: "high", rateLimit: null } }) });
    const user = userEvent.setup();
    render(<AppProvider me={owner}><div onKeyDown={outer}><CfControls domain={dom("account")} controlsEnabled={true} /></div></AppProvider>);
    await user.click(screen.getByRole("radio", { name: "High" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(outer.mock.calls.filter(([e]) => e.key === "Enter")).toHaveLength(0);
  });

  it("a rate of 5 shows the range error and sends nothing", async () => {
    const { api, user } = boot(dom("account"), true);
    await user.type(screen.getByLabelText("Rate limit"), "5{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("from 10 to 1000");
    expect(patches(api)).toHaveLength(0);
  });

  it("an emptied rate sends null", async () => {
    const { api, user } = boot(dom("account", null, 50), true, { "PATCH /api/domains/d1/cloudflare": () => ({ body: { securityLevel: null, rateLimit: null } }) });
    await user.clear(screen.getByLabelText("Rate limit"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ rateLimit: null });
  });

  it("shows the cloudflare_forbidden copy", async () => {
    const { user } = boot(dom("account"), true, { "PATCH /api/domains/d1/cloudflare": () => ({ status: 409, body: { error: "cloudflare_forbidden" } }) });
    await user.click(screen.getByRole("radio", { name: "Low" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toContain("missing a permission");
  });

  it("shows the plan-limit copy", async () => {
    const { user } = boot(dom("account"), true, { "PATCH /api/domains/d1/cloudflare": () => ({ status: 409, body: { error: "cloudflare_plan_limit" } }) });
    await user.type(screen.getByLabelText("Rate limit"), "20{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toBe("Your Cloudflare plan allows no more rate limit rules in this zone. Free plans allow one per zone.");
  });

  it("starts from the stored values and an unchanged Save sends nothing", async () => {
    const { api, user } = boot(dom("account", "high", 40), true);
    expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Rate limit") as HTMLInputElement).value).toBe("40");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    expect(patches(api)).toHaveLength(0);
  });

  it("a partial failure keeps the failed rate changed and the landed level not", async () => {
    let n = 0;
    const { api, user } = boot(dom("account", "high", 40), true, {
      "PATCH /api/domains/d1/cloudflare": () =>
        ++n === 1 ? { status: 409, body: { error: "cloudflare_plan_limit", securityLevel: "under_attack", rateLimit: 40 } } : { body: { securityLevel: "under_attack", rateLimit: 60 } },
    });
    await user.click(screen.getByRole("radio", { name: "Under attack" }));
    const rate = screen.getByLabelText("Rate limit");
    await user.clear(rate);
    await user.type(rate, "60");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("no more rate limit rules");
    expect(patches(api)[0]!.body).toEqual({ securityLevel: "under_attack", rateLimit: 60 });
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(patches(api)).toHaveLength(2));
    expect(patches(api)[1]!.body).toEqual({ rateLimit: 60 }); // the level landed, only the rate is retried
  });

  it("a success refreshes the domain list", async () => {
    const { api, user } = boot(dom("account", "high", 40), true, { "PATCH /api/domains/d1/cloudflare": () => ({ body: { securityLevel: "low", rateLimit: 40 } }) });
    await user.click(screen.getByRole("radio", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "GET" && c.path === "/api/domains").length).toBeGreaterThan(1));
  });
});
