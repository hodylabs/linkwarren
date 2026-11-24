import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsReport, DetailReport } from "../api";
import { Breakdowns, filterText, printName } from "./Breakdowns";
import type { DimFilter } from "./filters";

const base: AnalyticsReport = {
  from: "2026-11-01", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
  totals: { clicks: 0, qr: 0, typed: 0, bots: 0, visitors: null, prevClicks: null },
  series: [], links: [], domains: [], countries: [], devices: [], referrers: [],
};
const detailOf = (o: Partial<DetailReport>): DetailReport => ({
  live: "ok", from: "2026-11-01", to: "2026-11-20", os: [], browsers: [], languages: [], places: [], hours: [], ...o,
});
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
    expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected"), t.tabIndex])).toEqual([["Places", "true", 0], ["Sources", "false", -1], ["Devices", "false", -1], ["Campaigns", "false", -1]]);
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
    expect(document.activeElement).toBe(tabs[3]);
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "QR prints" })).toBeTruthy();
    fireEvent.keyDown(tabs[3]!, { key: "ArrowRight" }); // wraps
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: "Home" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1); // the others are hidden
  });

  it("Top links shows a link's name when it has one, in the body face; the others keep host/slug in mono", () => {
    const links = [
      { linkId: "a", domainId: "d1", host: "go.example.com", slug: "a", clicks: 2, name: "Spring poster" },
      { linkId: "b", domainId: "d1", host: "go.example.com", slug: "b", clicks: 1 },
    ];
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 3 }, links }} />);
    expect(labels("Top links")).toEqual(["Spring poster", "go.example.com/b"]);
    const [named, plain] = [...card("Top links").querySelectorAll(".hb-l")];
    expect([named!.classList.contains("mono"), plain!.classList.contains("mono")]).toEqual([false, true]);
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

describe("Breakdowns as filters (S13)", () => {
  const ctl = (on: DimFilter[] = []) => ({ on, pick: vi.fn() });
  const btn = (name: string) => screen.getByRole("button", { name });

  it("a row of one value is a button that picks its filter; merged Unknown and Other are not buttons", () => {
    const c = ctl([{ dim: "country", value: "US" }]);
    const countries = [["US", 50], ["CA", 20], ["GB", 10], ["DE", 8], ["XX", 2], ["T1", 1], ["FR", 1]].map(([value, clicks]) => ({ value: value as string, clicks: clicks as number }));
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 92 }, countries }} filters={c} />);
    expect(btn("Filter by Country: United States").getAttribute("aria-pressed")).toBe("true");
    expect(btn("Filter by Country: Canada").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn("Filter by Country: Canada"));
    expect(c.pick).toHaveBeenCalledWith({ dim: "country", value: "CA" });
    expect(within(card("Countries")).getAllByRole("button")).toHaveLength(4); // Other is plain text
    expect(labels("Countries")).toContain("Other");
  });

  it("a merged label (two codes reading Unknown) is not a filter", () => {
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 5 }, countries: [{ value: "XX", clicks: 3 }, { value: "T1", clicks: 2 }] }} filters={ctl()} />);
    expect(labels("Countries")).toEqual(["Unknown"]);
    expect(within(card("Countries")).queryByRole("button")).toBeNull();
  });

  it("without filters the rows stay plain text", () => {
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 3 }, countries: [{ value: "US", clicks: 3 }] }} />);
    expect(within(card("Countries")).queryByRole("button")).toBeNull();
  });

  it("sources: QR filters source qr, Direct an empty referrer, a host its referrer; the rollup's (other) is not a filter", () => {
    const c = ctl();
    const referrers = [{ value: "", clicks: 3 }, { value: "a.example.com", clicks: 2 }, { value: "(other)", clicks: 1 }];
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 9, qr: 3 }, referrers, domains: [{ domainId: "d1", host: "go.example.com", clicks: 9 }] }} filters={c} />);
    tab("Sources");
    fireEvent.click(btn("Filter by Source: QR code (no referrer)"));
    fireEvent.click(btn("Filter by Referrer: Direct, typed or saved"));
    fireEvent.click(btn("Filter by Referrer: a.example.com"));
    fireEvent.click(btn("Filter by Source: Link opened"));
    fireEvent.click(btn("Filter by Domain: go.example.com"));
    expect(c.pick.mock.calls.map((x) => x[0])).toEqual([
      { dim: "source", value: "qr" }, { dim: "referrer", value: "" }, { dim: "referrer", value: "a.example.com" },
      { dim: "source", value: "typed" }, { dim: "domain", value: "d1" },
    ]);
    expect(labels("Where clicks came from")).toContain("Other sites");
    expect(screen.queryByRole("button", { name: /Other sites/ })).toBeNull();
  });

  it("detail columns filter by their raw value, Not recorded by the empty one", () => {
    const c = ctl();
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 5 } }} detail={detailOf({ os: [{ value: "", clicks: 2 }, { value: "iOS", clicks: 3 }] })} filters={c} />);
    tab("Devices");
    fireEvent.click(btn("Filter by Operating system: Not recorded"));
    expect(c.pick).toHaveBeenCalledWith({ dim: "os", value: "" });
  });

  it("Campaigns: prints by label, unlabelled with their code, plain QR as QR, no label; UTM tags, untagged reads Not tagged", () => {
    const c = ctl();
    const prints = [{ value: "", clicks: 5, label: null }, { value: "flyer1", clicks: 4, label: "Flyer" }, { value: "abc123", clicks: 2, label: null }];
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 11 } }} detail={detailOf({ prints, utmSources: [{ value: "newsletter", clicks: 3 }, { value: "", clicks: 8 }] })} filters={c} />);
    tab("Campaigns");
    expect(labels("QR prints")).toEqual(["QR, no label", "Flyer", "Unlabelled print (abc123)"]);
    expect(labels("UTM source")).toEqual(["Not tagged", "newsletter"]);
    expect(within(card("UTM medium")).getByText("No clicks match these filters")).toBeTruthy(); // the server sent none
    fireEvent.click(btn("Filter by Print: Flyer"));
    fireEvent.click(btn("Filter by Print: QR, no label"));
    fireEvent.click(btn("Filter by UTM source: newsletter"));
    expect(c.pick.mock.calls.map((x) => x[0])).toEqual([{ dim: "print", value: "flyer1" }, { dim: "print", value: "" }, { dim: "utm_source", value: "newsletter" }]);
  });

  it("plain QR scans from several links (one print row per link) add up to one row that still filters", () => {
    const c = ctl();
    const prints = [{ value: "", clicks: 2, label: null, linkId: "l1" }, { value: "", clicks: 3, label: null, linkId: "l2" }];
    render(<Breakdowns report={{ ...base, totals: { ...base.totals, clicks: 5 } }} detail={detailOf({ prints })} filters={c} />);
    tab("Campaigns");
    expect(labels("QR prints")).toEqual(["QR, no label"]);
    expect(values("QR prints")).toEqual(["5"]);
    fireEvent.click(btn("Filter by Print: QR, no label"));
    expect(c.pick).toHaveBeenCalledWith({ dim: "print", value: "" });
  });

  it("Campaigns while the detail loads or fails", () => {
    const { rerender } = render(<Breakdowns report={base} />);
    tab("Campaigns");
    expect(within(card("QR prints")).getByText("Loading")).toBeTruthy();
    rerender(<Breakdowns report={base} detail={null} />);
    expect(within(card("UTM campaign")).getByText("Not available for this range")).toBeTruthy();
  });
});

describe("filterText and printName", () => {
  it("name a filter in the words of its row", () => {
    expect(filterText({ dim: "country", value: "FR" })).toBe("France");
    expect(filterText({ dim: "device", value: "mobile" })).toBe("Phone");
    expect(filterText({ dim: "language", value: "en-us" })).toBe("American English");
    expect(filterText({ dim: "referrer", value: "" })).toBe("Direct, typed or saved");
    expect(filterText({ dim: "source", value: "qr" })).toBe("QR code scanned");
    expect(filterText({ dim: "domain", value: "d1" }, (id) => (id === "d1" ? "go.example.com" : id))).toBe("go.example.com");
    expect(filterText({ dim: "print", value: "flyer1" }, undefined, [{ value: "flyer1", clicks: 1, label: "Flyer" }])).toBe("Flyer");
    expect(filterText({ dim: "print", value: "abc123" })).toBe("Unlabelled print (abc123)");
    expect(filterText({ dim: "utm_campaign", value: "" })).toBe("Not tagged");
    expect(filterText({ dim: "browser", value: "" })).toBe("Not recorded");
    expect(filterText({ dim: "place", value: "Paris" })).toBe("Paris");
  });
  it("printName", () => {
    expect(printName("", null)).toBe("QR, no label");
    expect(printName("abc", "Card")).toBe("Card");
    expect(printName("abc", null)).toBe("Unlabelled print (abc)");
  });
});
