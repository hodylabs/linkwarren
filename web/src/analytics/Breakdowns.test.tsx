import { render, screen, within } from "@testing-library/react";
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
    expect(labels("Domains")).toEqual(["go.example.com"]);
  });

  it("server text renders as text, not markup", () => {
    render(<Breakdowns report={{ ...base, domains: [{ domainId: "d1", host: "<b>x</b>", clicks: 1 }] }} />);
    expect(labels("Domains")).toEqual(["<b>x</b>"]);
    expect(card("Domains").querySelector("b")).toBeNull();
  });

  it("an all-zero report shows the empty copy in all four cards", () => {
    render(<Breakdowns report={{ ...base, domains: [{ domainId: "d1", host: "go.example.com", clicks: 0 }] }} />);
    for (const t of ["Top links", "Domains", "Countries", "Where clicks came from"])
      expect(within(card(t)).getByText("No clicks match these filters")).toBeTruthy();
  });
});
