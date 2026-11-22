import { describe, expect, it } from "vitest";
import { filtersQuery, readFilters, type Filters } from "./filters";

const TODAY = "2026-11-20";
const read = (s: string) => readFilters(new URLSearchParams(s), TODAY);

describe("readFilters", () => {
  it("defaults to 30 days, every domain, no search", () => {
    expect(read("")).toEqual({ range: "30", from: "", to: "", domains: [], q: "" });
  });

  it("an unknown range falls back to 30 days", () => {
    expect(read("range=12").range).toBe("30");
  });

  it("custom without dates fills today - 13 to today", () => {
    expect(read("range=custom")).toMatchObject({ range: "custom", from: "2026-11-07", to: TODAY });
  });

  it("custom with dates keeps them; dates without custom are ignored", () => {
    expect(read("range=custom&from=2026-10-01&to=2026-10-31")).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(read("range=7&from=2026-10-01&to=2026-10-31")).toMatchObject({ range: "7", from: "", to: "" });
  });

  it("reads a comma list of domain ids and the search", () => {
    expect(read("domains=a1,b2&q=spring")).toMatchObject({ domains: ["a1", "b2"], q: "spring" });
  });
});

describe("filtersQuery", () => {
  const base: Filters = { range: "30", from: "", to: "", domains: [], q: "" };

  it("omits defaults and empties", () => {
    expect(filtersQuery(base)).toBe("");
    expect(filtersQuery({ ...base, range: "7" })).toBe("range=7");
  });

  it("never sends from= or to= unless the range is custom", () => {
    expect(filtersQuery({ ...base, range: "90", from: "2026-10-01", to: "2026-10-31" })).toBe("range=90");
    expect(filtersQuery({ ...base, range: "custom", from: "2026-10-01", to: "2026-10-31" })).toBe("range=custom&from=2026-10-01&to=2026-10-31");
  });

  it("round trips", () => {
    const f: Filters = { range: "custom", from: "2026-10-01", to: "2026-10-31", domains: ["a1", "b2"], q: "spring sale" };
    expect(read(filtersQuery(f))).toEqual(f);
    expect(read(filtersQuery(base))).toEqual(base);
  });
});
