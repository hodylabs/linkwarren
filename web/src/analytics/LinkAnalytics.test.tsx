import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { AnalyticsReport, DetailReport, Me } from "../api";
import { WeeklyEmail } from "../account/WeeklyEmail";
import { fakeApi } from "../test/fakeApi";
import { OWNER_ROLE } from "../test/roles";
import { Breakdowns } from "./Breakdowns";
import { busiest, BusyTimes, level } from "./BusyTimes";
import { toCsv } from "./csv";
import { safeDecode } from "./AnalyticsScreen";
import { navigate } from "../router";

const owner: Me = { id: "uo", email: "owner@example.com", name: "Olive", role: "owner", ...OWNER_ROLE };
const report = (o: Partial<AnalyticsReport> = {}): AnalyticsReport => ({
  from: "2026-10-22", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
  totals: { clicks: 7, qr: 2, typed: 5, bots: 0, visitors: null, prevClicks: null },
  series: [], links: [], domains: [], countries: [], devices: [], referrers: [], ...o,
});
const grid = () => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
const detail = (o: Partial<DetailReport> = {}): DetailReport => ({
  live: "ok", from: "2026-10-22", to: "2026-11-20", os: [], browsers: [], languages: [], places: [], hours: grid(), ...o,
});
const card = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;
const labels = (title: string) => [...card(title).querySelectorAll(".hb-l")].map((e) => e.textContent);
afterEach(() => vi.unstubAllGlobals());

describe("Breakdowns with detail", () => {
  it("devices read in plain words; detail cards name values; empty detail values read Not recorded", () => {
    render(<Breakdowns report={report({ devices: [{ value: "mobile", clicks: 5 }, { value: "desktop", clicks: 2 }] })} detail={detail({
      os: [{ value: "iOS", clicks: 4 }, { value: "", clicks: 1 }], languages: [{ value: "en-us", clicks: 3 }], places: [{ value: "Toronto, CA", clicks: 2 }],
    })} />);
    expect(labels("Languages")).toEqual(["American English"]); // Places, the first tab
    expect(labels("Cities and regions")).toEqual(["Toronto, CA"]);
    act(() => screen.getByRole("tab", { name: "Devices" }).click());
    expect(labels("Devices")).toEqual(["Phone", "Computer"]);
    expect(labels("Operating systems")).toEqual(["iOS", "Not recorded"]);
  });
  it("top links open their own page; a per-link page leaves out Top links and Domains", () => {
    const links = [{ linkId: "l 1", domainId: "d1", host: "go.example.com", slug: "s", clicks: 3 }];
    const { unmount } = render(<Breakdowns report={report({ links })} />);
    expect(within(card("Top links")).getByRole("link", { name: "go.example.com/s" }).getAttribute("href")).toBe("/analytics/link/l%201");
    unmount();
    render(<Breakdowns report={report({ links })} perLink />);
    expect(screen.queryByRole("heading", { name: "Top links" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Domains" })).toBeNull();
  });
  it("detail that failed says so in the cards", () => {
    render(<Breakdowns report={report()} detail={null} />);
    act(() => screen.getByRole("tab", { name: "Devices" }).click());
    expect(within(card("Browsers")).getByText("Not available for this range")).toBeTruthy();
  });
});

describe("BusyTimes", () => {
  it("every count is text in a table with row and column headers; the busiest slot is spelled out", () => {
    const hours = grid();
    hours[1]![14] = 9;
    hours[6]![0] = 2;
    render(<BusyTimes hours={hours} zone="Europe/Paris" />);
    expect(screen.getByText(/Busiest: Tuesday 14:00 to 15:00, 9 clicks\. Times are in Europe\/Paris\./)).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(24);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const tue = within(table).getAllByRole("row")[2]!;
    expect(within(tue).getAllByRole("cell")[14]!.textContent).toBe("9");
    expect(screen.getByRole("region", { name: /scrolls sideways/ }).tabIndex).toBe(0);
  });
  it("level and busiest", () => {
    expect([level(0, 9), level(1, 9), level(9, 9)]).toEqual([0, 1, 4]);
    expect(busiest(grid())).toBeNull();
  });
});

describe("toCsv with detail", () => {
  it("adds the detail sections, weekday names and safe cells", () => {
    const hours = grid();
    hours[0]![3] = 4;
    const csv = toCsv(report(), "day", detail({ os: [{ value: "=cmd", clicks: 1 }], places: [{ value: "", clicks: 2 }], hours }));
    expect(csv).toContain("os,clicks\n'=cmd,1");
    expect(csv).toContain("place,clicks\nnot recorded,2");
    expect(csv).toContain("weekday,hour,clicks\nMonday,0,0");
    expect(csv).toContain("Monday,3,4");
  });
});

describe("Per-link analytics page", () => {
  it("the URL names the link; it asks for that link only, with the viewer's zone for the detail, and has no domain filter", async () => {
    history.replaceState(null, "", "/analytics/link/lM?range=7");
    const api = fakeApi({
      "GET /api/me": () => ({ body: owner }),
      "GET /api/domains": () => ({ body: [] }),
      "GET /api/users": () => ({ body: { items: [] } }),
      "GET /api/analytics": () => ({ body: report({ link: { linkId: "lM", host: "go.example.com", slug: "spring" } }) }),
      "GET /api/analytics/detail": () => ({ body: detail() }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Link analytics" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("go.example.com/spring")).toBeTruthy());
    const paths = api.calls.map((c) => c.path);
    expect(paths).toContain("/api/analytics?range=7&link=lM");
    expect(paths.some((p) => /^\/api\/analytics\/detail\?range=7&link=lM&tz=.+/.test(p))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Search links" })).toBeNull();
    expect(within(screen.getByRole("toolbar", { name: "Filters" })).queryByRole("button", { name: /All domains/ })).toBeNull();
    expect(screen.getByText(/full detail for three months/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "All analytics" }).getAttribute("href")).toBe("/analytics");
  });
});

describe("Per-link page edge cases", () => {
  const routes = () => ({
    "GET /api/me": () => ({ body: owner }),
    "GET /api/domains": () => ({ body: [] }),
    "GET /api/users": () => ({ body: { items: [] } }),
    "GET /api/analytics": () => ({ body: report() }),
    "GET /api/analytics/detail": () => ({ body: detail() }),
  });
  it("a malformed id shows link not found, asks nothing, and the way back works", async () => {
    history.replaceState(null, "", "/analytics/link/%");
    const api = fakeApi(routes());
    render(<App />);
    expect(await screen.findByText(/That link was not found/)).toBeTruthy();
    expect(api.calls.filter((c) => c.path.startsWith("/api/analytics"))).toEqual([]);
    expect(safeDecode("%")).toBeNull();
    expect(safeDecode("a%20b")).toBe("a b");
    await userEvent.setup().click(screen.getByRole("link", { name: "All analytics" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analytics" })).toBeTruthy());
  });
  it("a picker open when the page turns into a link page is closed, so shortcuts and Escape are not held by a hidden picker", async () => {
    history.replaceState(null, "", "/analytics");
    fakeApi(routes());
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Clicks", { selector: ".tile2 small" });
    await user.keyboard("d");
    expect(screen.getByRole("listbox")).toBeTruthy();
    act(() => navigate("/analytics/link/lM"));
    await screen.findByRole("heading", { name: "Link analytics" });
    act(() => navigate("/analytics"));
    await screen.findByRole("heading", { name: "Analytics" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Per-link page and a pending search", () => {
  it("a search still waiting for its debounce is dropped when a link page opens", async () => {
    history.replaceState(null, "", "/analytics");
    fakeApi({
      "GET /api/me": () => ({ body: owner }),
      "GET /api/domains": () => ({ body: [] }),
      "GET /api/users": () => ({ body: { items: [] } }),
      "GET /api/analytics": () => ({ body: report() }),
      "GET /api/analytics/detail": () => ({ body: detail() }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Clicks", { selector: ".tile2 small" });
    await user.type(screen.getByRole("textbox", { name: "Search links" }), "spr");
    act(() => navigate("/analytics/link/lM"));
    await screen.findByRole("heading", { name: "Link analytics" });
    await act(() => new Promise((r) => setTimeout(r, 400))); // past the 250 ms debounce
    expect(location.search).not.toContain("q=");
    act(() => navigate("/analytics"));
    expect(((await screen.findByRole("textbox", { name: "Search links" })) as HTMLInputElement).value).toBe("");
  });
});

describe("WeeklyEmail", () => {
  it("turning it on sends this browser's zone", async () => {
    const api = fakeApi({ "PUT /api/account/digest": (r) => ({ body: { ...(r.body as object), emailReady: true } }) });
    render(<WeeklyEmail />);
    const sw = await screen.findByRole("switch", { name: "Weekly clicks summary" });
    await userEvent.setup().click(sw);
    const put = api.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ enabled: true, tz: expect.any(String) });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  });
  it("without email it is disabled and says why", async () => {
    fakeApi({ "GET /api/account/digest": () => ({ body: { enabled: false, tz: null, emailReady: false } }) });
    render(<WeeklyEmail />);
    const sw = await screen.findByRole("switch", { name: "Weekly clicks summary" });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Email is not set up on this instance/)).toBeTruthy();
  });
});
