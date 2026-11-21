import { afterEach, describe, expect, it, vi } from "vitest";
import { cf, cfConfig, CfError, createDns, createHostname, deleteHostname, deleteRoute, findHostname, findZone, listDns, getFallbackOrigin, setFallbackOrigin, type CfConfig } from "../src/cf/api";
import { dnsPointsAt } from "../src/cf/dns";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";
import type { Env } from "../src/env";

const cfg: CfConfig = { token: "tok-SECRET-123", accountId: "acc1", workerName: "lw", saasZoneId: "saas1", cnameTarget: "edge.test" };
const base = { DB: {}, CACHE: {} } as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("cfConfig", () => {
  const full = { ...base, CF_API_TOKEN: " t ", CF_ACCOUNT_ID: "a", CF_WORKER_NAME: "w", CF_CNAME_TARGET: "Edge.Test." } as Env;
  it("trims and normalizes", () => expect(cfConfig(full)).toEqual({ token: "t", accountId: "a", workerName: "w", saasZoneId: null, cnameTarget: "edge.test" }));
  it("is null when a core var is missing or blank", () => {
    for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_WORKER_NAME"] as const) {
      expect(cfConfig({ ...full, [k]: undefined })).toBeNull();
      expect(cfConfig({ ...full, [k]: "   " })).toBeNull();
    }
  });
  it("token override wins", () => expect(cfConfig({ ...full, CF_API_TOKEN: undefined }, "o")?.token).toBe("o"));
});

describe("fetch seam", () => {
  it("unknown URLs throw in the fake", async () => {
    const fake = installFakeCloudflare();
    await expect(fetch("https://example.org/")).rejects.toThrow(/unexpected fetch/);
    expect(fake.unexpected).toEqual(["GET https://example.org/"]);
    fake.unexpected.length = 0; // expected here; keep afterEach clean
  });
});

describe("findZone", () => {
  it("tries suffixes longest first and stops at the hit", async () => {
    const fake = installFakeCloudflare({ zones: [{ id: "z1", name: "example.com", accountName: "Acme" }] });
    expect(await findZone(cfg, "a.b.example.com")).toEqual({ id: "z1", name: "example.com", accountName: "Acme" });
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/zones?name=a.b.example.com&account.id=acc1",
      "/zones?name=b.example.com&account.id=acc1",
      "/zones?name=example.com&account.id=acc1",
    ]);
    expect(fake.calls[0]!.method).toBe("GET");
  });
  it("returns null when nothing matches and never looks up the bare TLD", async () => {
    const fake = installFakeCloudflare();
    expect(await findZone(cfg, "a.example.com")).toBeNull();
    expect(fake.calls).toHaveLength(2);
  });
});

describe("findZone encoding", () => {
  it("URL-encodes a crafted host in the query", async () => {
    const fake = installFakeCloudflare();
    await findZone(cfg, "a.example.com&account.id=x");
    expect(fake.calls[0]!.path).toBe("/zones?name=a.example.com%26account.id%3Dx&account.id=acc1");
  });
});

describe("cf errors", () => {
  it("a 2xx body of the wrong shape is a CfError, not a ZodError", async () => {
    const fake = installFakeCloudflare();
    fake.failNext(/dns_records/, 200, { success: true, errors: null, result: [{ nope: 1 }] });
    await expect(listDns(cfg, "z1", "x.example.com")).rejects.toBeInstanceOf(CfError);
  });
  it("deleteHostname rejects (never throws synchronously) without a saas zone", async () => {
    const p = deleteHostname({ ...cfg, saasZoneId: null }, "x");
    await expect(p).rejects.toBeInstanceOf(CfError);
  });
  it("success:false with a code yields CfError with codes", async () => {
    const fake = installFakeCloudflare();
    fake.failNext(/zones/, 200, { success: false, errors: [{ code: 1004, message: "x" }], result: null });
    await expect(cf(cfg, "GET", "/zones")).rejects.toMatchObject({ status: 200, codes: [1004], message: "cloudflare_200" });
  });
  it("tolerates errors without a code", async () => {
    const fake = installFakeCloudflare();
    fake.failNext(/workers\/routes/, 403, { success: false, errors: [{ message: "nope" }], result: null });
    await expect(cf(cfg, "POST", "/zones/z/workers/routes", {})).rejects.toMatchObject({ status: 403, codes: [] });
  });
  it("a non-JSON error body still gives a CfError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(cf(cfg, "GET", "/zones")).rejects.toMatchObject({ status: 502, codes: [] });
  });
  it("a fetch throw or timeout is status 0", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(cf(cfg, "GET", "/zones")).rejects.toMatchObject({ status: 0 });
  });
  it("sends the bearer token and a 10s abort signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, result: [] })));
    await cf(cfg, "GET", "/zones");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok-SECRET-123");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it("never leaks the token through message, String or JSON", async () => {
    const fake = installFakeCloudflare();
    fake.failNext(/zones/, 400, { success: false, errors: [{ code: 9000, message: `bad ${cfg.token}` }], result: null });
    const e = await cf(cfg, "GET", "/zones").catch((x) => x);
    expect(e).toBeInstanceOf(CfError);
    for (const s of [e.message, String(e), JSON.stringify(e)]) expect(s).not.toContain("SECRET");
  });
});

describe("helpers", () => {
  it("deleteRoute resolves on 404 but rejects on other errors", async () => {
    const fake = installFakeCloudflare();
    await expect(deleteRoute(cfg, "z1", "gone")).resolves.toBeUndefined();
    fake.failNext(/routes/, 403);
    await expect(deleteRoute(cfg, "z1", "x")).rejects.toMatchObject({ status: 403 });
  });
  it("createDns sends the placeholder record", async () => {
    const fake = installFakeCloudflare();
    await createDns(cfg, "z1", "go.example.com");
    expect(fake.calls[0]!.body).toEqual({ type: "AAAA", name: "go.example.com", content: "100::", proxied: true, comment: "linkwarren" });
  });
  it("hostname status is parsed and errors capped at 3 x 200 chars", async () => {
    const fake = installFakeCloudflare();
    await createHostname(cfg, "go.example.com");
    expect(fake.calls[0]!.body).toEqual({ hostname: "go.example.com", ssl: { method: "http", type: "dv" } });
    const h = fake.state.hostnames[0]!;
    h.status = "pending";
    h.verification_errors = ["a".repeat(500)];
    h.ssl.validation_errors = [{ message: "b" }, { message: "c" }, { message: "d" }];
    const got = await findHostname(cfg, "go.example.com");
    expect(got).toMatchObject({ status: "pending", sslStatus: "pending_validation" });
    expect(got!.errors).toHaveLength(3);
    expect(got!.errors[0]).toHaveLength(200);
    expect(await findHostname(cfg, "none.example.com")).toBeNull();
  });
  it("fallback origin: unset is null, set stores the cname target", async () => {
    installFakeCloudflare();
    expect(await getFallbackOrigin(cfg)).toBeNull();
    await setFallbackOrigin(cfg);
    expect(await getFallbackOrigin(cfg)).toBe("edge.test");
  });
});

describe("dnsPointsAt", () => {
  const T = "edge.test";
  it("CNAME match, ignoring case and trailing dot", async () => {
    installFakeCloudflare({ doh: { "CNAME:go.example.com": ["Edge.Test."] } });
    expect(await dnsPointsAt("go.example.com", T)).toBe("found");
  });
  it("flattened apex found by A intersection", async () => {
    installFakeCloudflare({ doh: { "A:example.com": ["1.2.3.4"], "A:edge.test": ["9.9.9.9", "1.2.3.4"] } });
    expect(await dnsPointsAt("example.com", T)).toBe("found");
  });
  it("no answers is missing", async () => {
    installFakeCloudflare();
    expect(await dnsPointsAt("go.example.com", T)).toBe("missing");
  });
  it("another CNAME is wrong_target", async () => {
    installFakeCloudflare({ doh: { "CNAME:go.example.com": ["other.test."] } });
    expect(await dnsPointsAt("go.example.com", T)).toBe("wrong_target");
  });
  it("a 503 from DoH is unknown, not missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    expect(await dnsPointsAt("go.example.com", T)).toBe("unknown");
  });
  it("a thrown fetch is unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    expect(await dnsPointsAt("go.example.com", T)).toBe("unknown");
  });
  it("SERVFAIL and bad JSON are unknown; NXDOMAIN is missing", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockImplementation(async () => new Response(JSON.stringify({ Status: 2 })));
    expect(await dnsPointsAt("go.example.com", T)).toBe("unknown");
    f.mockImplementation(async () => new Response("<html>"));
    expect(await dnsPointsAt("go.example.com", T)).toBe("unknown");
    f.mockImplementation(async () => new Response(JSON.stringify({ Status: 3 })));
    expect(await dnsPointsAt("go.example.com", T)).toBe("missing");
  });
  it("DoH requests carry the dns-json accept header", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ Status: 0 })));
    await dnsPointsAt("go.example.com", T);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://cloudflare-dns.com/dns-query?name=go.example.com&type=CNAME");
    expect((init!.headers as Record<string, string>).accept).toBe("application/dns-json");
  });
});
