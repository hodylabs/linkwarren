import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentClick, RecentReport } from "../api";
import { fakeApi, type FakeRes } from "../test/fakeApi";
import { ago, POLL_MS, RecentClicks } from "./RecentClicks";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const click = (o: Partial<RecentClick> = {}): RecentClick => ({
  at: "2026-11-20T11:55:00Z", linkId: "l1", host: "go.example.com", slug: "spring", country: "FR", place: "Paris", device: "mobile",
  os: "iOS", browser: "Safari", language: "fr", source: "typed", print: "", printLabel: null, referrer: "",
  utmSource: "", utmMedium: "", utmCampaign: "", ...o,
});
let vis: DocumentVisibilityState = "visible";
const setVisible = (v: DocumentVisibilityState) => {
  vis = v;
  document.dispatchEvent(new Event("visibilitychange"));
};
// Lets the fake fetch answer and React render, without moving the clock.
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const recent = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/analytics/recent")).map((c) => c.path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  vis = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function boot(answer: () => FakeRes | Promise<FakeRes>, query = "range=7&f=country%3AFR", perLink = false) {
  const api = fakeApi({ "GET /api/analytics/recent": answer });
  const view = render(<RecentClicks query={query} perLink={perLink} />);
  return { api, view };
}

describe("RecentClicks", () => {
  it("shows each click: when (absolute on hover), link, place, device, source and referrer; sends the page's filters", async () => {
    const items = [
      click(),
      click({ at: "2026-11-20T09:00:00Z", source: "qr", print: "flyer1", printLabel: "Flyer", referrer: "a.example.com", country: "US", place: "", device: "desktop", os: "", browser: "Firefox" }),
      click({ at: "2026-11-20T11:59:40Z", source: "qr", print: "" }),
      click({ source: "qr", print: "abc123", country: "", place: "" }),
    ];
    const { api } = boot(() => ({ body: { items, live: "ok" } satisfies RecentReport }));
    await flush();
    expect(recent(api.calls)).toEqual(["/api/analytics/recent?range=7&f=country%3AFR"]);
    const card = screen.getByRole("heading", { name: "Recent clicks" }).closest("section")!;
    const rows = within(card).getAllByRole("row").slice(1).map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["5 min ago", "go.example.com/spring", "Paris, France", "Phone · iOS · Safari", "Link opened", "Direct"],
      ["3 h ago", "go.example.com/spring", "United States", "Computer · Firefox", "Flyer", "a.example.com"],
      ["just now", "go.example.com/spring", "Paris, France", "Phone · iOS · Safari", "QR, no label", "Direct"],
      ["5 min ago", "go.example.com/spring", "Unknown", "Phone · iOS · Safari", "Unlabelled print (abc123)", "Direct"],
    ]);
    const time = card.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe("2026-11-20T11:55:00Z");
    expect(time.getAttribute("title")).toBe(new Date("2026-11-20T11:55:00Z").toLocaleString());
  });

  it("a per-link page has no link column", async () => {
    boot(() => ({ body: { items: [click()], live: "ok" } }), "link=l1", true);
    await flush();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Place", "Device", "Source", "Referrer"]);
  });

  it("no clicks, live off and a failed request each say so", async () => {
    const answers: FakeRes[] = [{ body: { items: [], live: "ok" } }, { body: { items: [], live: "off" } }, { status: 500, body: { error: "internal" } }];
    boot(() => answers.shift()!);
    expect(screen.getByText("Loading")).toBeTruthy();
    await flush();
    expect(screen.getByText("No clicks in the last 24 hours match these filters")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.getByText("Recent clicks need live clicks, which are off on this instance.")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.getByText("Recent clicks could not be loaded. Trying again shortly.")).toBeTruthy();
  });

  it("refreshes every minute while visible, stops while hidden, and loads at once when visible again", async () => {
    const { api } = boot(() => ({ body: { items: [], live: "ok" } }));
    await flush();
    expect(recent(api.calls)).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(recent(api.calls)).toHaveLength(2);
    act(() => setVisible("hidden"));
    await act(() => vi.advanceTimersByTimeAsync(5 * POLL_MS));
    expect(recent(api.calls)).toHaveLength(2);
    act(() => setVisible("visible"));
    await flush();
    expect(recent(api.calls)).toHaveLength(3);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(recent(api.calls)).toHaveLength(4);
  });

  it("a page hidden while a request is out schedules nothing when it lands", async () => {
    let answer!: (r: FakeRes) => void;
    const { api } = boot(() => new Promise<FakeRes>((r) => (answer = r)));
    await flush();
    act(() => setVisible("hidden"));
    answer({ body: { items: [], live: "ok" } });
    await act(() => vi.advanceTimersByTimeAsync(3 * POLL_MS));
    expect(recent(api.calls)).toHaveLength(1);
  });

  it("never overlaps: a slow answer holds the next poll, and a visible event while it is out sends nothing", async () => {
    let answer!: (r: FakeRes) => void;
    const { api } = boot(() => new Promise<FakeRes>((r) => (answer = r)));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(3 * POLL_MS));
    act(() => setVisible("visible"));
    await flush();
    expect(recent(api.calls)).toHaveLength(1);
    answer({ body: { items: [], live: "ok" } });
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(recent(api.calls)).toHaveLength(2);
  });

  it("new filters start over with the new query and stop the old polling", async () => {
    const { api, view } = boot(() => ({ body: { items: [], live: "ok" } }), "f=os%3AiOS");
    await flush();
    view.rerender(<RecentClicks query="f=os%3AAndroid" />);
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(recent(api.calls)).toEqual(["/api/analytics/recent?f=os%3AiOS", "/api/analytics/recent?f=os%3AAndroid", "/api/analytics/recent?f=os%3AAndroid"]);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(3 * POLL_MS));
    expect(recent(api.calls)).toHaveLength(3);
  });
});

describe("ago", () => {
  it("reads just now, minutes, then hours", () => {
    expect(ago("2026-11-20T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-11-20T11:01:00Z", NOW)).toBe("59 min ago");
    expect(ago("2026-11-20T10:00:00Z", NOW)).toBe("2 h ago");
  });
});
