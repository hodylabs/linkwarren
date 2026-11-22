import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me } from "../api";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner", authMode: "app" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", authMode: "app" };
const MAIN = { id: "d0", host: "go.test", type: "main", status: "active", ownerId: "uo", linkCount: 0, isMember: false };
type Steps = { name: boolean; signIn: true; cloudflare: boolean; mainDomain: boolean; email: boolean };
const NONE: Steps = { name: false, signIn: true, cloudflare: false, mainDomain: false, email: false };
const ALL: Steps = { name: true, signIn: true, cloudflare: true, mainDomain: true, email: true };
const SETTINGS = {
  name: null, mainDomainId: null, dashboardHost: "links.example.com", authMode: "app", emailFrom: "links@example.com", emailConfigured: true,
  secrets: { pasteAvailable: true, cf: "secret", resend: "secret" }, linkRedirectCode: 302, linkPassQuery: true, retention: { auditDays: 1096, clickDetailDays: 90 },
};
const PERMS = { token: "active", accountName: "Acme", permissions: [{ key: "zone_read", state: "ok" }, { key: "ssl_edit", state: "missing" }] };
const REPORT = { created: 2, skipped: 1, conflicts: [{ host: "go.test", slug: "taken", reason: "exists" }], caseSensitiveDomains: [], domainsCreated: ["new.test"], ignored: [] };

function boot(o: { me?: Me; configured?: boolean; steps?: Steps; settings?: object; domains?: object[]; routes?: FakeRoutes; path?: string } = {}) {
  history.replaceState(null, "", o.path ?? "/links");
  let configured = o.configured ?? false;
  let settings: Record<string, unknown> = { ...SETTINGS, ...o.settings };
  const domains = [...(o.domains ?? [])];
  const api = fakeApi({
    "GET /api/me": () => ({ body: o.me ?? owner }),
    "GET /api/domains": () => ({ body: domains }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/links": () => ({ body: { items: [], next: null } }),
    "GET /api/instance": () => ({ body: { name: settings.name, logoVersion: null, configured, dashboardHost: "links.example.com", mainDomainId: settings.mainDomainId, linkDefaults: { redirectCode: 302, passQuery: true } } }),
    "GET /api/setup": () => ({ body: { configured, steps: o.steps ?? NONE } }),
    "GET /api/settings": () => ({ body: settings }),
    "PATCH /api/settings": ({ body }) => ({ body: (settings = { ...settings, ...(body as object) }) }),
    "POST /api/settings/cloudflare/check": () => ({ body: PERMS }),
    "POST /api/domains": ({ body }) => {
      const d = { ...MAIN, id: "dn", host: (body as { host: string }).host };
      domains.push(d);
      return { status: 201, body: d };
    },
    "POST /api/import": () => ({ body: REPORT }),
    "POST /api/settings/email/test": () => ({ body: { ok: true } }),
    "POST /api/setup/complete": () => {
      configured = true;
      return { body: { configured: true } };
    },
    ...o.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const noBannedWords = () => expect(document.body.textContent).not.toMatch(/Google|one-time code|Access/);
afterEach(() => vi.restoreAllMocks());

describe("setup wizard gate", () => {
  it("shows the wizard to an owner of an unconfigured instance, with the six steps and the footer", async () => {
    boot();
    expect(await heading("Name it")).toBeTruthy();
    const list = screen.getByRole("complementary", { name: "Setup steps" });
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector("b")!.textContent)).toEqual(["Name it", "Sign-in", "Connect Cloudflare", "Main domain", "Email", "Bring your links"]);
    expect(screen.getByText("Everything here can be changed later in Settings. Your answers are saved as you go.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
  });

  it("a member never sees it", async () => {
    const { api } = boot({ me: member });
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
    expect(screen.queryByText("Name it")).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith("/api/setup"))).toBe(false);
  });

  it("a configured instance shows the shell, and /setup goes to /settings/instance", async () => {
    boot({ configured: true, path: "/setup", settings: { name: "Northwind", mainDomainId: "d0" }, domains: [MAIN] });
    expect(await screen.findByRole("heading", { name: "This instance" })).toBeTruthy();
    expect(location.pathname).toBe("/settings/instance");
    expect(screen.queryByText("Name it")).toBeNull();
  });
});

describe("setup wizard steps", () => {
  it("Ctrl+Enter saves the name and advances; Alt+Left goes back with the saved value", async () => {
    const { api, user } = boot();
    await heading("Name it");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    await user.keyboard("Northwind{Control>}{Enter}{/Control}");
    expect(await heading("Sign-in")).toBeTruthy();
    expect(writes(api)).toEqual([{ method: "PATCH", path: "/api/settings", body: { name: "Northwind" } }]);
    expect(screen.getByText("You signed in with an email link. People you invite sign in the same way.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a passkey/ })).toBeTruthy();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await heading("Name it")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Northwind");
  });

  it("an empty name does not save", async () => {
    const { api, user } = boot();
    await heading("Name it");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(writes(api)).toEqual([]);
  });

  it("Cloudflare set by a Worker secret shows the permission rows and no input", async () => {
    const { user } = boot({ steps: { ...NONE, name: true } });
    expect(await heading("Connect Cloudflare")).toBeTruthy();
    expect(await screen.findByRole("list", { name: "Token permissions" })).toBeTruthy();
    expect(screen.getByText("Set via Worker secret")).toBeTruthy();
    expect(screen.queryByLabelText("Cloudflare API token")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(screen.getByText(/CF_ACCOUNT_ID and CF_WORKER_NAME/)).toBeTruthy();
    noBannedWords();
  });

  it("Cloudflare missing with paste available shows the field; without it shows the command", async () => {
    const { user } = boot({ steps: { ...NONE, name: true }, settings: { secrets: { pasteAvailable: true, cf: "missing", resend: "secret" } } });
    const input = await screen.findByLabelText("Cloudflare API token");
    expect(screen.queryByRole("list", { name: "Token permissions" })).toBeNull();
    // An empty token field leaves Ctrl+Enter to the wizard: Continue without a token.
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await heading("Main domain")).toBeTruthy();
  });

  it("Cloudflare missing without paste shows the wrangler command", async () => {
    boot({ steps: { ...NONE, name: true }, settings: { secrets: { pasteAvailable: false, cf: "missing", resend: "secret" } } });
    expect(await screen.findByText("npx wrangler secret put CF_API_TOKEN")).toBeTruthy();
    expect(screen.queryByLabelText("Cloudflare API token")).toBeNull();
  });

  it("a pasted token Cloudflare refuses shows the token_invalid copy, and Skip for now continues", async () => {
    const { user } = boot({
      steps: { ...NONE, name: true }, settings: { secrets: { pasteAvailable: true, cf: "missing", resend: "secret" } },
      routes: { "PUT /api/settings/secrets/cf": () => ({ status: 400, body: { error: "token_invalid" } }) },
    });
    const input = await screen.findByLabelText("Cloudflare API token");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("abcdefghijklmnopqrstuvwxyz{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Cloudflare does not accept this token. Copy the whole token and check that it is active.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Connect Cloudflare" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await heading("Main domain")).toBeTruthy();
  });

  it("Main domain creates the domain, then saves it as the main domain", async () => {
    const { api, user } = boot({ steps: { ...NONE, name: true, cloudflare: true } });
    expect(await heading("Main domain")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
    await user.keyboard("go.new.test{Control>}{Enter}{/Control}");
    expect(await heading("Email")).toBeTruthy();
    expect(writes(api)).toEqual([
      { method: "POST", path: "/api/domains", body: { host: "go.new.test", type: "main" } },
      { method: "PATCH", path: "/api/settings", body: { mainDomainId: "dn" } },
    ]);
  });

  it("Main domain offers the existing main domains as a choice", async () => {
    const { api, user } = boot({ steps: { ...NONE, name: true, cloudflare: true }, domains: [MAIN, { ...MAIN, id: "d1", host: "nw.test" }] });
    await heading("Main domain");
    await user.click(await screen.findByRole("radio", { name: "nw.test" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await heading("Email")).toBeTruthy();
    expect(writes(api)).toEqual([{ method: "PATCH", path: "/api/settings", body: { mainDomainId: "d1" } }]);
  });

  it("Email shows the sender read-only and sends a test email", async () => {
    const { api, user } = boot({ steps: { ...ALL, email: false }, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN] });
    expect(await heading("Email")).toBeTruthy();
    expect(screen.getByText("links@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("Resend API key")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Sent a test email to o@example.com.")).toBeTruthy();
    expect(writes(api).map((c) => c.path)).toEqual(["/api/settings/email/test"]);
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await heading("Bring your links")).toBeTruthy();
  });

  it("import dry-runs the file first, then imports on request", async () => {
    const { api, user } = boot({ steps: ALL, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN] });
    await heading("Bring your links");
    await user.upload(screen.getByLabelText("Links file"), new File(["slug,url\nab,https://x.test\n"], "links.csv", { type: "text/csv" }));
    expect(await screen.findByText("2 to import, 1 already there, 1 conflicts, new domains: new.test")).toBeTruthy();
    expect(writes(api)).toEqual([{ method: "POST", path: "/api/import?dryRun=1", body: { mainHost: "go.test", domains: [], links: [{ host: null, slug: "ab", destination: "https://x.test", enabled: true, startDate: null, endDate: null }] } }]);
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^Imported 2, 1 already there, 1 conflicts/)).toBeTruthy();
    expect(writes(api).map((c) => c.path)).toEqual(["/api/import?dryRun=1", "/api/import"]);
  });

  it("refuses a file over 10 MB and a JSON that is not an export, without calling the server", async () => {
    const { api, user } = boot({ steps: ALL, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN] });
    await heading("Bring your links");
    const big = new File(["x"], "big.csv");
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText("Links file"), big);
    expect(await screen.findByText(/larger than 10 MB/)).toBeTruthy();
    await user.upload(screen.getByLabelText("Links file"), new File(['{"a":1}'], "e.json", { type: "application/json" }));
    expect(await screen.findByText(/This JSON is not a linkwarren or legacy export/)).toBeTruthy();
    expect(writes(api)).toEqual([]);
  });

  it("Finish without a main domain shows what is missing", async () => {
    const { user } = boot({ steps: ALL, routes: { "POST /api/setup/complete": () => ({ status: 400, body: { error: "incomplete", missing: ["mainDomain"] } }) } });
    await heading("Bring your links");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Setup cannot finish yet: add a main domain first.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Bring your links" })).toBeTruthy();
  });
});

describe("setup wizard end to end", () => {
  it("keyboard only: every step, then Finish renders the shell", async () => {
    const { api, user } = boot();
    const ctrlEnter = "{Control>}{Enter}{/Control}";
    await heading("Name it");
    noBannedWords();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    await user.keyboard(`Northwind${ctrlEnter}`);
    await heading("Sign-in");
    noBannedWords();
    await user.keyboard(ctrlEnter);
    await heading("Connect Cloudflare");
    await screen.findByRole("list", { name: "Token permissions" });
    noBannedWords();
    await user.keyboard(ctrlEnter);
    await heading("Main domain");
    noBannedWords();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
    await user.keyboard(`go.new.test${ctrlEnter}`);
    await heading("Email");
    noBannedWords();
    await user.keyboard(ctrlEnter);
    await heading("Bring your links");
    noBannedWords();
    await user.keyboard(ctrlEnter);
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
    expect(screen.queryByText("Name it")).toBeNull();
    expect(location.pathname).toBe("/links");
    expect(writes(api).map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /api/settings", "POST /api/settings/cloudflare/check", "POST /api/domains", "PATCH /api/settings", "POST /api/setup/complete",
    ]);
  });
});
