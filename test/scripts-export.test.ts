import { describe, expect, it } from "vitest";
import fixture from "./fixtures/66biolinks-export.json";
import { chunkLinks, excludedRows, filterHosts, parseExport, toCsv } from "../scripts/lib/export";
import { compareProbe, probeTargets } from "../scripts/lib/verify";

const exp = parseExport(fixture);

describe("parseExport", () => {
  it("accepts the fixture and normalizes hosts", () => {
    const e = parseExport({ ...fixture, mainHost: "Hody.Link.", domains: [{ host: "OTHER.example:443" }] });
    expect(e.mainHost).toBe("hody.link");
    expect(e.domains).toEqual([{ host: "other.example", customIndexUrl: null, customNotFoundUrl: null }]);
  });
  it("rejects malformed exports", () => {
    expect(() => parseExport(null)).toThrow();
    expect(() => parseExport({ ...fixture, mainHost: "" })).toThrow();
    expect(() => parseExport({ ...fixture, links: [{ slug: 1 }] })).toThrow();
    expect(() => parseExport({ ...fixture, links: "x" })).toThrow();
  });
});

describe("filterHosts", () => {
  it("keeps only listed hosts; null host counts as the main host", () => {
    const f = filterHosts(exp, ["hody.link"]);
    expect(f.domains.map((d) => d.host)).toEqual(["hody.link"]);
    expect(f.links.map((l) => l.slug)).toEqual(["Spring", "promo", "old", "app"]);
  });
  it("is case-insensitive on the list and requires a non-empty list", () => {
    expect(filterHosts(exp, ["OTHER.example."]).links.map((l) => l.slug)).toEqual(["x1", 'x2,"q"']);
    expect(() => filterHosts(exp, [])).toThrow(/hosts/);
    expect(() => filterHosts(exp, [" "])).toThrow(/hosts/);
  });
});

describe("chunkLinks", () => {
  it("never splits case twins across chunks and keeps every link", () => {
    const mk = (slug: string) => ({ host: "a.test", slug, destination: "https://e.org/", enabled: true, startDate: null, endDate: null });
    const e = { mainHost: "a.test", domains: [], links: ["b", "A", "c", "a", "d", "B"].map(mk) };
    const chunks = chunkLinks(e, 1);
    expect(chunks.map((c) => c.map((l) => l.slug))).toEqual([["A", "a"], ["b", "B"], ["c"], ["d"]]);
    expect(chunks.flat()).toHaveLength(6);
  });
});

describe("audit", () => {
  it("excludedRows is exactly the other.example rows", () => {
    const rows = excludedRows(exp, ["hody.link"]);
    expect(rows.map((r) => [r.host, r.slug])).toEqual([["other.example", "x1"], ["other.example", 'x2,"q"']]);
    expect(rows[1]).toMatchObject({ enabled: false, destination: "https://example.org/x2" });
  });
  it("toCsv quotes per RFC 4180", () => {
    const csv = toCsv([{ host: "h", slug: 'a,"b"\nc', n: 1, b: true, z: null }]);
    expect(csv).toBe('host,slug,n,b,z\r\nh,"a,""b""\nc",1,true,\r\n');
  });
  it("toCsv neutralises formula injection", () => {
    const csv = toCsv([{ a: "=1+1", b: "+x", c: "-x", d: "@x", e: "ok" }]);
    expect(csv).toBe("a,b,c,d,e\r\n'=1+1,'+x,'-x,'@x,ok\r\n");
  });
  it("toCsv of no rows is empty", () => expect(toCsv([])).toBe(""));
});

describe("verify", () => {
  it("probeTargets lists every link with its host (null -> main host)", () => {
    const t = probeTargets(exp);
    expect(t).toHaveLength(6);
    expect(t[0]).toEqual({ host: "hody.link", slug: "Spring", path: "/Spring" });
  });
  it("compareProbe matches on status and location", () => {
    const a = { status: 302, location: "https://x.com/" };
    expect(compareProbe(a, { ...a })).toBeNull();
    expect(compareProbe(a, { status: 301, location: "https://x.com/" })).toMatch(/status/);
    expect(compareProbe(a, { status: 302, location: "https://y.com/" })).toMatch(/location/);
    expect(compareProbe(a, { status: null, location: null, error: "ECONNRESET" })).toMatch(/ECONNRESET/);
    expect(compareProbe({ status: 404, location: null }, { status: 404, location: null })).toBeNull();
  });
});
