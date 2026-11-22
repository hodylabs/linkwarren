import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { fakeApi } from "../test/fakeApi";
import { exportEstimate, exportFileName, runExport, saveBlob, startExport } from "./exportRun";

const startBody = {
  format: "linkwarren-export", version: 1, exportedAt: 1_700_000_000, logo: null, run: "r1", includeAnalytics: false, estimatedReads: 3,
  tables: [{ name: "users", columns: ["id"], rows: 2 }, { name: "links", columns: ["id", "protected"], rows: 1 }],
};

afterEach(() => vi.restoreAllMocks());

describe("runExport", () => {
  it("starts, pages each table until next is null, and assembles the file with complete last", async () => {
    const pages: Record<string, { rows: object[]; next: number | null }[]> = {
      users: [{ rows: [{ id: "u1" }], next: 1 }, { rows: [{ id: "u2" }], next: null }],
      links: [{ rows: [{ id: "l1", protected: true }], next: null }],
    };
    const f = fakeApi({
      "POST /api/export/start": () => ({ body: startBody }),
      "POST /api/export/page": ({ body }) => ({ body: pages[(body as { table: string }).table]!.shift() }),
    });
    const progress: unknown[] = [];
    const started = await startExport(api, { includeAnalytics: false });
    const blob = await runExport(api, started, (p) => progress.push(p));
    const text = await blob.text();
    expect(blob.type).toBe("application/json");
    const j = JSON.parse(text);
    expect(j).toEqual({ format: "linkwarren-export", version: 1, exportedAt: 1_700_000_000, includeAnalytics: false, logo: null, tables: { users: [{ id: "u1" }, { id: "u2" }], links: [{ id: "l1", protected: true }] }, complete: true });
    expect(Object.keys(j).at(-1)).toBe("complete");
    expect(f.calls.map((c) => c.body)).toEqual([{ includeAnalytics: false }, { run: "r1", table: "users", after: null }, { run: "r1", table: "users", after: 1 }, { run: "r1", table: "links", after: null }]);
    expect(progress).toEqual([{ table: "users", rows: 1 }, { table: "users", rows: 2 }, { table: "links", rows: 1 }]);
  });
  it("stops and rejects on a failed page, without asking for more", async () => {
    const f = fakeApi({
      "POST /api/export/start": () => ({ body: startBody }),
      "POST /api/export/page": () => ({ status: 500, body: { error: "internal" } }),
    });
    await expect(runExport(api, await startExport(api, { includeAnalytics: true }), () => {})).rejects.toMatchObject({ code: "internal" });
    expect(f.calls.length).toBe(2);
  });
});

describe("exportEstimate", () => {
  it("gives the share of the 5M daily D1 reads and asks for confirmation above 1M", () => {
    expect(exportEstimate({ estimatedReads: 50_000 })).toEqual({ reads: 50_000, share: 0.01, confirm: false });
    expect(exportEstimate({ estimatedReads: 1_000_000 })).toEqual({ reads: 1_000_000, share: 0.2, confirm: false });
    expect(exportEstimate({ estimatedReads: 1_000_001 }).confirm).toBe(true);
  });
});

describe("saveBlob", () => {
  it("downloads under a safe dated name and revokes the object URL", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const name = exportFileName(new Date("2026-11-22T23:30:00Z"));
    expect(name).toBe("linkwarren-export-2026-11-22.json");
    saveBlob(new Blob(["{}"]), name);
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.contexts[0]).toMatchObject({ download: name, href: "blob:x" });
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
