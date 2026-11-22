import { describe, expect, it } from "vitest";
import fixture from "./fixtures/sample-export.json";
import { chunkLinks, filterHosts, importRequests, parseExport, passwordsUnknown } from "../src/importFormat";

const exp = parseExport(fixture);

describe("parseExport", () => {
  it("accepts the fixture and normalizes hosts", () => {
    const e = parseExport({ ...fixture, mainHost: "Main.Example.", domains: [{ host: "OTHER.example:443" }] });
    expect(e.mainHost).toBe("main.example");
    expect(e.domains).toEqual([{ host: "other.example", customIndexUrl: null, customNotFoundUrl: null }]);
  });
  it("keeps protected: true and refuses a non-boolean protected", () => {
    const l = { host: null, slug: "s", destination: "https://e.org/", enabled: true };
    expect(parseExport({ ...fixture, links: [{ ...l, protected: true }, { ...l, protected: false }, l] }).links.map((x) => x.protected)).toEqual([true, false, undefined]);
    expect(() => parseExport({ ...fixture, links: [{ ...l, protected: "1" }] })).toThrow();
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
    const f = filterHosts(exp, ["main.example"]);
    expect(f.domains.map((d) => d.host)).toEqual(["main.example"]);
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
    expect(chunks.map((c) => c.map((l) => l.slug))).toEqual([["A", "a", "b", "B"], ["c"], ["d"]]);
    expect(chunks.flat()).toHaveLength(6);
  });
});

describe("chunkLinks twins first", () => {
  const mk = (host: string, slug: string) => ({ host, slug, destination: "https://e.org/", enabled: true, startDate: null, endDate: null });
  it("puts a host's twin groups in its first chunk even when they sort last", () => {
    const links = [...["a", "b", "c", "d", "e"].map((s) => mk("t.test", s)), mk("t.test", "zz"), mk("t.test", "ZZ")];
    const chunks = chunkLinks({ mainHost: "t.test", domains: [], links }, 2);
    expect(chunks[0]!.map((l) => l.slug).sort()).toEqual(["ZZ", "zz"]);
    expect(chunks.flat()).toHaveLength(7);
  });
  it("throws when twins exceed the server cap", () => {
    const links = Array.from({ length: 6 }, (_, i) => mk("t.test", i % 2 ? `a${i >> 1}` : `A${i >> 1}`));
    expect(() => chunkLinks({ mainHost: "t.test", domains: [], links }, 2, 4)).toThrow(/case-twin/);
  });
});

describe("chunkLinks duplicates", () => {
  const mk = (host: string | null, slug: string) => ({ host, slug, destination: "https://e.org/", enabled: true, startDate: null, endDate: null });
  it("collapses exact duplicate rows before chunking, so a duplicate pair never straddles a chunk boundary", () => {
    // 499 distinct slugs sort before the identical pair, which would otherwise land at indexes 499 and 500.
    const links = [...Array.from({ length: 499 }, (_, i) => mk("t.test", `s${String(i).padStart(3, "0")}`)), mk("t.test", "zz"), mk(null, "zz")];
    const chunks = chunkLinks({ mainHost: "t.test", domains: [], links }, 500);
    expect(chunks.map((c) => c.length)).toEqual([500]);
    expect(chunks.flat().filter((l) => l.slug === "zz")).toHaveLength(1);
  });
  it("keeps rows that differ in any field", () => {
    const links = [mk("t.test", "a"), { ...mk("t.test", "a"), enabled: false }, { ...mk("t.test", "a"), endDate: "2026-01-01 00:00:00" }];
    expect(chunkLinks({ mainHost: "t.test", domains: [], links }, 500).flat()).toHaveLength(3);
  });
});

describe("importRequests", () => {
  const mk = (host: string | null, slug: string) => ({ host, slug, destination: "https://e.org/", enabled: true, startDate: null, endDate: null });
  const D = (host: string) => ({ host, customIndexUrl: null, customNotFoundUrl: null });
  it("each request carries only its links' domains; link-less domains go in one final domains-only request", () => {
    const e = { mainHost: "m.test", domains: [D("m.test"), D("a.test"), D("b.test"), D("empty.test"), D("none.test")],
      links: [mk(null, "x"), mk("a.test", "a1"), mk("a.test", "a2"), mk("b.test", "Zz"), mk("b.test", "zz"), mk("b.test", "b1")] };
    const reqs = importRequests(e, 2);
    expect(reqs.every((r) => r.mainHost === "m.test")).toBe(true);
    for (const r of reqs.slice(0, -1)) {
      const hosts = new Set(r.links.map((l) => l.host ?? "m.test"));
      expect(r.domains.map((d) => d.host).sort()).toEqual([...hosts].sort());
    }
    expect(reqs.at(-1)).toEqual({ mainHost: "m.test", domains: [D("empty.test"), D("none.test")], links: [] });
    expect(reqs.flatMap((r) => r.links)).toHaveLength(6);
    // b.test's domain arrives with its twins, so the server creates it case-sensitive.
    const firstB = reqs.find((r) => r.domains.some((d) => d.host === "b.test"))!;
    expect(firstB.links.map((l) => l.slug)).toEqual(expect.arrayContaining(["Zz", "zz"]));
  });
  it("no domains-only request when every domain has links", () => {
    const reqs = importRequests({ mainHost: "m.test", domains: [D("m.test")], links: [mk(null, "x")] }, 10);
    expect(reqs).toEqual([{ mainHost: "m.test", domains: [D("m.test")], links: [mk(null, "x")] }]);
  });
});

describe("passwordsUnknown (N2)", () => {
  const l = { host: null, slug: "a", destination: "https://e.org/", enabled: true };
  it("true only when there are links and none says whether it had a password", () => {
    expect(passwordsUnknown(parseExport({ mainHost: "m.test", domains: [], links: [l] }))).toBe(true);
    expect(passwordsUnknown(parseExport({ mainHost: "m.test", domains: [], links: [{ ...l, protected: false }] }))).toBe(false);
    expect(passwordsUnknown(parseExport({ mainHost: "m.test", domains: [], links: [] }))).toBe(false);
  });
  it("true when any link omits protected, even beside links that carry it", () => {
    expect(passwordsUnknown(parseExport({ mainHost: "m.test", domains: [], links: [{ ...l, protected: false }, l] }))).toBe(true);
  });
});
