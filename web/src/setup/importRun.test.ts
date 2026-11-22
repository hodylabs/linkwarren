import { describe, expect, it } from "vitest";
import { fakeApi } from "../test/fakeApi";
import { chunkImport, runImport } from "./importRun";
import type { ImportBody } from "./parseLinks";

const body = (n: number): ImportBody => ({
  mainHost: "go.test",
  domains: [{ host: "a.test" }, { host: "b.test" }],
  links: Array.from({ length: n }, (_, i) => ({ host: null, slug: `s${i}`, destination: "https://x.test", enabled: true })),
});
const report = (created: number, dom: string[]) => ({ created, skipped: 1, conflicts: [{ host: "go.test", slug: "x", reason: "exists" }], caseSensitiveDomains: [], domainsCreated: dom, ignored: [] });

describe("chunkImport", () => {
  it("splits 2,500 links into 1000/1000/500, each with every domain", () => {
    const chunks = chunkImport(body(2500));
    expect(chunks.map((c) => c.links.length)).toEqual([1000, 1000, 500]);
    for (const c of chunks) expect(c.domains).toEqual(body(0).domains);
    expect(chunks[2]!.links[0]!.slug).toBe("s2000");
  });
  it("sends one chunk with the domains when there are no links", () => {
    expect(chunkImport(body(0))).toEqual([body(0)]);
  });
});

describe("runImport", () => {
  it("adds the reports up, dry runs on ?dryRun=1, and lists each new domain once", async () => {
    const { calls } = fakeApi({ "POST /api/import": () => ({ body: report(2, ["a.test"]) }) });
    const r = await runImport(chunkImport(body(1500)), true);
    expect(calls.map((c) => c.path)).toEqual(["/api/import?dryRun=1", "/api/import?dryRun=1"]);
    expect(r).toEqual({ failedAt: null, report: { created: 4, skipped: 2, conflicts: [report(0, []).conflicts[0], report(0, []).conflicts[0]], caseSensitiveDomains: [], domainsCreated: ["a.test"], ignored: [] } });
  });
  it("stops at the first failing chunk with the counts so far", async () => {
    let n = 0;
    const { calls } = fakeApi({ "POST /api/import": () => (++n === 2 ? { status: 400, body: { error: "invalid_body" } } : { body: report(1000, []) }) });
    const r = await runImport(chunkImport(body(2500)), false);
    expect(calls.map((c) => c.path)).toEqual(["/api/import", "/api/import"]);
    expect(r.failedAt).toBe(1);
    expect(r.error).toBe("invalid_body");
    expect(r.report.created).toBe(1000);
  });
});
