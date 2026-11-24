import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeApi } from "../test/fakeApi";

const spies = vi.hoisted(() => ({ download: vi.fn(), qrMatrix: vi.fn(), announce: vi.fn() }));
vi.mock("./qr", async (orig) => {
  const real = await orig<typeof import("./qr")>();
  spies.qrMatrix.mockImplementation(real.qrMatrix);
  return { ...real, qrMatrix: spies.qrMatrix, download: spies.download };
});
vi.mock("../state", () => ({ useApp: () => ({ announce: spies.announce }) }));
import { SharePanel } from "./SharePanel";
import { QrPanel } from "./QrPanel";
import { LinkAlerts } from "../account/LinkAlerts";

beforeEach(() => {
  spies.download.mockClear();
  spies.qrMatrix.mockClear();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillRect: vi.fn(), fillStyle: "" })) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(["png"], { type: "image/png" }));
  };
});

const share = (id: string, createdAt = 1_700_000_000) => ({ id, scope: "link", scopeId: "l1", createdAt, createdBy: "u1" });
const URL1 = `https://links.example.com/share/${"A".repeat(43)}`;

describe("SharePanel", () => {
  it("lists active shares without any URL, makes one and shows its URL once, revokes", async () => {
    const api = fakeApi({
      "GET /api/shares": () => ({ body: { items: [share("s1")] } }),
      "POST /api/shares": (r) => ({ status: 201, body: { ...share("s2", 1_700_100_000), url: URL1, ...(r.body as object) } }),
      "DELETE /api/shares/s1": () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    render(<SharePanel scope="link" id="l1" />);
    const list = await screen.findByRole("list", { name: "Active share pages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(api.calls[0]!.path).toBe("/api/shares?link=l1");
    await user.click(screen.getByRole("button", { name: /New share link/ }));
    expect(((await screen.findByRole("textbox", { name: "Share page URL" })) as HTMLInputElement).value).toBe(URL1);
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ scope: "link", id: "l1" });
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: /Turn off the share page/ })[1]!);
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/shares/s1")).toBe(true);
  });

  it("asks for a domain's shares by domain, and shows the limit error", async () => {
    const api = fakeApi({ "POST /api/shares": () => ({ status: 409, body: { error: "share_limit" } }) });
    render(<SharePanel scope="domain" id="d1" />);
    await screen.findByText(/A read-only page of click totals/);
    expect(api.calls[0]!.path).toBe("/api/shares?domain=d1");
    await userEvent.setup().click(screen.getByRole("button", { name: /New share link/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("10 share pages");
  });
});

describe("LinkAlerts", () => {
  it("off shows one switch; turning on sends both kinds; each kind has its own switch", async () => {
    const api = fakeApi({ "PUT /api/account/alerts": (r) => ({ body: { ...(r.body as object), emailReady: true } }) });
    const user = userEvent.setup();
    render(<LinkAlerts />);
    const sw = await screen.findByRole("switch", { name: "Link alert emails" });
    expect(screen.queryByRole("switch", { name: "Spike alerts" })).toBeNull();
    await user.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(api.calls.find((c) => c.method === "PUT")!.body).toEqual({ enabled: true, quiet: true, spike: true });
    await user.click(screen.getByRole("switch", { name: "Spike alerts" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(api.calls.filter((c) => c.method === "PUT")[1]!.body).toEqual({ enabled: true, quiet: true, spike: false });
  });
  it("without email it is disabled and says why", async () => {
    fakeApi({ "GET /api/account/alerts": () => ({ body: { enabled: false, quiet: true, spike: true, emailReady: false } }) });
    render(<LinkAlerts />);
    expect(((await screen.findByRole("switch", { name: "Link alert emails" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Email is not set up on this instance/)).toBeTruthy();
  });
  it("without live analytics reads it is disabled and says why", async () => {
    fakeApi({ "GET /api/account/alerts": () => ({ body: { enabled: false, quiet: true, spike: true, emailReady: true, analyticsReady: false } }) });
    render(<LinkAlerts />);
    expect(((await screen.findByRole("switch", { name: "Link alert emails" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Live analytics reads are not set up/)).toBeTruthy();
  });
});

describe("QrPanel labelled prints", () => {
  const label = (id: string, code: string, text: string) => ({ id, code, label: text, createdAt: 1 });
  it("are not asked for without the right to edit the link", async () => {
    const api = fakeApi({});
    render(<QrPanel host="go.test" slug="spring" linkId="l1" canEdit={false} />);
    expect(screen.queryByRole("region", { name: "Labelled prints" })).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("list, add, rename and delete; each downloads its own labelled code", async () => {
    const api = fakeApi({
      "GET /api/links/l1/qr-labels": () => ({ body: { items: [label("q1", "abc123", "Flyer")] } }),
      "POST /api/links/l1/qr-labels": (r) => ({ status: 201, body: label("q2", "zz9x0a", (r.body as { label: string }).label) }),
      "PATCH /api/links/l1/qr-labels/q1": (r) => ({ body: label("q1", "abc123", (r.body as { label: string }).label) }),
      "DELETE /api/links/l1/qr-labels/q2": () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    render(<QrPanel host="go.test" slug="spring" linkId="l1" canEdit />);
    await screen.findByText("Flyer");
    await user.click(screen.getByRole("button", { name: "Download SVG for Flyer" }));
    expect(spies.qrMatrix).toHaveBeenLastCalledWith("https://go.test/spring?lw=qr.abc123");
    expect(spies.download).toHaveBeenLastCalledWith("go.test-spring-Flyer.svg", expect.any(Blob));
    await user.click(screen.getByRole("button", { name: "Download PNG for Flyer" }));
    await waitFor(() => expect(spies.download).toHaveBeenLastCalledWith("go.test-spring-Flyer.png", expect.any(Blob)));

    await user.type(screen.getByRole("textbox", { name: "New print label" }), "Business card{Enter}");
    await screen.findByText("Business card");
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ label: "Business card" });

    await user.click(screen.getByRole("button", { name: "Rename Flyer" }));
    const box = screen.getByRole("textbox", { name: "New name for Flyer" });
    await user.clear(box);
    await user.type(box, "Poster{Enter}");
    await screen.findByText("Poster");
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ label: "Poster" });

    await user.click(screen.getByRole("button", { name: "Delete Business card" }));
    await waitFor(() => expect(screen.queryByText("Business card")).toBeNull());
    // The plain code is unchanged: old prints keep counting as "QR, no label".
    await user.click(screen.getByRole("button", { name: /^Download SVG$/ }));
    expect(spies.qrMatrix).toHaveBeenLastCalledWith("https://go.test/spring?lw=qr");
  });

  it("Escape cancels a rename without saving", async () => {
    const api = fakeApi({ "GET /api/links/l1/qr-labels": () => ({ body: { items: [label("q1", "abc123", "Flyer")] } }) });
    const user = userEvent.setup();
    render(<QrPanel host="go.test" slug="spring" linkId="l1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Rename Flyer" }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("Flyer")).toBeTruthy();
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
