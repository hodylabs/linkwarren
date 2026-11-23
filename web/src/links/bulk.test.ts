import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../api";
import { fakeApi, type FakeReq } from "../test/fakeApi";
import { CHUNK, csvName, downloadCsv, runBulk, shortUrls, toCsv } from "./bulk";

const mk = (id: string, slug: string, o: Partial<Link> = {}): Link => ({
  id, domainId: "d1", slug, slugKey: slug, url: `https://example.com/${slug}`, redirectCode: 302, startsAt: null, expiresAt: null,
  passQuery: true, hasPassword: false, routes: [], forwardTo: null, kind: "url", createdBy: "uo", updatedBy: "uo", createdAt: 100, updatedAt: 100, ...o,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
const okAll = (req: FakeReq) => ({ body: { results: (req.body as { ids: string[] }).ids.map((id) => ({ id, ok: true })), pending: [] } });
const sent = (api: { calls: { body: unknown }[] }) => api.calls.map((c) => (c.body as { ids: string[] }).ids);
afterEach(() => vi.unstubAllGlobals());

describe("runBulk", () => {
  it("250 ids go as five chunks of 50 in order with progress", async () => {
    const api = fakeApi({ "POST /api/links/bulk": okAll });
    const progress: [number, number][] = [];
    const r = await runBulk({ action: "delete" }, ids(250), { onProgress: (d, t) => progress.push([d, t]), signal: new AbortController().signal });
    expect(CHUNK).toBe(50);
    expect(sent(api).map((x) => x.length)).toEqual([50, 50, 50, 50, 50]);
    expect(sent(api).flat()).toEqual(ids(250));
    expect(progress).toEqual([[50, 250], [100, 250], [150, 250], [200, 250], [250, 250]]);
    expect(r.ok.size).toBe(250);
    expect(r.failed.size).toBe(0);
  });

  it("a password set resends pending until done, then stops with pending failures when a response makes no progress", async () => {
    let n = 0;
    const api = fakeApi({
      "POST /api/links/bulk": (req) => {
        const [first, ...rest] = (req.body as { ids: string[] }).ids;
        // two links set, then the server stops making progress
        return ++n <= 2 ? { body: { results: [{ id: first, ok: true, link: mk(first!, "s") }], pending: rest } } : { body: { results: [], pending: [first, ...rest] } };
      },
    });
    const progress: number[] = [];
    const r = await runBulk({ action: "password", password: "secret-pass" }, ["a", "b", "c", "d"], { onProgress: (d) => progress.push(d), signal: new AbortController().signal });
    expect(sent(api)).toEqual([["a", "b", "c", "d"], ["b", "c", "d"], ["c", "d"]]);
    expect([...r.ok.keys()]).toEqual(["a", "b"]);
    expect(r.ok.get("a")?.id).toBe("a");
    expect(Object.fromEntries(r.failed)).toEqual({ c: "pending", d: "pending" });
    expect(progress.at(-1)).toBe(4);
  });

  it("an abort after the first chunk sends no second request", async () => {
    const ctl = new AbortController();
    const api = fakeApi({ "POST /api/links/bulk": (req) => (ctl.abort(), okAll(req)) });
    const r = await runBulk({ action: "delete" }, ids(150), { onProgress: () => undefined, signal: ctl.signal });
    expect(api.calls).toHaveLength(1);
    expect(r.ok.size).toBe(50);
    expect(r.failed.get("l120")).toBe("not_run");
    expect(r.stop).toBe("not_run");
    expect(r.whole.has("l120")).toBe(true);
  });

  it("a 429 on chunk 2 marks only its ids with the code and sends nothing after it", async () => {
    let n = 0;
    const api = fakeApi({ "POST /api/links/bulk": (req) => (++n === 2 ? { status: 429, body: { error: "rate_limited" } } : okAll(req)) });
    const r = await runBulk({ action: "delete" }, ids(250), { onProgress: () => undefined, signal: new AbortController().signal });
    expect(api.calls).toHaveLength(2);
    expect(r.ok.size).toBe(50);
    expect(r.failed.get("l70")).toBe("rate_limited");
    expect([...r.failed.values()].filter((c) => c === "rate_limited")).toHaveLength(50);
    expect(r.failed.get("l220")).toBe("not_run");
    expect(r.stop).toBe("rate_limited");
    expect(r.whole.size).toBe(200);
    expect(r.whole.has("l0")).toBe(false);
  });

  it("per-link refusals are not whole-request failures", async () => {
    fakeApi({ "POST /api/links/bulk": () => ({ body: { results: [{ id: "a", ok: false, error: "taken" }], pending: [] } }) });
    const r = await runBulk({ action: "delete" }, ["a"], { onProgress: () => undefined, signal: new AbortController().signal });
    expect(r.whole.size).toBe(0);
    expect(r.stop).toBeNull();
  });

  it("a dropped connection stops the run with lost_connection", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await runBulk({ action: "delete" }, ["a", "b"], { onProgress: () => undefined, signal: new AbortController().signal });
    expect(r.stop).toBe("lost_connection");
    expect(r.failed.get("a")).toBe("lost_connection");
  });

  it("an answer that cannot be read (network) is lost_connection too: outcome unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    const r = await runBulk({ action: "delete" }, ["a", "b"], { onProgress: () => undefined, signal: new AbortController().signal });
    expect(r.stop).toBe("lost_connection");
    expect([...r.failed]).toEqual([["a", "lost_connection"], ["b", "lost_connection"]]);
  });

  it("a 409 conflict marks its chunk and carries on with the next", async () => {
    let n = 0;
    const api = fakeApi({ "POST /api/links/bulk": (req) => (++n === 1 ? { status: 409, body: { error: "conflict" } } : okAll(req)) });
    const r = await runBulk({ action: "delete" }, ids(100), { onProgress: () => undefined, signal: new AbortController().signal });
    expect(api.calls).toHaveLength(2);
    expect(r.failed.get("l0")).toBe("conflict");
    expect(r.ok.has("l70")).toBe(true);
  });

  it("per-link refusals come back with their reasons", async () => {
    fakeApi({ "POST /api/links/bulk": () => ({ body: { results: [{ id: "a", ok: true }, { id: "b", ok: false, error: "taken" }], pending: [] } }) });
    const r = await runBulk({ action: "move", domainId: "d2", oldAddress: "forward" }, ["a", "b"], { onProgress: () => undefined, signal: new AbortController().signal });
    expect(r.ok.get("a")).toBeNull();
    expect(r.failed.get("b")).toBe("taken");
  });
});

describe("shortUrls and toCsv", () => {
  const host = (id: string) => (id === "d1" ? "go.test" : "b.test");
  it("shortUrls is one https URL per line", () => {
    expect(shortUrls([mk("a", "spring"), mk("b", "menu", { domainId: "d2" })], host)).toBe("https://go.test/spring\nhttps://b.test/menu");
  });

  it("quotes, guards formulas, starts with a BOM, uses CRLF and never has a password column", () => {
    const links = [
      mk("a", "spring", { url: 'https://example.com/a,b "c"\nd', hasPassword: true, startsAt: 0, expiresAt: 86400 }),
      mk("b", "=cmd", { url: "+1" }),
      mk("c", "-1", { url: "@x" }),
      mk("f", "old", { url: "https://b.test/old", forwardTo: "a" }),
    ];
    const csv = toCsv(links, host, (id) => (id === "uo" ? "You" : "Teammate"));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("short_url,destination,kind,domain,slug,status,redirect_code,pass_query,has_password,starts_at,expires_at,routes,forwards_to,created_by,created_at");
    expect(csv).not.toMatch(/password_hash|,password,/);
    expect(csv.slice(1).replace(/\r\n/g, "").includes("\n")).toBe(true); // the only bare LF is inside the quoted cell
    expect(lines[1]).toContain('"https://example.com/a,b ""c""\nd"'.split("\n")[0]);
    expect(lines[1]).toContain(",true,1970-01-01T00:00:00.000Z,1970-01-02T00:00:00.000Z,");
    expect(csv).toContain("https://go.test/=cmd,'+1,url,go.test,'=cmd,");
    expect(csv).toContain("https://go.test/-1,'@x,url,go.test,'-1,");
    expect(csv).toContain(",https://b.test/old,You,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("guards a formula after leading whitespace, leaves forwards_to empty for a normal link, and never builds https:///slug", () => {
    const csv = toCsv([mk("a", "x", { url: " =1+1" }), mk("b", "y", { domainId: "gone" })], (id) => (id === "d1" ? "go.test" : ""), () => "You");
    const [, a, b] = csv.slice(1).split("\r\n");
    expect(a).toContain(",' =1+1,");
    expect(a!.split(",")[12]).toBe(""); // forwards_to
    expect(b!.startsWith(",https://example.com/y,url,,y,")).toBe(true);
    expect(csv).not.toContain("https:///");
  });

  it("a contact card has kind vcard and an empty destination, never the placeholder", () => {
    const csv = toCsv([mk("a", "ada", { kind: "vcard", url: "https://vcard.invalid/" })], host, () => "You");
    expect(csv.slice(1).split("\r\n")[1]!.startsWith("https://go.test/ada,,vcard,go.test,ada,")).toBe(true);
    expect(csv).not.toContain("vcard.invalid");
  });

  it("downloadCsv saves through an object URL it then revokes, under a dated name", async () => {
    const create = vi.fn(() => "blob:x"), revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    downloadCsv("a,b\r\n", "f.csv");
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download]")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(csvName(new Date("2026-11-22T10:00:00Z"))).toBe("linkwarren-links-2026-11-22.csv");
    click.mockRestore();
  });

  it("guards tab and CR at the start of a cell", () => {
    const csv = toCsv([mk("a", "x", { url: "\tx" }), mk("b", "y", { url: "\ry" })], host, () => "You");
    expect(csv).toContain(",'\tx,");
    expect(csv).toContain(`,"'\ry",`);
  });
});
