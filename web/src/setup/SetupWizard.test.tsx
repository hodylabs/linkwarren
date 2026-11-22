import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const REPORT = { created: 2, skipped: 1, conflicts: [{ host: "go.test", slug: "taken", reason: "exists" }], caseSensitiveDomains: [], domainsCreated: ["new.test"], ignored: [], protected: [] };
const MAIN_ONLY = { steps: ALL, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN] };
const CSV = () => new File(["slug,url\nab,https://x.test\n"], "links.csv", { type: "text/csv" });
const ctrlEnter = "{Control>}{Enter}{/Control}";
const NO_PW = "No link in this file had a password";

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

  it("saving a replacement token checks again, even after a failed check, and an older check never wins", async () => {
    let n = 0, release!: () => void;
    const { api, user } = boot({
      steps: { ...NONE, name: true }, settings: { secrets: { pasteAvailable: true, cf: "dashboard", resend: "secret" } },
      routes: {
        "PUT /api/settings/secrets/cf": () => ({ body: { pasteAvailable: true, cf: "dashboard", resend: "secret" } }),
        "POST /api/settings/cloudflare/check": () => {
          n++;
          if (n === 1) return { status: 500, body: { error: "internal" } };
          if (n === 2) return new Promise((r) => (release = () => r({ body: { ...PERMS, accountName: "Old" } })));
          return { body: PERMS };
        },
      },
    });
    const input = await screen.findByLabelText("Cloudflare API token");
    await screen.findByRole("alert");
    // After a failed check, a new token starts a check (n = 2, held open).
    await user.type(input, "tok_ABCDEFGHIJKLMNOPQRSTUV{Control>}{Enter}{/Control}");
    await waitFor(() => expect(n).toBe(2));
    // A second token while that check is still running: its result is dropped and a check for this token follows.
    await user.type(input, "tok_BBCDEFGHIJKLMNOPQRSTUV{Control>}{Enter}{/Control}");
    await waitFor(() => expect(writes(api).filter((c) => c.method === "PUT")).toHaveLength(2));
    release();
    await waitFor(() => expect(n).toBe(3));
    expect(await screen.findByRole("list", { name: "Token permissions" })).toBeTruthy();
  });

  it("Cloudflare missing without paste shows the wrangler command", async () => {
    boot({ steps: { ...NONE, name: true }, settings: { secrets: { pasteAvailable: false, cf: "missing", resend: "secret" } } });
    expect(await screen.findByText("npx wrangler secret put CF_API_TOKEN -c wrangler.instance.jsonc")).toBeTruthy();
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
    await user.click(screen.getByLabelText(NO_PW));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^Imported 2, 1 already there, 1 conflicts/)).toBeTruthy();
    expect(writes(api).map((c) => c.path)).toEqual(["/api/import?dryRun=1", "/api/import"]);
    expect((writes(api)[1]!.body as { confirmNoPasswords?: boolean }).confirmNoPasswords).toBe(true);
  });

  it("refuses a file over 10 MB and a JSON that is not an export, without calling the server", async () => {
    const { api, user } = boot({ steps: ALL, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN] });
    await heading("Bring your links");
    const big = new File(["x"], "big.csv");
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText("Links file"), big);
    expect(await screen.findByText(/larger than 10 MB/)).toBeTruthy();
    await user.upload(screen.getByLabelText("Links file"), new File(['{"a":1}'], "e.json", { type: "application/json" }));
    expect(await screen.findByText(/This JSON is not a linkwarren import file/)).toBeTruthy();
    expect(writes(api)).toEqual([]);
  });

  it("Finish without a main domain shows what is missing", async () => {
    const { user } = boot({ steps: ALL, domains: [MAIN], routes: { "POST /api/setup/complete": () => ({ status: 400, body: { error: "incomplete", missing: ["mainDomain"] } }) } });
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

describe("import results", () => {
  it("lists protected links with what to do, and never claims password links are detected by itself", async () => {
    const rep = { ...REPORT, protected: [{ host: "go.test", slug: "secret" }] };
    const { user } = boot({ ...MAIN_ONLY, routes: { "POST /api/import": () => ({ body: rep }) } });
    await heading("Bring your links");
    expect(document.body.textContent).not.toMatch(/arrive disabled/);
    const json = { mainHost: "old.test", domains: [], links: [{ host: null, slug: "secret", destination: "https://x.test", enabled: true, protected: true }] };
    await user.upload(screen.getByLabelText("Links file"), new File([JSON.stringify(json)], "export.json", { type: "application/json" }));
    expect(await screen.findByText(/1 password link comes in locked/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Create each again with its new password: open the New link sheet, release the lock, set the password, then create.")).toBeTruthy();
    expect(screen.getByText("go.test/secret")).toBeTruthy();
  });

  it("shows the first 20 conflicts, and Download results has every row", async () => {
    const conflicts = Array.from({ length: 25 }, (_, i) => ({ host: "go.test", slug: i === 24 ? "=bad" : `c${i}`, reason: "exists" }));
    const { user } = boot({ ...MAIN_ONLY, routes: { "POST /api/import": () => ({ body: { ...REPORT, conflicts } }) } });
    let blob: Blob | null = null;
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => ((blob = b), "blob:x")), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await heading("Bring your links");
    await user.upload(screen.getByLabelText("Links file"), CSV());
    expect(await screen.findByText("and 5 more")).toBeTruthy();
    expect(screen.getByText("go.test/c19: exists")).toBeTruthy();
    expect(screen.queryByText("go.test/c20: exists")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Download results" }));
    const text = await blob!.text();
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(26);
    expect(text).toContain("go.test,'=bad,conflict,exists");
  });

  it("a stopped import offers Retry, which resumes; the file input is cleared for choosing again", async () => {
    let fail = true;
    const { api, user } = boot({ ...MAIN_ONLY, routes: { "POST /api/import": ({ url }) => (url.search || !fail ? { body: REPORT } : ((fail = false), { status: 502, body: { error: "internal_error" } })) } });
    await heading("Bring your links");
    const input = screen.getByLabelText("Links file") as HTMLInputElement;
    await user.upload(input, CSV());
    await user.click(await screen.findByLabelText(NO_PW));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^Stopped at part 1 of 1/)).toBeTruthy();
    expect(input.value).toBe("");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/^Imported 2, 1 already there, 1 conflicts/)).toBeTruthy();
    expect(writes(api).map((c) => c.path)).toEqual(["/api/import?dryRun=1", "/api/import", "/api/import"]);
  });

  it("a main domain changed after choosing the file rebuilds the import for the new domain", async () => {
    const ALT = { ...MAIN, id: "d2", host: "alt.test" };
    const { api, user } = boot({ steps: ALL, settings: { name: "N", mainDomainId: "d0" }, domains: [MAIN, ALT] });
    await heading("Bring your links");
    await user.upload(screen.getByLabelText("Links file"), CSV());
    await user.click(await screen.findByLabelText(NO_PW));
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    await heading("Email");
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    await heading("Main domain");
    await user.click(screen.getByRole("radio", { name: "alt.test" }));
    await user.click(screen.getByRole("button", { name: /^Continue/ }));
    await heading("Email");
    await user.click(screen.getByRole("button", { name: /^Continue/ }));
    await heading("Bring your links");
    await waitFor(() => expect(writes(api).filter((c) => c.path === "/api/import?dryRun=1")).toHaveLength(2));
    await user.click(await screen.findByLabelText(NO_PW));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^Imported 2/)).toBeTruthy();
    const imports = writes(api).filter((c) => c.path.startsWith("/api/import"));
    expect(imports.map((c) => (c.body as { mainHost: string }).mainHost)).toEqual(["go.test", "alt.test", "alt.test"]);
  });

  it("shows progress while a part is on its way", async () => {
    let release = () => undefined as void;
    const { user } = boot({ ...MAIN_ONLY, routes: { "POST /api/import": () => new Promise((r) => (release = () => r({ body: REPORT }))) } });
    await heading("Bring your links");
    await user.upload(screen.getByLabelText("Links file"), CSV());
    expect(await screen.findByText("Checking part 1 of 1")).toBeTruthy();
    release();
    expect(await screen.findByText(/2 to import/)).toBeTruthy();
  });
});

describe("takeover and keys", () => {
  const takeover = { status: 409, body: { error: "dns_record_exists", records: [{ type: "A", name: "www.example.test", content: "192.0.2.1" }] } };

  it("a DNS record in the way is named, Ctrl+Enter never confirms, and only the explicit button sends confirmTakeover", async () => {
    let n = 0;
    const { api, user } = boot({ steps: { ...NONE, name: true, cloudflare: true }, routes: {
      "POST /api/domains": ({ body }) => ((body as { confirmTakeover?: boolean }).confirmTakeover ? ((n = 1), { status: 201, body: { ...MAIN, id: "dn", host: "www.example.test" } }) : takeover),
    } });
    await heading("Main domain");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
    await user.keyboard(`www.example.test${ctrlEnter}`);
    const callout = await screen.findByText(/www\.example\.test already has DNS records in your Cloudflare account/);
    expect(callout.textContent).toContain("A www.example.test 192.0.2.1");
    await user.keyboard(ctrlEnter);
    await waitFor(() => expect(writes(api).filter((c) => c.path === "/api/domains")).toHaveLength(2));
    expect(writes(api).every((c) => !(c.body as { confirmTakeover?: boolean } | undefined)?.confirmTakeover)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Replace the record for www.example.test and continue" }));
    expect(await heading("Email")).toBeTruthy();
    expect(n).toBe(1);
    expect(writes(api).filter((c) => c.path === "/api/domains").at(-1)!.body).toEqual({ host: "www.example.test", type: "main", confirmTakeover: true });
  });

  it("a held Ctrl+Enter (key repeat) does not walk through steps", async () => {
    const { user } = boot({ steps: { ...NONE, name: true } });
    await heading("Connect Cloudflare");
    await screen.findByRole("list", { name: "Token permissions" });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, repeat: true });
    expect(screen.getByRole("heading", { level: 1, name: "Connect Cloudflare" })).toBeTruthy();
    await user.keyboard(ctrlEnter);
    expect(await heading("Main domain")).toBeTruthy();
  });

  it("Check again runs the check again after a failure", async () => {
    let n = 0;
    const { user } = boot({ steps: { ...NONE, name: true }, routes: { "POST /api/settings/cloudflare/check": () => (++n === 1 ? { status: 502, body: { error: "cloudflare_unreachable" } } : { body: PERMS }) } });
    await heading("Connect Cloudflare");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("list", { name: "Token permissions" })).toBeTruthy();
    expect(n).toBe(2);
  });

  it("focus moves to the error, and Esc goes back a step", async () => {
    const { user } = boot({ steps: { ...NONE, name: true } });
    await heading("Connect Cloudflare");
    await user.keyboard("{Escape}");
    expect(await heading("Sign-in")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(await heading("Name it")).toBeTruthy();
    await user.clear(screen.getByLabelText("Name"));
    await user.keyboard(ctrlEnter);
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("load states", () => {
  it("a slow /api/instance shows a message with Reload instead of a blank page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api } = boot({ routes: { "GET /api/instance": () => new Promise(() => undefined) } });
      await waitFor(() => expect(api.calls.some((c) => c.path === "/api/instance")).toBe(true));
      expect(document.body.textContent).toBe("");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await screen.findByText(/is taking longer than it should/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner whose /api/instance fails gets a retryable error, neither the shell nor the wizard", async () => {
    let fail = true;
    const ok = { name: "Links", logoVersion: null, configured: true, dashboardHost: "links.example.com", mainDomainId: null, linkDefaults: { redirectCode: 302, passQuery: true } };
    const { user } = boot({ routes: { "GET /api/instance": () => (fail ? ((fail = false), { status: 500, body: { error: "internal_error" } }) : { body: ok }) } });
    expect(await screen.findByText("Could not load this instance.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Links" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Name it" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
  });

  it("a member whose /api/instance fails still gets the shell", async () => {
    boot({ me: member, routes: { "GET /api/instance": () => ({ status: 500, body: { error: "internal_error" } }) } });
    expect(await screen.findByRole("heading", { name: "Links" })).toBeTruthy();
  });

  it("a failed domain load shows in the wizard with Retry, and no domain is offered to create", async () => {
    let fail = true;
    const { user } = boot({ steps: { ...NONE, name: true, cloudflare: true }, routes: { "GET /api/domains": () => (fail ? ((fail = false), { status: 500, body: { error: "internal_error" } }) : { body: [MAIN] }) } });
    await heading("Main domain");
    expect(await screen.findByText(/Could not load the dashboard data/)).toBeTruthy();
    expect(screen.queryByLabelText("Domain")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("radio", { name: "go.test" })).toBeTruthy();
  });

  it("a signed-out answer shows the sign-in banner", async () => {
    const { user } = boot({ routes: { "PATCH /api/settings": () => ({ status: 401, body: { error: "unauthenticated" } }) } });
    await heading("Name it");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    await user.keyboard(`N${ctrlEnter}`);
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
  });
});

describe("N2: a file that does not say which links had a password", () => {
  it("the dry run warns, Import stays disabled until the owner confirms, then the real run carries the confirmation", async () => {
    const { api, user } = boot(MAIN_ONLY);
    await heading("Bring your links");
    const json = { mainHost: "old.test", domains: [], links: [{ host: null, slug: "s", destination: "https://x.test", enabled: true }] };
    await user.upload(screen.getByLabelText("Links file"), new File([JSON.stringify(json)], "export.json", { type: "application/json" }));
    expect(await screen.findByText("This file does not say which links had a password. Confirm none did, or give every link a protected field.")).toBeTruthy();
    const imp = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(imp.disabled).toBe(true);
    await user.click(imp);
    expect(writes(api).map((c) => c.path)).toEqual(["/api/import?dryRun=1"]);
    expect((writes(api)[0]!.body as { confirmNoPasswords?: boolean }).confirmNoPasswords).toBeUndefined();
    await user.click(screen.getByLabelText(NO_PW));
    expect(imp.disabled).toBe(false);
    await user.click(imp);
    expect(await screen.findByText(/^Imported 2/)).toBeTruthy();
    expect((writes(api)[1]!.body as { confirmNoPasswords?: boolean }).confirmNoPasswords).toBe(true);
  });

  it("a file whose links carry protected shows no warning and needs no confirmation", async () => {
    const { api, user } = boot(MAIN_ONLY);
    await heading("Bring your links");
    const json = { mainHost: "old.test", domains: [], links: [{ host: null, slug: "s", destination: "https://x.test", enabled: true, protected: false }] };
    await user.upload(screen.getByLabelText("Links file"), new File([JSON.stringify(json)], "export.json", { type: "application/json" }));
    await screen.findByText(/2 to import/);
    expect(screen.queryByLabelText(NO_PW)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^Imported 2/)).toBeTruthy();
    expect((writes(api)[1]!.body as { confirmNoPasswords?: boolean }).confirmNoPasswords).toBeUndefined();
  });
});

describe("M7: a main domain outside the Cloudflare account", () => {
  const cf = (kind: "outside" | "manual") => ({
    kind, dns: "missing", ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1, securityLevel: null, rateLimit: null,
    instructions: kind === "outside" ? { type: "CNAME", name: "go.new.test", target: "links.example.com", apex: false } : null, attachOnApproval: false, attached: false,
  });
  for (const kind of ["outside", "manual"] as const)
    it(`${kind}: the step stays with the DNS next step, then Ctrl+Enter continues`, async () => {
      const domains: object[] = [];
      const { user } = boot({
        steps: { ...NONE, name: true, cloudflare: true }, domains,
        routes: { "POST /api/domains": () => {
          const d = { ...MAIN, id: "dn", host: "go.new.test", cloudflare: cf(kind) };
          domains.push(d);
          return { status: 201, body: d };
        } },
      });
      await heading("Main domain");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
      await user.keyboard(`go.new.test${ctrlEnter}`);
      expect(await screen.findByText(kind === "outside" ? /new\.test isn't in your Cloudflare account/ : /Cloudflare is not connected on this linkwarren/)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1, name: "Main domain" })).toBeTruthy();
      await user.keyboard(ctrlEnter);
      expect(await heading("Email")).toBeTruthy();
    });
  it("a domain created before the main domain save failed still shows its DNS next step after Retry", async () => {
    const domains: object[] = [];
    let fail = true;
    const { user } = boot({
      steps: { ...NONE, name: true, cloudflare: true },
      routes: {
        "GET /api/domains": () => ({ body: domains }),
        "POST /api/domains": () => {
          const d = { ...MAIN, id: "dn", host: "go.new.test", cloudflare: cf("outside") };
          domains.push(d);
          return { status: 201, body: d };
        },
        "PATCH /api/settings": ({ body }) => (fail ? ((fail = false), { status: 500, body: { error: "internal_error" } }) : { body: { ...SETTINGS, ...(body as object) } }),
      },
    });
    await heading("Main domain");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
    await user.keyboard(`go.new.test${ctrlEnter}`);
    expect(await screen.findByRole("radio", { name: "go.new.test" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Continue/ }));
    expect(await screen.findByText(/new\.test isn't in your Cloudflare account/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Main domain" })).toBeTruthy();
  });
});

describe("M8: Alt+Left in a text field", () => {
  it("keeps the field's own word jump: no step change while typing; outside a field it goes back", async () => {
    const { user } = boot({ steps: { ...NONE, name: true, cloudflare: true } });
    await heading("Main domain");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Domain")));
    await user.keyboard("go.new.test{Alt>}{ArrowLeft}{/Alt}");
    expect(screen.getByRole("heading", { level: 1, name: "Main domain" })).toBeTruthy();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(await heading("Connect Cloudflare")).toBeTruthy();
  });
});
