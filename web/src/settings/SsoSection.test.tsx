import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Me, SsoSettings } from "../api";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { customRole, OWNER_ROLE } from "../test/roles";

const owner: Me = { id: "uo", email: "o@example.com", name: "Olive", role: "owner", ...OWNER_ROLE, authMode: "app" };
const SETTINGS = {
  name: "Northwind", mainDomainId: "d0", dashboardHost: "links.example.com", authMode: "app", emailFrom: "links@example.com", emailConfigured: true,
  secrets: { pasteAvailable: true, cf: "secret", resend: "secret" }, linkRedirectCode: 302, linkPassQuery: true, updatesCheck: true, retention: { auditDays: 1096, clickDetailDays: 90 },
};
const SSO: SsoSettings = {
  redirectUris: {
    google: "https://links.example.com/auth/sso/google/callback",
    github: "https://links.example.com/auth/sso/github/callback",
    oidc: "https://links.example.com/auth/sso/oidc/callback",
  },
  google: { enabled: false, clientId: "", secretSet: false },
  github: { enabled: true, clientId: "gh-id", secretSet: true },
  oidc: { enabled: false, issuer: "", clientId: "", label: "", secretSet: false },
  emailDomains: [{ domain: "example.com", joinRoleId: null, enforceSso: false }],
  secretsReady: true,
};
const ROLES = [
  { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
  { id: "member", name: "Member", perms: [], builtin: "member", people: 2 },
  { id: "hl", name: "Helper", perms: [], builtin: null, people: 0 },
];

function boot(o: { me?: Me; sso?: Partial<SsoSettings>; routes?: FakeRoutes } = {}) {
  history.replaceState(null, "", "/settings/sign-in");
  let sso: SsoSettings = { ...SSO, ...o.sso };
  const api = fakeApi({
    "GET /api/me": () => ({ body: o.me ?? owner }),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/settings": () => ({ body: SETTINGS }),
    "GET /api/account": () => ({ body: { passkeys: [], sessions: [] } }),
    "GET /api/roles": () => ({ body: ROLES }),
    "GET /api/settings/sso": () => ({ body: sso }),
    "PUT /api/settings/sso/google": ({ body }) => {
      const b = body as { clientId?: string; clientSecret?: string; enabled?: boolean };
      sso = { ...sso, google: { enabled: b.enabled ?? sso.google.enabled, clientId: b.clientId ?? sso.google.clientId, secretSet: b.clientSecret === undefined ? sso.google.secretSet : b.clientSecret !== "" } };
      return { body: sso };
    },
    "PUT /api/settings/sso/github": ({ body }) => {
      const b = body as { clientSecret?: string };
      sso = { ...sso, github: { ...sso.github, secretSet: b.clientSecret === undefined ? sso.github.secretSet : b.clientSecret !== "" } };
      return { body: sso };
    },
    "PUT /api/settings/email-domains/example.com": () => ({ body: { ok: true } }),
    "PUT /api/settings/email-domains/example.org": () => ({ body: { ok: true } }),
    "DELETE /api/settings/email-domains/example.com": () => ({ status: 204 }),
    ...o.routes,
  });
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET");
const card = async (name: string) => screen.findByRole("group", { name: new RegExp(`^${name}`) });
afterEach(() => vi.restoreAllMocks());

describe("Settings > Sign-in single sign-on (S14)", () => {
  it("shows the three providers, each with its exact redirect URI and a copy button", async () => {
    const { user } = boot();
    for (const p of ["google", "github", "oidc"] as const) expect(await screen.findByText(SSO.redirectUris[p])).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy the GitHub redirect URI" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SSO.redirectUris.github));
    const gh = await card("GitHub");
    expect(within(gh).getByText("Set")).toBeTruthy();
    expect(within(await card("Google")).getByText("Not set")).toBeTruthy();
  });

  it("saving only the client ID sends no clientSecret; Ctrl+Enter saves", async () => {
    const { api, user } = boot();
    const g = await card("Google");
    await user.type(within(g).getByLabelText("Client ID"), "abc.apps.example.com");
    await user.click(within(g).getByRole("switch", { name: "Turn on Google sign-in" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await within(g).findByText("Saved.");
    expect(writes(api)).toEqual([{ method: "PUT", path: "/api/settings/sso/google", body: { enabled: true, clientId: "abc.apps.example.com" } }]);
  });

  it("a pasted secret is sent once, cleared from the field and shows as set; the value never stays in the page", async () => {
    const { api, user } = boot();
    const g = await card("Google");
    const input = within(g).getByLabelText("Client secret") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    await user.type(input, "s3cret-value");
    await user.click(within(g).getByRole("button", { name: /Save/ }));
    await within(g).findByText("Set");
    expect(writes(api)).toEqual([{ method: "PUT", path: "/api/settings/sso/google", body: { clientSecret: "s3cret-value" } }]);
    expect(input.value).toBe("");
    expect(document.body.innerHTML).not.toContain("s3cret-value");
  });

  it("Remove asks, then clears the secret with an empty string", async () => {
    const { api, user } = boot();
    const gh = await card("GitHub");
    await user.click(within(gh).getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/GitHub sign-in stops working until a new secret is saved/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await within(gh).findByText("Not set");
    expect(writes(api)).toEqual([{ method: "PUT", path: "/api/settings/sso/github", body: { clientSecret: "" } }]);
  });

  it("Esc reverts an unsaved edit and nothing is sent", async () => {
    const { api, user } = boot();
    const g = await card("Google");
    const id = within(g).getByLabelText("Client ID") as HTMLInputElement;
    await user.type(id, "x");
    await user.keyboard("{Escape}");
    expect(id.value).toBe("");
    expect(writes(api)).toEqual([]);
  });

  it.each([
    ["bad_issuer", "Enter the issuer as an https address without a query or fragment, like https://login.example.com."],
    ["sso_discovery_failed", "Could not read the issuer's OpenID configuration. Check the issuer address and that it is reachable."],
    ["bad_client_id", "Enter the client ID exactly as the provider shows it."],
    ["secrets_key_missing", "Saving a client secret needs the SECRETS_KEY Worker secret. Set it, then paste the secret again."],
  ])("OIDC save refused with %s shows its text", async (c, text) => {
    const { api, user } = boot({ routes: { "PUT /api/settings/sso/oidc": () => ({ status: 400, body: { error: c } }) } });
    const o = await card("Single sign-on");
    await user.type(within(o).getByLabelText("Issuer"), "https://login.example.com");
    await user.type(within(o).getByLabelText("Button label"), "Northwind SSO");
    await user.click(within(o).getByRole("button", { name: /Save/ }));
    expect((await within(o).findByRole("alert")).textContent).toBe(text);
    expect(writes(api)[0]).toEqual({ method: "PUT", path: "/api/settings/sso/oidc", body: { issuer: "https://login.example.com", label: "Northwind SSO" } });
  });

  it("a settings role that is not an owner sees whether a secret is set, but has no secret field", async () => {
    boot({ me: { ...owner, ...customRole(["settings"]) }, routes: { "GET /api/roles": () => ({ status: 403, body: { error: "forbidden" } }) } });
    await card("Google");
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getAllByText("Only an owner can change the client secret.")).toHaveLength(3);
    const gh = await card("GitHub");
    expect(within(gh).getByText("Set")).toBeTruthy();
    expect(within(gh).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(await card("Google")).getByText("Not set")).toBeTruthy();
  });

  it("a settings role that is not an owner can change nothing: fields disabled, Ctrl Enter writes nothing", async () => {
    const { api, user } = boot({ me: { ...owner, ...customRole(["settings"]) }, routes: { "GET /api/roles": () => ({ status: 403, body: { error: "forbidden" } }) } });
    const g = await card("Google");
    expect(screen.getByText("Only an owner can change sign-in settings.")).toBeTruthy();
    expect((within(g).getByLabelText("Client ID") as HTMLInputElement).disabled).toBe(true);
    expect((within(g).getByRole("switch", { name: "Turn on Google sign-in" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(g).getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("New email domain") as HTMLInputElement).disabled).toBe(true);
    within(g).getByLabelText("Client ID").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(writes(api)).toEqual([]);
  });

  it("removing a secret keeps an unsaved client ID edit", async () => {
    const { user } = boot();
    const gh = await card("GitHub");
    const id = within(gh).getByLabelText("Client ID") as HTMLInputElement;
    await user.type(id, "-new");
    await user.click(within(gh).getByRole("button", { name: "Remove" }));
    await user.keyboard("{Enter}");
    await within(gh).findByText("Not set");
    expect(id.value).toBe("gh-id-new");
  });

  it("without SECRETS_KEY the secret field says what is needed", async () => {
    boot({ sso: { secretsReady: false } });
    await card("Google");
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getAllByText("Saving a client secret needs the SECRETS_KEY Worker secret.")).toHaveLength(3);
  });
});

describe("Settings > Sign-in email domains (S14)", () => {
  it("the auto-join role list never offers Owner", async () => {
    boot();
    const sel = (await screen.findByLabelText("Auto-join role for example.com")) as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].map((o) => o.text)).toEqual(["No auto-join", "Join as Member", "Join as Helper"]));
  });

  it("without the role list (403), Member is still offered and Owner is not", async () => {
    boot({ routes: { "GET /api/roles": () => ({ status: 403, body: { error: "forbidden" } }) } });
    const sel = (await screen.findByLabelText("Auto-join role for example.com")) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "member"]);
  });

  it("changing the role or enforce saves the row at once", async () => {
    const { api, user } = boot();
    const sel = await screen.findByLabelText("Auto-join role for example.com");
    await waitFor(() => expect(within(sel).getByText("Join as Helper")).toBeTruthy());
    await user.selectOptions(sel, "hl");
    await waitFor(() => expect(writes(api)).toHaveLength(1));
    await user.click(screen.getByRole("switch", { name: "Enforce single sign-on for example.com" }));
    await waitFor(() => expect(writes(api)).toHaveLength(2));
    expect(writes(api)).toEqual([
      { method: "PUT", path: "/api/settings/email-domains/example.com", body: { joinRoleId: "hl", enforceSso: false } },
      { method: "PUT", path: "/api/settings/email-domains/example.com", body: { joinRoleId: "hl", enforceSso: true } },
    ]);
    expect(await screen.findByText(/Single sign-on \(OIDC\) is not ready/)).toBeTruthy();
  });

  it("the lockout warning also shows when OIDC is on but has no secret", async () => {
    const oidc = { enabled: true, issuer: "https://login.example.com", clientId: "c", label: "", secretSet: false };
    const enforced = [{ domain: "example.com", joinRoleId: null, enforceSso: true }];
    boot({ sso: { oidc, emailDomains: enforced } });
    expect(await screen.findByText(/Single sign-on \(OIDC\) is not ready/)).toBeTruthy();
  });

  it("no lockout warning when OIDC is ready", async () => {
    boot({ sso: { oidc: { enabled: true, issuer: "https://login.example.com", clientId: "c", label: "", secretSet: true }, emailDomains: [{ domain: "example.com", joinRoleId: null, enforceSso: true }] } });
    await screen.findByLabelText("Auto-join role for example.com");
    expect(screen.queryByText(/is not ready/)).toBeNull();
  });

  it("adding a domain that is already listed is refused and the row is kept", async () => {
    const { api, user } = boot({ sso: { emailDomains: [{ domain: "example.com", joinRoleId: "member", enforceSso: true }] } });
    await user.type(await screen.findByLabelText("New email domain"), "Example.com{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("This domain is already listed. Change its role or enforcement in its row.");
    expect(writes(api)).toEqual([]);
  });

  it("Enter in the new domain field adds it, lowercased, with the picked role", async () => {
    const { api, user } = boot();
    const sel = await screen.findByLabelText("Auto-join role for the new domain");
    await waitFor(() => expect(within(sel).getByText("Join as Member")).toBeTruthy());
    await user.selectOptions(sel, "member");
    await user.type(screen.getByLabelText("New email domain"), "Example.ORG{Enter}");
    expect(await screen.findByText("example.org")).toBeTruthy();
    expect(writes(api)).toEqual([{ method: "PUT", path: "/api/settings/email-domains/example.org", body: { joinRoleId: "member", enforceSso: false } }]);
    expect((screen.getByLabelText("New email domain") as HTMLInputElement).value).toBe("");
  });

  it.each([
    ["owner_role", "Auto-join cannot give the owner role. Pick another role."],
    ["bad_domain", "Enter an email domain like example.com, without @ or a path."],
    ["bad_role", "That role no longer exists. Reload and pick another."],
    ["too_many", "You can list at most 50 email domains. Remove one first."],
  ])("an add refused with %s shows its text and keeps the field", async (c, text) => {
    const { user } = boot({ routes: { "PUT /api/settings/email-domains/example.org": () => ({ status: 400, body: { error: c } }) } });
    await user.type(await screen.findByLabelText("New email domain"), "example.org{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect((screen.getByLabelText("New email domain") as HTMLInputElement).value).toBe("example.org");
  });

  it("Remove asks first, then deletes the row", async () => {
    const { api, user } = boot();
    await user.click(await screen.findByRole("button", { name: "Remove example.com" }));
    expect(screen.getByText(/no longer join by themselves/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByLabelText("Auto-join role for example.com")).toBeNull());
    expect(writes(api)).toEqual([{ method: "DELETE", path: "/api/settings/email-domains/example.com", body: undefined }]);
  });
});

