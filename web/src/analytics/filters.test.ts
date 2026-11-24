import { describe, expect, it } from "vitest";
import { filtersQuery, rangeProblem, readFilters, withFilter, type DimFilter, type Filters } from "./filters";

const TODAY = "2026-11-20";
const read = (s: string) => readFilters(new URLSearchParams(s), TODAY);

describe("readFilters", () => {
  it("defaults to 30 days, every domain, no search", () => {
    expect(read("")).toEqual({ range: "30", from: "", to: "", domains: [], q: "", f: [] });
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
  const base: Filters = { range: "30", from: "", to: "", domains: [], q: "", f: [] };

  it("omits defaults and empties", () => {
    expect(filtersQuery(base)).toBe("");
    expect(filtersQuery({ ...base, range: "7" })).toBe("range=7");
  });

  it("never sends from= or to= unless the range is custom", () => {
    expect(filtersQuery({ ...base, range: "90", from: "2026-10-01", to: "2026-10-31" })).toBe("range=90");
    expect(filtersQuery({ ...base, range: "custom", from: "2026-10-01", to: "2026-10-31" })).toBe("range=custom&from=2026-10-01&to=2026-10-31");
  });

  it("round trips", () => {
    const f: Filters = { range: "custom", from: "2026-10-01", to: "2026-10-31", domains: ["a1", "b2"], q: "spring sale", f: [] };
    expect(read(filtersQuery(f))).toEqual(f);
    expect(read(filtersQuery(base))).toEqual(base);
  });
});

describe("rangeProblem (mirrors the server's custom range check)", () => {
  it.each([
    ["2026-11-01", "2026-11-10", null],
    ["2026-11-10", "2026-11-01", "order"],
    ["2026-02-30", "2026-03-02", "bad_range"],
    ["2026-11-01", "2026-11-21", "bad_range"], // to after today
    ["2025-11-20", "2026-11-20", null], // 366 days counting both ends
    ["2025-11-19", "2026-11-20", "bad_range"], // 367
    ["0002-11-10", "2026-11-10", "bad_range"],
  ] as const)("%s to %s is %s", (from, to, want) => {
    expect(rangeProblem(from, to, TODAY)).toBe(want);
  });
});

describe("dimension filters (S13)", () => {
  it("reads repeated f, splitting on the first colon; an empty value is kept", () => {
    expect(read("f=country:FR&f=referrer:&f=place:Paris:Ile").f).toEqual([
      { dim: "country", value: "FR" }, { dim: "referrer", value: "" }, { dim: "place", value: "Paris:Ile" },
    ]);
  });

  it("drops unknown or repeated dimensions, no colon, values over 100 characters, and stops at six", () => {
    expect(read(`f=ip:1&f=country&f=country:FR&f=country:DE&f=os:${"x".repeat(101)}`).f).toEqual([{ dim: "country", value: "FR" }]);
    const seven = ["country", "place", "device", "os", "browser", "language", "source"].map((d) => `f=${d}:a`).join("&");
    expect(read(seven).f!.map((x) => x.dim)).toEqual(["country", "place", "device", "os", "browser", "language"]);
  });

  it("writes them as repeated f after the other params, and reads back the same", () => {
    const f: Filters = { range: "7", from: "", to: "", domains: ["d1"], q: "", f: [{ dim: "utm_source", value: "news letter" }, { dim: "print", value: "" }] };
    const s = filtersQuery(f);
    expect(s).toBe("range=7&domains=d1&f=utm_source%3Anews+letter&f=print%3A");
    expect(read(s)).toEqual(f);
  });

  it("withFilter replaces the same dimension and refuses a seventh", () => {
    const one: DimFilter[] = [{ dim: "country", value: "FR" }];
    expect(withFilter(one, "country", "DE")).toEqual([{ dim: "country", value: "DE" }]);
    const six = ["country", "place", "device", "os", "browser", "language"].map((dim) => ({ dim, value: "a" }) as DimFilter);
    expect(withFilter(six, "source", "qr")).toBeNull();
    expect(withFilter(six, "os", "b")).toHaveLength(6);
  });
});
