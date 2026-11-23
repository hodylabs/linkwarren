import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalyticsReport } from "../api";
import { Breakdowns } from "./Breakdowns";

const base: AnalyticsReport = {
  from: "2026-11-01", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
  totals: { clicks: 0, qr: 0, typed: 0, bots: 0, visitors: null, prevClicks: null },
  series: [], links: [], domains: [], countries: [], devices: [], referrers: [],
};
const card = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;
const labels = (title: string) => [...card(title).querySelectorAll(".hb-l")].map((e) => e.textContent);
const values = (title: string) => [...card(title).querySelectorAll(".hb-v")].map((e) => e.textContent);
// S12: the breakdown is one card with Places, Sources and Devices tabs; a column shows once its tab is picked.
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("Breakdowns", () => {
  it("countries: four names then Other", () => {
    const countries = [["US", 50], ["CA", 20], ["GB", 10], ["DE", 8], ["FR", 5], ["XX", 2]].map(([value, clicks]) => ({ value: value as string, clicks: clicks as number }));
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 95 }, countries }} />);
    expect(labels("Countries")).toEqual(["United States", "Canada", "United Kingdom", "Germany", "Other"]);
    expect(values("Countries")).toEqual(["50", "20", "10", "8", "7"]);
  });

  it("unknown country codes read Unknown", () => {
    render(<Breakdowns report={{ ...base, countries: [{ value: "XX", clicks: 3 }, { value: "T1", clicks: 2 }] }} />);
    expect(labels("Countries")).toEqual(["Unknown"]);
    expect(values("Countries")).toEqual(["5"]);
  });

  it("referrer card: QR, hosts (top 4, rest Other sites), then Direct", () => {
    const referrers = [["", 9], ["instagram.com", 8], ["a.com", 5], ["b.com", 4], ["c.com", 3], ["d.com", 2], ["e.com", 1]].map(([value, clicks]) => ({ value: value as string, clicks: clicks as number }));
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 40, qr: 8, typed: 32 }, referrers }} />);
    tab("Sources");
    expect(labels("Where clicks came from")).toEqual([
      "QR code (no referrer)", "instagram.com", "a.com", "b.com", "c.com", "Other sites", "Direct, typed or saved",
    ]);
    expect(values("Where clicks came from")).toEqual(["8", "8", "5", "4", "3", "3", "9"]);
  });

  it("top links show host/slug in mono, at most six; domains listed", () => {
    const links = Array.from({ length: 8 }, (_, i) => ({ linkId: `l${i}`, domainId: "d1", host: "go.example.com", slug: `s${i}`, clicks: 10 - i }));
    render(<Breakdowns report={{ ...base, links, domains: [{ domainId: "d1", host: "go.example.com", clicks: 52 }] }} />);
    expect(labels("Top links")).toEqual(["go.example.com/s0", "go.example.com/s1", "go.example.com/s2", "go.example.com/s3", "go.example.com/s4", "go.example.com/s5"]);
    expect(card("Top links").querySelector(".hb-l")!.classList.contains("mono")).toBe(true);
    tab("Sources");
    expect(labels("Domains")).toEqual(["go.example.com"]);
  });

  it("server text renders as text, not markup", () => {
    render(<Breakdowns report={{ ...base, domains: [{ domainId: "d1", host: "<b>x</b>", clicks: 1 }] }} />);
    tab("Sources");
    expect(labels("Domains")).toEqual(["<b>x</b>"]);
    expect(card("Domains").querySelector("b")).toBeNull();
  });

  it("an all-zero report shows the empty copy in all four cards", () => {
    render(<Breakdowns report={{ ...base, domains: [{ domainId: "d1", host: "go.example.com", clicks: 0 }] }} />);
    for (const t of ["Top links", "Countries"]) expect(within(card(t)).getByText("No clicks match these filters")).toBeTruthy();
    tab("Sources");
    for (const t of ["Domains", "Where clicks came from"]) expect(within(card(t)).getByText("No clicks match these filters")).toBeTruthy();
  });

  it("the tabs follow the ARIA tab pattern: one Tab stop, arrows, Home and End move and select, each panel is labelled by its tab", () => {
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 3 }, countries: [{ value: "US", clicks: 3 }] }} />);
    const tabs = within(screen.getByRole("tablist", { name: "Breakdown" })).getAllByRole("tab");
    expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected"), t.tabIndex])).toEqual([["Places", "true", 0], ["Sources", "false", -1], ["Devices", "false", -1]]);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByRole("heading", { name: "Countries" })).toBeTruthy();
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "Where clicks came from" })).toBeTruthy();
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "Devices" })).toBeTruthy();
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" }); // wraps
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "Home" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1); // the others are hidden
  });

  it("Top links shares are of all the report's clicks, not of the six shown", () => {
    const links = Array.from({ length: 7 }, (_, i) => ({ linkId: `l${i}`, domainId: "d1", host: "go.example.com", slug: `s${i}`, clicks: 1 }));
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 7 }, links }} />);
    expect([...card("Top links").querySelectorAll(".hb-n small")].map((e) => e.textContent)).toEqual(Array(6).fill("14%"));
  });

  it("Sources splits clicks into link opens and QR scans", () => {
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 10, qr: 4, typed: 6 } }} />);
    tab("Sources");
    expect(labels("QR scans or link opens")).toEqual(["Link opened", "QR code scanned"]);
    expect(values("QR scans or link opens")).toEqual(["6", "4"]);
  });
});
