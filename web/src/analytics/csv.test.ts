import { describe, expect, it } from "vitest";
import type { AnalyticsReport } from "../api";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it("prefixes formula starters with a quote", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"'); // guarded, then quoted for the CR
  });
  it("quotes commas, quotes and newlines; numbers stay plain", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(12)).toBe("12");
    expect(csvCell("plain")).toBe("plain");
  });
});

describe("toCsv", () => {
  const r: AnalyticsReport = {
    from: "2026-11-19", to: "2026-11-20", unit: "day", live: "ok", truncated: false,
    totals: { clicks: 9, qr: 4, typed: 5, bots: 0, visitors: null, prevClicks: null },
    series: [{ bucket: "2026-11-19", qr: 1, typed: 2 }, { bucket: "2026-11-20", qr: 3, typed: 3 }],
    links: [{ linkId: "l1", domainId: "d1", host: "go.example.com", slug: "-spring", clicks: 9 }],
    domains: [{ domainId: "d1", host: "go.example.com", clicks: 9 }],
    countries: [{ value: "US", clicks: 9 }],
    devices: [{ value: "mobile", clicks: 9 }],
    referrers: [{ value: "", clicks: 3 }, { value: "instagram.com", clicks: 2 }],
  };
  it("writes the six sections in order with exact headers", () => {
    expect(toCsv(r, "day")).toBe(
      [
        "day,from_qr,typed_or_clicked,total", "2026-11-19,1,2,3", "2026-11-20,3,3,6", "",
        "link,clicks", "go.example.com/-spring,9", "",
        "domain,clicks", "go.example.com,9", "",
        "country,clicks", "US,9", "",
        "device,clicks", "mobile,9", "",
        "referrer,clicks", "direct,3", "instagram.com,2",
      ].join("\n") + "\n",
    );
  });
  it("uses an hour header for hourly reports", () => {
    expect(toCsv({ ...r, unit: "hour" }, "hour").split("\n")[0]).toBe("hour,from_qr,typed_or_clicked,total");
  });
});
