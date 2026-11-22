import { describe, expect, it } from "vitest";
import { fakeApi } from "../test/fakeApi";
import { chunkImport, resultsCsv, runImport, type ImportReport } from "./importRun";
import type { ImportBody } from "./parseLinks";

const link = (slug: string, host: string | null = null) => ({ host, slug, destination: "https://x.test", enabled: true, startDate: null, endDate: null });
const body = (n: number): ImportBody => ({
  mainHost: "go.test",
  domains: [{ host: "a.test", customIndexUrl: null, customNotFoundUrl: null }, { host: "b.test", customIndexUrl: null, customNotFoundUrl: null }],
  links: Array.from({ length: n }, (_, i) => link(`s${String(i).padStart(4, "0")}`)),
});
const report = (created: number, dom: string[]): ImportReport => ({ created, skipped: 1, conflicts: [{ host: "go.test", slug: "x", reason: "exists" }], caseSensitiveDomains: [], domainsCreated: dom, ignored: [], protected: [] });

describe("chunkImport", () => {
  it("splits 2,500 links into 1000/1000/500, then sends the domains without links on their own", () => {
    const chunks = chunkImport(body(2500));
    expect(chunks.map((c) => c.links.length)).toEqual([1000, 1000, 500, 0]);
    expect(chunks.slice(0, 3).every((c) => c.domains.length === 0)).toBe(true);
    expect(chunks[3]!.domains.map((d) => d.host)).toEqual(["a.test", "b.test"]);
  });
  it("keeps slugs that differ only by case in one chunk, with their domain", () => {
    const b = { ...body(0), links: [link("Abc", "a.test"), ...Array.from({ length: 1500 }, (_, i) => link(`m${i}`, "a.test")), link("abc", "a.test")] };
    const chunks = chunkImport(b);
    const withTwins = chunks.find((c) => c.links.some((l) => l.slug === "Abc"))!;
    expect(withTwins.links.some((l) => l.slug === "abc")).toBe(true);
    expect(withTwins.domains.map((d) => d.host)).toEqual(["a.test"]);
  });
});

describe("runImport", () => {
  it("adds the reports up, dry runs on ?dryRun=1, lists each new domain once and reports progress", async () => {
    const { calls } = fakeApi({ "POST /api/import": () => ({ body: report(2, ["a.test"]) }) });
    const parts: string[] = [];
    const r = await runImport(chunkImport({ ...body(1500), domains: [] }), true, { onPart: (i, n) => parts.push(`${i}/${n}`) });
    expect(calls.map((c) => c.path)).toEqual(["/api/import?dryRun=1", "/api/import?dryRun=1"]);
    expect(parts).toEqual(["1/2", "2/2"]);
    expect(r).toEqual({ failedAt: null, report: { ...report(4, ["a.test"]), skipped: 2, conflicts: [...report(0, []).conflicts, ...report(0, []).conflicts] } });
  });
  it("stops at the first failing chunk with the counts so far, and resumes from it", async () => {
    let n = 0;
    const { calls } = fakeApi({ "POST /api/import": () => (++n === 2 ? { status: 400, body: { error: "invalid_body" } } : { body: report(1000, []) }) });
    const chunks = chunkImport({ ...body(2500), domains: [] });
    const r = await runImport(chunks, false);
    expect(calls.map((c) => c.path)).toEqual(["/api/import", "/api/import"]);
    expect(r).toMatchObject({ failedAt: 1, error: "invalid_body", report: { created: 1000 } });
    const again = await runImport(chunks, false, { from: r.failedAt!, report: r.report });
    expect(calls.length).toBe(4);
    expect(again).toMatchObject({ failedAt: null, report: { created: 3000 } });
  });
});

describe("resultsCsv", () => {
  it("has a row for every conflict, protected link and ignored redirect, with formula cells quoted", () => {
    const r: ImportReport = { ...report(0, []), conflicts: [{ host: "go.test", slug: "=cmd", reason: "invalid_slug" }], protected: [{ host: "go.test", slug: "p" }], ignored: [{ host: "a.test", field: "customIndexUrl" }] };
    expect(resultsCsv(r)).toBe("﻿host,slug,result,reason\r\ngo.test,'=cmd,conflict,invalid_slug\r\ngo.test,p,protected,password\r\na.test,,ignored,customIndexUrl\r\n");
  });
});
