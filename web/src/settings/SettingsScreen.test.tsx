import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me } from "../api";
import { buildCommands } from "../shell/palette";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import css from "../styles.css?raw";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner", authMode: "app" };
const member: Me = { id: "um", email: "m@example.com", name: null, role: "member", authMode: "app" };
const DOMAINS = [
  { id: "d0", host: "go.test", type: "main", status: "active" },
  { id: "d1", host: "nw.test", type: "main", status: "active" },
  { id: "ds", host: "shared.test", type: "shared", status: "active" },
];
const SETTINGS = {
  name: "Northwind", mainDomainId: "d0", dashboardHost: "links.example.com", authMode: "app", emailFrom: "links@example.com", emailConfigured: true,
  secrets: { pasteAvailable: true, cf: "secret", resend: "missing" }, linkRedirectCode: 302, linkPassQuery: true, retention: { auditDays: 1096, clickDetailDays: 90 },
};
const INSTANCE = { name: "Northwind", logoVersion: null, configured: true, dashboardHost: "links.example.com", mainDomainId: "d0", linkDefaults: { redirectCode: 302, passQuery: true } };

function boot(path: string, o: { me?: Me; settings?: object; routes?: FakeRoutes } = {}) {
  history.replaceState(null, "", path);
  let instance = { ...INSTANCE };
  const api = fakeApi({
    "GET /api/me": () => ({ body: o.me ?? owner }),
    "GET /api/domains": () => ({ body: DOMAINS }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/instance": () => ({ body: instance }),
    "GET /api/settings": () => ({ body: { ...SETTINGS, ...o.settings } }),
    "GET /api/account": () => ({ body: { passkeys: [], sessions: [] } }),
    "PATCH /api/settings": ({ body }) => {
      instance = { ...instance, ...(body as object) };
      return { body: { ...SETTINGS, ...o.settings, ...(body as object) } };
    },
    ...o.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
afterEach(() => vi.restoreAllMocks());

describe("Settings sections", () => {
  it("a member at /settings/email sees Owner only and never reads /api/settings", async () => {
    const { api } = boot("/settings/email", { me: member });
    expect(await screen.findByText("Owner only")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls.some((c) => c.path.startsWith("/api/settings"))).toBe(false);
  });

  it("/settings and unknown sections land on This instance", async () => {
    boot("/settings/nope");
    expect(await screen.findByRole("heading", { name: "This instance" })).toBeTruthy();
    expect(location.pathname).toBe("/settings/instance");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["This instance", "Sign-in", "Cloudflare", "Email", "Link defaults", "Data and retention", "Backups and export"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["instance", "sign-in", "cloudflare", "email", "link-defaults", "data", "backups"].map((s) => `/settings/${s}`));
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
  });

  it("editing only the name then Ctrl+Enter sends { name } and the rail and title show it", async () => {
    const { api, user } = boot("/settings/instance");
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await waitFor(() => expect(document.title).toBe("Northwind"));
    await user.clear(name);
    await user.type(name, "Acme Links{Control>}{Enter}{/Control}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "PATCH", path: "/api/settings", body: { name: "Acme Links" } });
    await waitFor(() => expect(screen.getByRole("link", { name: "Acme Links home" })).toBeTruthy());
    expect(document.title).toBe("Acme Links");
  });

  it("the main domain lists main domains only and sends only mainDomainId", async () => {
    const { api, user } = boot("/settings/instance");
    const sel = (await screen.findByLabelText("Main domain")) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["go.test", "nw.test"]);
    await user.selectOptions(sel, "d1");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]!.body).toEqual({ mainDomainId: "d1" });
  });

  it("the dashboard address is read-only text", async () => {
    boot("/settings/instance");
    expect(await screen.findByText("links.example.com")).toBeTruthy();
    expect(screen.queryByDisplayValue("links.example.com")).toBeNull();
  });

  it("a logo upload sends type and base64; a refused one shows its copy", async () => {
    let n = 0;
    const { api, user } = boot("/settings/instance", {
      routes: { "PUT /api/settings/logo": () => (++n === 1 ? { body: { logoVersion: 5 } } : { status: 400, body: { error: "not_square" } }) },
    });
    const input = (await screen.findByLabelText("Logo file")) as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/webp,image/jpeg");
    expect(screen.getByText(/PNG, WebP or JPEG, square, up to 1024 px and 64 KB/)).toBeTruthy();
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "l.png", { type: "image/png" }));
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]).toMatchObject({ method: "PUT", path: "/api/settings/logo", body: { type: "image/png", data: "AQID" } });
    await user.upload(input, new File([new Uint8Array([1])], "l.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toContain("square");
  });

  it("a GIF is refused before upload", async () => {
    const { api } = boot("/settings/instance");
    const input = (await screen.findByLabelText("Logo file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "l.gif", { type: "image/gif" })] } });
    expect((await screen.findByRole("alert")).textContent).toContain("PNG, WebP or JPEG");
    expect(writes(api)).toHaveLength(0);
  });

  it("Sign-in shows the app mode line and the account panel", async () => {
    const { api } = boot("/settings/sign-in");
    expect(await screen.findByText("linkwarren sign-in: email link and passkeys")).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/account")).toBe(true));
  });

  it("Sign-in in access mode shows Cloudflare Access and the team domain", async () => {
    boot("/settings/sign-in", { me: { ...owner, authMode: "access" }, settings: { authMode: "access", teamDomain: "team.cloudflareaccess.com" } });
    expect(await screen.findByText("Cloudflare Access")).toBeTruthy();
    expect(screen.getByText("team.cloudflareaccess.com")).toBeTruthy();
  });

  it("Email: sender read-only, key status and SecretField; a 429 test shows the too_soon copy", async () => {
    const { api, user } = boot("/settings/email", { routes: { "POST /api/settings/email/test": () => ({ status: 429, body: { error: "too_soon" } }) } });
    expect(await screen.findByText("links@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Resend API key")).toBeTruthy();
    expect(screen.getByText(/A fresh instance needs the RESEND_API_KEY Worker secret, because the owner signs in by email\. A key pasted here is used only when no Worker secret is set/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A test email was just sent. Wait a minute before sending another.");
    expect(writes(api)).toHaveLength(1);
  });

  it("Email without EMAIL_FROM says how to set it; a sent test names the address", async () => {
    const { user } = boot("/settings/email", { settings: { emailFrom: null }, routes: { "POST /api/settings/email/test": () => ({ body: { ok: true } }) } });
    expect(await screen.findByText("Not set. Add EMAIL_FROM to the Worker config.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Sent to o@example.com.")).toBeTruthy();
  });

  it("Cloudflare keeps the S3 section and adds the token status and SecretField", async () => {
    boot("/settings/cloudflare", {
      settings: { secrets: { pasteAvailable: false, cf: "missing", resend: "missing" } },
      routes: { "GET /api/settings/cloudflare": () => ({ body: { configured: false } }) },
    });
    expect(await screen.findByText(/Cloudflare is not connected/)).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.getByText("npx wrangler secret put CF_API_TOKEN -c wrangler.instance.jsonc")).toBeTruthy();
  });

  it("Data and retention shows the server's retention as rows", async () => {
    boot("/settings/data");
    expect(await screen.findByText("Keep 3 years")).toBeTruthy();
    expect(screen.getByText("Keep 90 days, then daily totals")).toBeTruthy();
    expect(screen.getByText("Locked until the owner releases them")).toBeTruthy();
  });

  it("export runs every page and creates one download", async () => {
    const create = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const pages = [{ rows: [{ id: "u1" }], next: 1 }, { rows: [{ id: "u2" }], next: null }];
    const { api, user } = boot("/settings/backups", {
      routes: {
        "POST /api/export/start": () => ({ body: { format: "linkwarren-export", version: 1, exportedAt: 1, run: "r", includeAnalytics: false, estimatedReads: 2, logo: null, tables: [{ name: "users", columns: ["id"], rows: 2 }] } }),
        "POST /api/export/page": () => ({ body: pages.shift() }),
      },
    });
    expect(await screen.findByText(/Cloudflare D1 keeps point-in-time restore \(Time Travel\) for 7 days on Workers Free and 30 days on Workers Paid/)).toBeTruthy();
    expect((screen.getByLabelText(/Include click analytics/) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Download full export" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(writes(api).map((c) => c.path)).toEqual(["/api/export/start", "/api/export/page", "/api/export/page"]);
    expect(writes(api)[0]!.body).toEqual({ includeAnalytics: false });
    expect((await screen.findByText(": 2 rows")).textContent).toBe("users: 2 rows");
    expect(screen.getByText(/About 2 rows to read, 0% of the free daily D1 reads/)).toBeTruthy();
  });

  it("Cancel works while the export is starting: the Download button is disabled, Esc aborts /start and nothing downloads", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let release = () => undefined as void;
    const { api, user } = boot("/settings/backups", {
      routes: { "POST /api/export/start": () => new Promise((r) => (release = () => r({ body: { format: "linkwarren-export", version: 1, exportedAt: 1, run: "r", includeAnalytics: false, estimatedReads: 2, logo: null, tables: [{ name: "users", columns: ["id"], rows: 2 }] } }))) },
    });
    await user.click(await screen.findByRole("button", { name: "Download full export" }));
    expect((screen.getByRole("button", { name: "Download full export" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    release();
    await waitFor(() => expect((screen.getByRole("button", { name: "Download full export" }) as HTMLButtonElement).disabled).toBe(false));
    expect(writes(api).map((c) => c.path)).toEqual(["/api/export/start"]);
    expect(click).not.toHaveBeenCalled();
  });

  it("a large export asks first; Cancel reads no page", async () => {
    const { api, user } = boot("/settings/backups", {
      routes: { "POST /api/export/start": () => ({ body: { format: "linkwarren-export", version: 1, exportedAt: 1, run: "r", includeAnalytics: true, estimatedReads: 2_000_000, logo: null, tables: [{ name: "users", columns: ["id"], rows: 2 }] } }) },
    });
    await user.click(await screen.findByLabelText(/Include click analytics/));
    await user.click(screen.getByRole("button", { name: "Download full export" }));
    expect(await screen.findByText(/40% of the free daily D1 reads/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(writes(api).map((c) => c.path)).toEqual(["/api/export/start"]);
    expect(writes(api)[0]!.body).toEqual({ includeAnalytics: true });
  });

  it("keyboard only: Tab to a section link, Enter opens it, arrows switch, Space and Ctrl+Enter save link defaults", async () => {
    const { api, user } = boot("/settings/instance");
    await screen.findByLabelText("Name");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    within(nav).getByRole("link", { name: "This instance" }).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(location.pathname).toBe("/settings/sign-in"));
    expect(document.activeElement?.textContent).toBe("Sign-in");
    for (let i = 0; i < 3; i++) await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(location.pathname).toBe("/settings/link-defaults"));
    for (let i = 0; i < 3; i++) await user.tab(); // past the last two section links into the section
    const radio = screen.getByRole("radio", { name: "302 editable" });
    expect(document.activeElement).toBe(radio);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "301 fixed" }).getAttribute("aria-checked")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("switch", { name: "Pass query string through" }));
    await user.keyboard(" ");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    expect(writes(api)[0]!.body).toEqual({ linkRedirectCode: 301, linkPassQuery: false });
  });

  it("a failed settings load offers Retry", async () => {
    let n = 0;
    const { user } = boot("/settings/data", { routes: { "GET /api/settings": () => (++n === 1 ? { status: 500, body: { error: "internal" } } : { body: SETTINGS }) } });
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Keep 3 years")).toBeTruthy();
  });

  it("arrow keys step from the focused section link, not the open one", async () => {
    const { user } = boot("/settings/instance");
    await screen.findByLabelText("Name");
    screen.getByRole("link", { name: "Email" }).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(location.pathname).toBe("/settings/link-defaults"));
    expect(document.activeElement?.textContent).toBe("Link defaults");
  });

  it("a token paste before the Cloudflare variables are set says to set them first", async () => {
    const { user } = boot("/settings/cloudflare", {
      settings: { secrets: { pasteAvailable: true, cf: "missing", resend: "missing" } },
      routes: { "GET /api/settings/cloudflare": () => ({ body: { configured: false } }), "PUT /api/settings/secrets/cf": () => ({ status: 409, body: { error: "cloudflare_not_configured" } }) },
    });
    await user.type(await screen.findByLabelText("Cloudflare API token"), "tok_ABCDEFGHIJKLMNOPQRSTUV");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Set the Cloudflare account variables in the Worker config first, then paste the token.");
  });

  it("Enter on a focused section link opens it, and the back button returns", async () => {
    const { user } = boot("/settings/instance");
    await screen.findByLabelText("Name");
    screen.getByRole("link", { name: "Email" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Email" })).toBeTruthy();
    act(() => history.back());
    expect(await screen.findByRole("heading", { name: "This instance" })).toBeTruthy();
  });

  it("Esc reverts unsaved edits; nothing changed sends nothing", async () => {
    const { api, user } = boot("/settings/instance");
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await user.type(name, " x{Escape}");
    expect(name.value).toBe("Northwind");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Nothing changed.")).toBeTruthy();
    expect(writes(api)).toHaveLength(0);
  });

  it("palette has Settings: <section> for owners only", () => {
    const ctx = { domains: [], open: () => {}, setCurrentDomain: () => {} };
    const owners = buildCommands(ctx, true).filter((c) => c.label.startsWith("Settings: ")).map((c) => c.label);
    expect(owners).toEqual(["This instance", "Sign-in", "Cloudflare", "Email", "Link defaults", "Data and retention", "Backups and export"].map((s) => `Settings: ${s}`));
    expect(buildCommands(ctx, false).some((c) => c.label.startsWith("Settings"))).toBe(false);
  });

  it("at phone width the subnav wraps instead of scrolling and inputs are 16 px", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 1080px)"));
    const subnav = /\.subnav\{([^}]*)\}/.exec(narrow)![1]!;
    expect(subnav).toContain("flex-wrap:wrap");
    expect(subnav).not.toContain("overflow-x");
    expect(narrow).toContain("grid-template-rows:max-content minmax(0,1fr)");
    expect(/\.sblock input,\.sblock select\{font-size:16px\}/.test(css)).toBe(true);
  });

  it("at phone width a switch has a 44 px tall touch target (26 px track plus a 9 px hit area above and below)", () => {
    const phone = css.slice(css.lastIndexOf("@media", css.indexOf(".sw{width:44px;height:26px}")));
    expect(phone).toContain(".sw{width:44px;height:26px}");
    expect(/\.sw::before\{[^}]*inset:-9px 0[^}]*\}/.test(phone)).toBe(true);
  });
});

describe("Settings: unsaved drafts and section keys (Task 11)", () => {
  const UNSAVED = "Unsaved changes: save with Ctrl+Enter or discard with Esc in the form first.";
  it("typing while a save is on its way keeps the new text; the saved value is adopted only where nothing changed", async () => {
    let release!: () => void;
    const { user } = boot("/settings/instance", {
      routes: { "PATCH /api/settings": ({ body }) => new Promise((r) => (release = () => r({ body: { ...SETTINGS, ...(body as object) } }))) },
    });
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "Acme{Control>}{Enter}{/Control}");
    await user.type(name, " Links");
    release();
    await screen.findByText("Saved.");
    expect(name.value).toBe("Acme Links");
  });

  it("a section switch (click or arrow) with an unsaved edit stays and says why; the edit is kept", async () => {
    const { user } = boot("/settings/instance");
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await user.type(name, " x");
    await user.click(screen.getByRole("link", { name: "Email" }));
    expect(location.pathname).toBe("/settings/instance");
    screen.getByRole("link", { name: "This instance" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(location.pathname).toBe("/settings/instance");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Northwind x");
    expect(screen.getAllByText(UNSAVED).length).toBeGreaterThan(0);
  });

  it("arrow keys switch sections without adding a history entry per step", async () => {
    const { user } = boot("/settings/instance");
    await screen.findByLabelText("Name");
    const before = history.length;
    screen.getByRole("link", { name: "This instance" }).focus();
    for (let i = 0; i < 3; i++) await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(location.pathname).toBe("/settings/email"));
    expect(history.length).toBe(before);
  });
});
