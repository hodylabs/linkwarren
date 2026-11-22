import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AnalyticsReport, Domain, Me } from "../api";
import { fakeApi, type FakeReq, type FakeRes } from "../test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner" };
const dom = (id: string, host: string, type: Domain["type"]): Domain => ({
  id, host, type, status: "active", ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 3, isMember: false,
});
// Picker order is Main, Shared, Private: d1, d2, d3.
const domains = [dom("d3", "mine.example.com", "private"), dom("d2", "team.example.com", "shared"), dom("d1", "go.example.com", "main")];

const report = (clicks: number, o: Partial<AnalyticsReport> = {}): AnalyticsReport => ({
  from: "2026-10-22", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
  totals: { clicks, qr: 0, typed: clicks, bots: 0, visitors: null, prevClicks: null },
  series: [], links: [], domains: [], countries: [], devices: [], referrers: [], ...o,
});

function boot(path = "/analytics", answer: (req: FakeReq) => FakeRes | Promise<FakeRes> = () => ({ body: report(10) })) {
  history.replaceState(null, "", path);
  const api = fakeApi({
    "GET /api/me": () => ({ body: owner }),
    "GET /api/domains": () => ({ body: domains }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/analytics": answer,
  });
  const user = userEvent.setup();
  render(<App />);
  const reports = () => api.calls.filter((c) => c.path.startsWith("/api/analytics")).map((c) => c.path);
  return { api, user, reports };
}
const clicksTile = () => screen.getByText("Clicks", { selector: ".tile2 small" }).parentElement!.querySelector("b")!.textContent;
const ready = () => waitFor(() => expect(screen.getByText("Clicks", { selector: ".tile2 small" })).toBeTruthy());
const chip = () => screen.getByRole("button", { name: /All domains|example\.com|domains/, expanded: false });
afterEach(() => vi.unstubAllGlobals());

describe("Analytics screen", () => {
  it("first load asks for the default range without a range param and shows the tiles", async () => {
    const { reports } = boot();
    await ready();
    expect(reports()).toEqual(["/api/analytics"]);
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeTruthy();
    expect(screen.getByText("all domains you can see")).toBeTruthy();
    expect(screen.getByText("Bots and link previews are left out")).toBeTruthy();
  });

  it("clicking 7 days sends range=7 and keeps it in the URL", async () => {
    const { user, reports } = boot();
    await ready();
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics?range=7"));
    expect(location.search).toBe("?range=7");
  });

  it("ArrowRight on the range group moves to the next range and fetches it", async () => {
    const { user, reports } = boot("/analytics?range=7");
    await ready();
    screen.getByRole("radio", { name: "7 days" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "30 days" }));
    await waitFor(() => expect(reports()).toEqual(["/api/analytics?range=7", "/api/analytics"]));
  });

  it("D opens the domain picker; ArrowDown and Space pick the second domain; Esc closes back to the chip", async () => {
    const { user, reports } = boot();
    await ready();
    await user.keyboard("d");
    const find = screen.getByRole("combobox", { name: "Find a domain" });
    expect(document.activeElement).toBe(find);
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "go.example.comMain", "team.example.comShared", "mine.example.comPrivate",
    ]);
    await user.keyboard("{ArrowDown} ");
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics?domains=d2"));
    expect(within(list).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("on team.example.com")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /team\.example\.com/, expanded: false }));
  });

  it("a d typed into the search types d and opens nothing", async () => {
    const { user } = boot();
    await ready();
    await user.click(screen.getByRole("textbox", { name: "Search links" }));
    await user.keyboard("d");
    expect((screen.getByRole("textbox", { name: "Search links" }) as HTMLInputElement).value).toBe("d");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("L focuses the search; typing sends one request after the debounce; Esc leaves the box", async () => {
    const { user, reports } = boot();
    await ready();
    await user.keyboard("l");
    const box = screen.getByRole("textbox", { name: "Search links" });
    expect(document.activeElement).toBe(box);
    await user.keyboard("spring");
    await waitFor(() => expect(reports().filter((p) => p.includes("q="))).toEqual(["/api/analytics?q=spring"]));
    await new Promise((r) => setTimeout(r, 300));
    expect(reports().filter((p) => p.includes("q="))).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(box);
  });

  it("a range picked while a typed search waits keeps both", async () => {
    const { user, reports } = boot();
    await ready();
    await user.click(screen.getByRole("textbox", { name: "Search links" }));
    await user.keyboard("sp");
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics?range=7&q=sp"));
  });

  it("an older answer that lands after a newer one never replaces it (Review Focus 5)", async () => {
    let release7: (r: FakeRes) => void = () => undefined;
    const { user } = boot("/analytics", ({ url }) => {
      const r = url.searchParams.get("range");
      if (r === "7") return new Promise<FakeRes>((res) => (release7 = res));
      return { body: report(r === "90" ? 9000 : 30) };
    });
    await ready();
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await user.click(screen.getByRole("radio", { name: "90 days" }));
    await waitFor(() => expect(clicksTile()).toBe("9,000"));
    release7({ body: report(7) });
    await new Promise((r) => setTimeout(r, 20));
    expect(clicksTile()).toBe("9,000");
  });

  it("custom From after To shows the error and sends nothing", async () => {
    const { user, reports } = boot("/analytics?range=custom&from=2026-11-01&to=2026-11-10");
    await ready();
    const from = screen.getByLabelText("From") as HTMLInputElement;
    expect(from.type).toBe("date");
    expect(from.min).toBe("");
    expect(from.max).toBe(new Date().toISOString().slice(0, 10));
    const before = reports().length;
    fireEvent.change(from, { target: { value: "2026-11-20" } });
    expect(await screen.findByText("From must be on or before To")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(reports().length).toBe(before);
  });

  const exportBtn = () => screen.getByRole("button", { name: /Export CSV/ });
  const tilesShown = () => screen.queryByText("Clicks", { selector: ".tile2 small" }) !== null;

  it("an invalid range after a loaded report hides the numbers and disables Export; X does nothing", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { user } = boot("/analytics?range=custom&from=2026-11-01&to=2026-11-10");
    await ready();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-20" } });
    expect(await screen.findByText("From must be on or before To")).toBeTruthy();
    expect(tilesShown()).toBe(false);
    expect(exportBtn().hasAttribute("disabled")).toBe(true);
    await user.keyboard("x");
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("a failed request after a loaded report hides the numbers under the new filters", async () => {
    const { user } = boot("/analytics", ({ url }) => (url.searchParams.get("range") === "7" ? { status: 403, body: { error: "forbidden" } } : { body: report(10) }));
    await ready();
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(await screen.findByText("You do not have permission to do that.")).toBeTruthy();
    expect(tilesShown()).toBe(false);
    expect(exportBtn().hasAttribute("disabled")).toBe(true);
  });

  it("while newer filters load, the older numbers are dimmed and busy and cannot be exported", async () => {
    let release7: (r: FakeRes) => void = () => undefined;
    const { user } = boot("/analytics", ({ url }) =>
      url.searchParams.get("range") === "7" ? new Promise<FakeRes>((res) => (release7 = res)) : { body: report(30) });
    await ready();
    const data = () => document.querySelector(".an-data")!;
    expect(data().getAttribute("aria-busy")).toBe("false");
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(data().getAttribute("aria-busy")).toBe("true"));
    expect(data().classList.contains("stale")).toBe(true);
    expect(exportBtn().hasAttribute("disabled")).toBe(true);
    release7({ body: report(7) });
    await waitFor(() => expect(clicksTile()).toBe("7"));
    expect(data().getAttribute("aria-busy")).toBe("false");
    expect(exportBtn().hasAttribute("disabled")).toBe(false);
  });

  it.each([
    ["an impossible date", "from=2026-02-30&to=2026-03-02"],
    ["a future end", "from=2026-11-01&to=2999-01-01"],
    ["more than 366 days", "from=2024-01-01&to=2025-06-01"],
  ])("%s in the URL shows the range copy and sends nothing", async (_, dates) => {
    const { reports } = boot(`/analytics?range=custom&${dates}`);
    expect(await screen.findByText("Pick dates up to today, the start on or before the end, at most 366 days apart.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(reports()).toEqual([]);
  });

  it("a date still being typed (year under 1000) is not sent; leaving the field sends the finished date", async () => {
    const { reports } = boot("/analytics?range=custom&from=2026-11-01&to=2026-11-10");
    await ready();
    const from = screen.getByLabelText("From") as HTMLInputElement;
    from.focus();
    fireEvent.change(from, { target: { value: "0002-11-03" } });
    fireEvent.change(from, { target: { value: "0202-11-03" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(reports()).toEqual(["/api/analytics?range=custom&from=2026-11-01&to=2026-11-10"]);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(from, { target: { value: "2026-11-03" } });
    fireEvent.blur(from);
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics?range=custom&from=2026-11-03&to=2026-11-10"));
    expect(reports()).toHaveLength(2);
  });

  it("back or forward changes the custom date inputs with the URL", async () => {
    boot("/analytics?range=custom&from=2026-11-01&to=2026-11-10");
    await ready();
    act(() => {
      history.replaceState(null, "", "/analytics?range=custom&from=2026-11-03&to=2026-11-08");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-11-03"));
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-11-08");
  });

  it("the 24 hour view with live off explains why there are no clicks", async () => {
    boot("/analytics?range=1", () => ({ body: report(0, { unit: "hour", live: "off", series: [{ bucket: "2026-11-20T10:00:00Z", qr: 0, typed: 0 }] }) }));
    expect(await screen.findByText("Hourly clicks need live clicks, which are off on this instance. Pick 7 days or longer for daily totals.")).toBeTruthy();
  });

  it("Tab out of the domain picker closes it", async () => {
    const { user } = boot();
    await ready();
    await user.keyboard("d");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.tab(); // All domains, still inside
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("V with the chart focused moves focus to the view toggle", async () => {
    const series = [{ bucket: "2026-11-19", qr: 1, typed: 2 }];
    const { user } = boot("/analytics", () => ({ body: report(3, { series }) }));
    await ready();
    screen.getByRole("group", { name: /Clicks chart/ }).focus();
    await user.keyboard("v");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Chart view/ }));
  });

  it("the Link pill × clears the search, and Clear all clears everything", async () => {
    const { user, reports } = boot("/analytics?range=7&q=spring&domains=d1");
    await ready();
    expect(screen.getByText("spring", { selector: ".fpill b" })).toBeTruthy();
    expect(screen.getByText("go.example.com", { selector: ".fpill b" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear link search" }));
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics?range=7&domains=d1"));
    expect((screen.getByRole("textbox", { name: "Search links" }) as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics"));
    expect(location.search).toBe("");
  });

  it.each([
    ["unavailable", "Clicks from the last day or two could not be loaded. Try again shortly."],
    ["off", "Live clicks are not set up on this instance (Analytics Engine, see the deploy guide). Showing daily totals only."],
  ] as const)("live %s shows its note", async (live, text) => {
    boot("/analytics", () => ({ body: report(5, { live }) }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("truncated shows the 500 links note", async () => {
    boot("/analytics?q=a", () => ({ body: report(5, { truncated: true }) }));
    expect(await screen.findByText("Showing the first 500 matching links")).toBeTruthy();
  });

  it("an API error shows its text", async () => {
    boot("/analytics?domains=zz", () => ({ status: 403, body: { error: "forbidden" } }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("/analytics?pick=1 opens the picker and the URL loses pick", async () => {
    boot("/analytics?range=7&pick=1");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Find a domain" })));
    expect(location.search).toBe("?range=7");
  });

  it("the chip toggles the picker by mouse; a mousedown outside closes it; All domains clears the choice", async () => {
    const { user, reports } = boot("/analytics?domains=d1");
    await ready();
    await user.click(screen.getByRole("button", { name: /go\.example\.com/, expanded: false }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "All domains" }));
    await waitFor(() => expect(reports().at(-1)).toBe("/api/analytics"));
    await user.click(screen.getByRole("heading", { name: "Analytics" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chip()).toBeTruthy();
  });

  it("V switches the chart card to the table and back", async () => {
    const series = [{ bucket: "2026-11-19", qr: 1, typed: 2 }, { bucket: "2026-11-20", qr: 3, typed: 4 }];
    const { user } = boot("/analytics", () => ({ body: report(10, { series }) }));
    await ready();
    expect(screen.getByRole("img", { name: /Clicks over time/ })).toBeTruthy();
    await user.keyboard("v");
    const t = screen.getByRole("table");
    expect(within(t).getAllByRole("columnheader")).toHaveLength(4);
    expect(within(t).getAllByRole("row").slice(1).map((r) => r.lastElementChild!.textContent)).toEqual(["3", "7"]);
    expect(screen.getByRole("button", { name: /Chart view/ })).toBeTruthy();
    await user.keyboard("v");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("X exports the loaded report as a CSV through a Blob URL that is revoked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:test"));
    const revoke = vi.fn();
    const saved = { c: URL.createObjectURL, r: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const { user } = boot("/analytics", () => ({ body: report(10, { referrers: [{ value: "", clicks: 2 }] }) }));
    await ready();
    expect(screen.getByRole("button", { name: /Export CSV/ }).hasAttribute("disabled")).toBe(false);
    await user.keyboard("x");
    expect(names).toEqual(["linkwarren-analytics-2026-10-22-to-2026-11-20.csv"]);
    expect(await blobs[0]!.text()).toContain("referrer,clicks\ndirect,2");
    expect([...new Uint8Array(await blobs[0]!.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    click.mockRestore();
    URL.createObjectURL = saved.c;
    URL.revokeObjectURL = saved.r;
    vi.useRealTimers();
  });

  it("shows the breakdown cards under the chart", async () => {
    boot();
    await ready();
    for (const t of ["Top links", "Domains", "Countries", "Where clicks came from"]) expect(screen.getByRole("heading", { name: t })).toBeTruthy();
  });
});

