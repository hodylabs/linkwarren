import { render as rtl, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { Domain, Me } from "../api";
import { errorText } from "../copy";
import { fakeApi, type FakeRoutes } from "../test/fakeApi";
import { customRole, MEMBER_ROLE } from "../test/roles";
import { DEFAULT_STYLE, type QrItem } from "../../../src/qrcode";
import { render } from "./QrCodesScreen";

const member: Me = { id: "um", email: "m@example.com", name: "Mia", role: "member", ...MEMBER_ROLE };
const MAIN: Domain = {
  id: "d1", host: "go.test", type: "main", status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false,
};
const item = (o: Partial<QrItem>): QrItem => ({
  id: "q1", name: "Office", kind: "wifi", data: { ssid: "Office", security: "WPA", hidden: false }, style: DEFAULT_STYLE,
  hasPassword: true, createdBy: "um", createdAt: 1, updatedAt: 1, ...o,
});

function boot(me: Me, items: QrItem[], routes: FakeRoutes = {}) {
  history.replaceState(null, "", "/qr");
  const api = fakeApi({
    "GET /api/me": () => ({ body: me }),
    "GET /api/domains": () => ({ body: [MAIN] }),
    "GET /api/qr-codes": () => ({ body: { items } }),
    ...routes,
  });
  const user = userEvent.setup();
  rtl(<App />);
  return { api, user };
}
afterEach(() => vi.unstubAllGlobals());

describe("render", () => {
  it("encodes a link code exactly as the link's own QR (with the scan marker)", () => {
    const a = render("link", { linkId: "l1" }, "", { host: "go.test", slug: "menu" }, "M");
    const b = render("url", { url: "https://go.test/menu?lw=qr" }, "", undefined, "M");
    expect(a.m).toEqual(b.m);
    expect(render("link", { linkId: "l1" }, "", null, "M")).toEqual({ m: null, problem: "qr_link" });
  });
});

describe("QR codes screen", () => {
  it("shows the empty state in one line", async () => {
    boot(member, []);
    expect(await screen.findByText("Press New QR code to make one for Wi-Fi, a web address, a message or a short link.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /QR codes/ }).getAttribute("aria-current")).toBe("page");
  });

  it("lists name, kind and a preview, and marks a code whose link was deleted", async () => {
    boot(member, [item({}), item({ id: "q2", name: "Menu", kind: "link", data: { linkId: "gone" }, hasPassword: false, link: null })]);
    expect(await screen.findByRole("button", { name: "Office" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Wi-Fi" })).toBeTruthy();
    expect(screen.getByText("Link deleted")).toBeTruthy();
    expect(document.querySelectorAll(".qr-thumb")).toHaveLength(1);
  });

  it("is hidden from a role that cannot create links", async () => {
    boot({ ...member, ...customRole(["analytics.all"]) }, []);
    expect(await screen.findByText("Not in your role")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /QR codes/ })).toBeNull();
  });

  it("creates a Wi-Fi code: live preview as you type, masked password with a show toggle, the password sent once", async () => {
    const { api, user } = boot(member, [], {
      "POST /api/qr-codes": ({ body }) => ({ status: 201, body: item({ name: (body as { name: string }).name }) }),
    });
    await user.click(await screen.findByRole("button", { name: /New QR code/ }));
    await user.type(screen.getByLabelText(/Name/), "Office");
    expect(screen.getByText(errorText("wifi_ssid"))).toBeTruthy();
    await user.type(screen.getByLabelText("Network name"), "Office;1");
    expect(screen.getByRole("img", { name: "Preview of Office" })).toBeTruthy();
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pw.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw.type).toBe("text");
    await user.type(pw, "hunter22");
    await user.click(screen.getByRole("checkbox", { name: "Hidden network" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/qr-codes")).toBe(true));
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "Office", kind: "wifi", data: { ssid: "Office;1", security: "WPA", hidden: true }, style: DEFAULT_STYLE, password: "hunter22" });
    expect(await screen.findByRole("button", { name: "Office" })).toBeTruthy();
  });

  it("edits without resending an untouched password, and shows the server's SECRETS_KEY error", async () => {
    const { api, user } = boot(member, [item({})], {
      "GET /api/qr-codes/q1": () => ({ body: { ...item({}), password: "hunter22" } }),
      "PATCH /api/qr-codes/q1": ({ body }) => ((body as { password?: string }).password !== undefined
        ? { status: 409, body: { error: "secrets_key_missing" } } : { body: item({ name: "Front" }) }),
    });
    await user.click(await screen.findByRole("button", { name: "Office" }));
    const name = await screen.findByLabelText(/Name/);
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("hunter22");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    expect(await screen.findByText(errorText("secrets_key_missing"))).toBeTruthy();
    await user.clear(name);
    await user.type(name, "Front");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("an unreadable saved password blocks the preview and downloads until it is typed again", async () => {
    const { user } = boot(member, [item({})], { "GET /api/qr-codes/q1": () => ({ body: { ...item({}), password: null } }) });
    await user.click(await screen.findByRole("button", { name: "Office" }));
    expect(await screen.findByText(errorText("wifi_password_unreadable"))).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download SVG" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Password"), "hunter22");
    expect((screen.getByRole("button", { name: "Download SVG" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses inverted colors before saving", async () => {
    const { api, user } = boot(member, [], {});
    await user.click(await screen.findByRole("button", { name: /New QR code/ }));
    await user.click(screen.getByRole("radio", { name: "Text" }));
    await user.type(screen.getByLabelText(/^Text/), "Hello");
    const fg = screen.getByLabelText("Code color") as HTMLInputElement;
    // jsdom has no color picker: set the value the way the picker would.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(fg, "#ffffff");
    fg.dispatchEvent(new Event("input", { bubbles: true }));
    const bg = screen.getByLabelText("Background") as HTMLInputElement;
    setValue.call(bg, "#000000");
    bg.dispatchEvent(new Event("input", { bubbles: true }));
    expect(await screen.findByText(errorText("inverted_colors"))).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download SVG" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /^Create/ }));
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("deletes through the in-app confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { api, user } = boot(member, [item({})], {
      "GET /api/qr-codes/q1": () => ({ body: { ...item({}), password: "hunter22" } }),
      "DELETE /api/qr-codes/q1": () => ({ status: 204 }),
    });
    await user.click(await screen.findByRole("button", { name: "Office" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: /^Delete\s*Enter/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Press New QR code to make one for Wi-Fi, a web address, a message or a short link.")).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });
});
