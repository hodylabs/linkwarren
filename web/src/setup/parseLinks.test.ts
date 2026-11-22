import { describe, expect, it } from "vitest";
import { linksFromCsv, NOT_AN_EXPORT, parseCsv, parseLinksFile } from "./parseLinks";

describe("parseCsv", () => {
  it("keeps a quoted comma and turns doubled quotes into one", () => {
    expect(parseCsv('slug,destination\nab,"https://x.test/?a=1,2"\ncd,"say ""hi"""\n')).toEqual([
      ["slug", "destination"], ["ab", "https://x.test/?a=1,2"], ["cd", 'say "hi"'],
    ]);
  });
  it("reads CRLF, drops a BOM and skips blank lines", () => {
    expect(parseCsv("﻿slug,url\r\nab,https://x.test\r\n\r\ncd,https://y.test")).toEqual([["slug", "url"], ["ab", "https://x.test"], ["cd", "https://y.test"]]);
  });
  it("keeps a line break inside quotes", () => {
    expect(parseCsv('a,b\n"x\ny",z')).toEqual([["a", "b"], ["x\ny", "z"]]);
  });
});

describe("linksFromCsv", () => {
  it("maps columns, url alias, empty host to the main domain and enabled words", () => {
    const { body, errors } = linksFromCsv(parseCsv("slug,url,host,enabled,start_date\nab,https://x.test,,no,2024-01-02 03:04:05\ncd,https://y.test,other.test,,\n"), "go.test");
    expect(errors).toEqual([]);
    expect(body).toEqual({
      mainHost: "go.test", domains: [],
      links: [
        { host: null, slug: "ab", destination: "https://x.test", enabled: false, startDate: "2024-01-02 03:04:05", endDate: null },
        { host: "other.test", slug: "cd", destination: "https://y.test", enabled: true, startDate: null, endDate: null },
      ],
    });
  });
  it("needs a destination column", () => {
    const { body, errors } = linksFromCsv(parseCsv("slug,host\nab,x.test"), "go.test");
    expect(body.links).toEqual([]);
    expect(errors[0]!.line).toBe(1);
  });
  it("reports a bad date and a bad enabled value by line", () => {
    const { body, errors } = linksFromCsv(parseCsv("slug,destination,enabled,end_date\nab,https://x.test,,2024-02-30 00:00:00\ncd,https://y.test,maybe,\nef,https://z.test,,"), "go.test");
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
    expect(errors[0]!.reason).toMatch(/end_date/);
    expect(body.links.map((l) => l.slug)).toEqual(["ef"]);
  });
});

describe("parseLinksFile", () => {
  const exp = { mainHost: "old.test", domains: [{ host: "a.test", customIndexUrl: null, customNotFoundUrl: null }], links: [{ host: null, slug: "ab", destination: "https://x.test", enabled: true, startDate: null, endDate: null }] };
  it("takes the import JSON as it is, keeping its own main host", () => {
    expect(parseLinksFile("export.JSON", JSON.stringify(exp), "go.test")).toEqual({ body: exp, errors: [] });
  });
  it("drops unknown fields from the JSON", () => {
    const withExtra = { ...exp, links: [{ ...exp.links[0], password: "x" }], extra: 1 };
    expect(parseLinksFile("e.json", JSON.stringify(withExtra), "go.test").body).toEqual(exp);
  });
  it("refuses other JSON with the export copy", () => {
    for (const t of ["[]", '{"links":[]}', "{not json", JSON.stringify({ ...exp, links: [{ slug: 1 }] })])
      expect(parseLinksFile("e.json", t, "go.test")).toEqual({ body: null, errors: [{ line: 0, reason: NOT_AN_EXPORT }] });
    expect(NOT_AN_EXPORT).toBe("This JSON is not a linkwarren or legacy export");
  });
  it("uses the instance main host for CSV and refuses other extensions", () => {
    expect(parseLinksFile("l.csv", "slug,destination\nab,https://x.test", "go.test").body?.mainHost).toBe("go.test");
    expect(parseLinksFile("l.txt", "", "go.test").body).toBeNull();
  });
});
