import { afterEach, describe, expect, it, vi } from "vitest";
import { CfError, type CfConfig } from "../src/cf/api";
import { checkToken, classifyProbe, PERMISSIONS } from "../src/cf/perms";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare, type FakePerm, type FakeToken } from "./helpers/cf";

const cfg: CfConfig = { token: "full", accountId: "acc1", workerName: "lw", saasZoneId: "zsaas", cnameTarget: "edge.saas.test" };
const zones = [{ id: "zsaas", name: "saas.test", accountName: "Acme" }, { id: "z1", name: "example.com", accountName: "Acme" }];
const ALL: FakePerm[] = ["zone_read", "dns_edit", "routes_edit", "ssl_edit"];
const states = (r: Awaited<ReturnType<typeof checkToken>>) => Object.fromEntries(r.permissions.map((p) => [p.key, p.state]));

afterEach(() => {
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

describe("PERMISSIONS", () => {
  it("lists the six permissions with groups and exact labels", () => {
    expect(PERMISSIONS.map((p) => [p.key, p.group, p.label])).toEqual([
      ["zone_read", "core", "Zone: Read"],
      ["dns_edit", "core", "DNS: Edit"],
      ["routes_edit", "core", "Workers Routes: Edit"],
      ["ssl_edit", "outside", "SSL and Certificates: Edit"],
      ["config_rules_edit", "controls", "Config Rules: Edit"],
      ["waf_edit", "controls", "Zone WAF: Edit"],
    ]);
    expect(PERMISSIONS[0]!.why).toBe("See which domains are in this account");
  });
});

describe("classifyProbe", () => {
  it.each([
    [400, [9000], "ok"], [400, [10022], "ok"], [400, [1407], "ok"], [400, [], "ok"],
    [400, [9109], "missing"], [400, [10000], "missing"],
    [403, [9109], "missing"], [403, [10000], "missing"], [403, [], "missing"], [401, [10000], "missing"],
    [500, [], "unknown"], [0, [], "unknown"], [404, [7003], "unknown"], [200, [], "unknown"],
  ] as const)("%i %j -> %s", (status, codes, want) => {
    expect(classifyProbe(status, [...codes])).toBe(want);
  });
});

describe("checkToken", () => {
  it("full token: six entries, core and outside ok, controls unknown, account name from the zone", async () => {
    installFakeCloudflare({ zones, tokens: { full: { perms: ALL } } });
    const r = await checkToken(cfg);
    expect(r.token).toBe("active");
    expect(r.accountName).toBe("Acme");
    expect(r.permissions.map((p) => p.key)).toEqual(PERMISSIONS.map((p) => p.key));
    expect(states(r)).toEqual({ zone_read: "ok", dns_edit: "ok", routes_edit: "ok", ssl_edit: "ok", config_rules_edit: "unknown", waf_edit: "unknown" });
  });
  it("Zone Read only: dns, routes and ssl missing", async () => {
    installFakeCloudflare({ zones, tokens: { full: { perms: ["zone_read"] } } });
    expect(states(await checkToken(cfg))).toMatchObject({ zone_read: "ok", dns_edit: "missing", routes_edit: "missing", ssl_edit: "missing" });
  });
  it("probes send only invalid bodies and never PUT, PATCH or DELETE", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { full: { perms: ALL } } });
    await checkToken(cfg);
    expect(fake.calls.filter((c) => !["GET", "POST"].includes(c.method))).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/zones/zsaas/dns_records", {}],
      ["/zones/zsaas/workers/routes", { pattern: "" }],
      ["/zones/zsaas/custom_hostnames", { hostname: "" }],
    ]);
    expect(fake.state.dns).toEqual([]);
    expect(fake.state.routes).toEqual([]);
    expect(fake.state.hostnames).toEqual([]);
  });
  it("without a SaaS zone: lists zones for zone read, probes the first zone, ssl unknown", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { full: { perms: ALL } } });
    const r = await checkToken({ ...cfg, saasZoneId: null });
    expect(fake.calls[1]!.path).toBe("/zones?account.id=acc1&per_page=1");
    expect(fake.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/zones/zsaas/dns_records", "/zones/zsaas/workers/routes"]);
    expect(states(r)).toMatchObject({ zone_read: "ok", dns_edit: "ok", routes_edit: "ok", ssl_edit: "unknown" });
  });
  it("no zones at all (or a list the token cannot see): zone read, dns and routes unknown", async () => {
    installFakeCloudflare({ zones: [], tokens: { full: { perms: ALL } } });
    expect(states(await checkToken({ ...cfg, saasZoneId: null }))).toMatchObject({ zone_read: "unknown", dns_edit: "unknown", routes_edit: "unknown" });
  });
  it("user-owned token falls back to /user/tokens/verify", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { full: { perms: ALL, userOwned: true } } });
    expect((await checkToken(cfg)).token).toBe("active");
    expect(fake.calls.slice(0, 2).map((c) => c.path)).toEqual(["/accounts/acc1/tokens/verify", "/user/tokens/verify"]);
  });
  it("account verify 404 also falls back", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { full: { perms: ALL, userOwned: true } } });
    fake.failNext(/^\/accounts\/acc1\/tokens\/verify$/, 404);
    expect((await checkToken(cfg)).token).toBe("active");
  });
  it("invalid or disabled token: invalid, every permission unknown, no probes", async () => {
    for (const tokens of [{}, { full: { perms: ALL, status: "disabled" } }] as Record<string, FakeToken>[]) {
      const fake = installFakeCloudflare({ zones, tokens });
      const r = await checkToken(cfg);
      expect(r).toEqual({ token: "invalid", accountName: null, permissions: PERMISSIONS.map((p) => ({ key: p.key, state: "unknown" })) });
      expect(fake.calls.every((c) => c.path.endsWith("/tokens/verify"))).toBe(true);
      vi.restoreAllMocks();
    }
  });
  it("Cloudflare down during verify throws a CfError", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.failNext(/tokens\/verify/, 503);
    await expect(checkToken(cfg)).rejects.toBeInstanceOf(CfError);
  });
  it("a 500 on one probe reports that permission unknown", async () => {
    const fake = installFakeCloudflare({ zones, tokens: { full: { perms: ALL } } });
    fake.failNext(/workers\/routes$/, 500);
    expect(states(await checkToken(cfg))).toMatchObject({ dns_edit: "ok", routes_edit: "unknown", ssl_edit: "ok" });
  });
});
