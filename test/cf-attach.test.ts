import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CfError, type CfConfig } from "../src/cf/api";
import { AttachError, classify, detachDomain, isVerified, routeCovers, syncDomain } from "../src/cf/attach";
import { rowToCf, rowToDomain, type CfRow } from "../src/types";
import type { Env } from "../src/env";
import { assertNoUnexpectedCloudflareCalls, installFakeCloudflare } from "./helpers/cf";

const cfg: CfConfig = { token: "tok-SECRET-123", accountId: "acc1", workerName: "lw", saasZoneId: "saas1", cnameTarget: "edge.test" };
const e = env as unknown as Env;
const zones = [{ id: "zsaas", name: "saas.test" }, { id: "z1", name: "example.com" }, { id: "zo", name: "owned.test" }];
const writes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method !== "GET");

beforeEach(async () => {
  await env.DB.batch(["domain_cf", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("INSERT INTO users (id,email,role,status,created_at) VALUES ('uo','owner@example.com','owner','active',1)").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  assertNoUnexpectedCloudflareCalls();
});

async function mk(host: string, kind: CfRow["kind"], extra: Record<string, string> = {}) {
  const id = `d-${host}`;
  await env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,'main','pending','uo',1)").bind(id, host).run();
  const cols = Object.keys(extra);
  await env.DB.prepare(`INSERT INTO domain_cf (domain_id,kind,updated_at${cols.map((c) => "," + c).join("")}) VALUES (?,?,1${cols.map(() => ",?").join("")})`)
    .bind(id, kind, ...Object.values(extra)).run();
  return load(id);
}
async function load(id: string) {
  const d = rowToDomain((await env.DB.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first())!);
  const cf = rowToCf((await env.DB.prepare("SELECT * FROM domain_cf WHERE domain_id = ?").bind(id).first())!);
  return { d, cf };
}

describe("classify", () => {
  it("a host under any account zone is account, including subdomains of the SaaS zone", async () => {
    installFakeCloudflare({ zones });
    expect(await classify(cfg, "go.example.com")).toEqual({ kind: "account", zoneId: "z1", zoneName: "example.com" });
    expect(await classify(cfg, "x.saas.test")).toEqual({ kind: "account", zoneId: "zsaas", zoneName: "saas.test" });
  });
  it("is outside when no zone matches", async () => {
    installFakeCloudflare({ zones });
    expect(await classify(cfg, "go.outside.test")).toEqual({ kind: "outside" });
  });
  it("outside without SaaS config throws CfError 0 with code -1", async () => {
    installFakeCloudflare({ zones });
    for (const c of [{ ...cfg, saasZoneId: null }, { ...cfg, cnameTarget: null }])
      await expect(classify(c, "go.outside.test")).rejects.toMatchObject({ status: 0, codes: [-1] });
  });
});

describe("syncDomain outside", () => {
  it("creates exactly one hostname and one per-host route on the SaaS zone, never */*, and is idempotent", async () => {
    const fake = installFakeCloudflare({ zones, doh: { "CNAME:go.outside.test": ["edge.test."] } });
    const { d, cf } = await mk("go.outside.test", "outside");
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    expect(fake.state.hostnames.map((h) => h.hostname)).toEqual(["go.outside.test"]);
    expect(fake.state.routes).toEqual([{ id: expect.any(String), zoneId: "saas1", pattern: "go.outside.test/*", script: "lw" }]);
    expect(fake.calls.some((c) => (c.body as { pattern?: string } | undefined)?.pattern === "*/*")).toBe(false);
    expect(r).toMatchObject({ hostnameId: fake.state.hostnames[0]!.id, routeId: fake.state.routes[0]!.id, dns: "found", ownership: "pending", certificate: "pending", lastError: null });
    expect(r.checkedAt).toEqual(expect.any(Number));
    expect((await load(d.id)).cf).toEqual(r);

    const before = writes(fake.calls).length;
    const r2 = await syncDomain(e, cfg, d, r, { attach: true });
    expect(writes(fake.calls)).toHaveLength(before);
    expect(r2).toMatchObject({ hostnameId: r.hostnameId, routeId: r.routeId });
  });

  it("maps hostname and ssl statuses", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    const row = await syncDomain(e, cfg, d, cf, { attach: true });
    const table: [string, string, CfRow["ownership"], CfRow["certificate"]][] = [
      ["active", "active", "verified", "issued"],
      ["pending", "initializing", "pending", "pending"],
      ["pending", "pending_validation", "pending", "pending"],
      ["blocked", "pending_issuance", "failed", "pending"],
      ["moved", "validation_timed_out", "failed", "failed"],
      ["deleted", "deleted", "failed", "failed"],
      ["active", "expired", "verified", "failed"],
      ["active_redeploying", "backup_issued", "verified", "issued"],
      ["active", "pending_deletion", "verified", "failed"],
      ["active", "pending_expiration", "verified", "failed"],
      ["active", "pending_cleanup", "verified", "failed"],
      ["weird", "weird", "unknown", "unknown"],
    ];
    for (const [status, ssl, ownership, certificate] of table) {
      Object.assign(fake.state.hostnames[0]!, { status, ssl: { status: ssl } });
      expect(await syncDomain(e, cfg, d, row, { attach: true })).toMatchObject({ ownership, certificate });
    }
  });

  it("dns: flattened apex is found, nothing is missing, another CNAME is wrong_target", async () => {
    const fake = installFakeCloudflare({ zones, doh: { "A:outside.test": ["192.0.2.7"], "A:edge.test": ["192.0.2.7"] } });
    let { d, cf } = await mk("outside.test", "outside");
    expect((await syncDomain(e, cfg, d, cf, { attach: true })).dns).toBe("found");
    ({ d, cf } = await mk("b.outside.test", "outside"));
    expect((await syncDomain(e, cfg, d, cf, { attach: true })).dns).toBe("missing");
    fake.state.doh["CNAME:b.outside.test"] = ["other.test"];
    expect((await syncDomain(e, cfg, d, cf, { attach: true })).dns).toBe("wrong_target");
  });

  it("a route bound to another script is route_in_use, with no write at all", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-theirs", zoneId: "saas1", pattern: "go.outside.test/*", script: "other" });
    const { d, cf } = await mk("go.outside.test", "outside");
    const err = await syncDomain(e, cfg, d, cf, { attach: true }).catch((x) => x);
    expect(err).toBeInstanceOf(AttachError);
    expect(err.code).toBe("route_in_use");
    expect(writes(fake.calls)).toEqual([]);
    expect((await load(d.id)).cf).toMatchObject({ lastError: "route_in_use", routeId: null, hostnameId: null });
  });

  it("an existing route and hostname it did not create are used but never adopted", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-hand", zoneId: "saas1", pattern: "go.outside.test/*", script: "lw" });
    fake.state.hostnames.push({ id: "ch-hand", hostname: "go.outside.test", status: "active", ssl: { status: "active" } });
    const { d, cf } = await mk("go.outside.test", "outside");
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    expect(writes(fake.calls)).toEqual([]);
    expect(r).toMatchObject({ routeId: null, hostnameId: null, ownership: "verified", certificate: "issued" });
  });

  it("Review Focus 2: a 500 stores last_error and the next sync finishes and clears it", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    fake.failNext(/custom_hostnames/, 500, { success: false, errors: [{ code: 1, message: `echo ${cfg.token}` }], result: null });
    await expect(syncDomain(e, cfg, d, cf, { attach: true })).rejects.toBeInstanceOf(CfError);
    const after = (await load(d.id)).cf;
    expect(after.lastError).toBe("cloudflare_500");
    expect(JSON.stringify(after)).not.toContain("SECRET");
    const r = await syncDomain(e, cfg, d, after, { attach: true });
    expect(r.lastError).toBeNull();
    expect(fake.state.hostnames).toHaveLength(1);
    expect(fake.state.routes).toHaveLength(1);
  });

  it("an id created before a later failure is still stored", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    fake.failNext(/workers\/routes$/, 200, { success: false, errors: [], result: null }); // the GET
    await expect(syncDomain(e, cfg, d, cf, { attach: true })).rejects.toBeInstanceOf(CfError);
    expect(fake.state.hostnames).toHaveLength(0); // reads fail before any write
    fake.calls.length = 0;
    // fail the route POST only: GET passes through first
    const realHandle = fake.handle;
    let posted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (i, init) => {
      const req = new Request(i as RequestInfo, init);
      if (req.method === "POST" && req.url.includes("/workers/routes") && !posted) {
        posted = true;
        return new Response(JSON.stringify({ success: false, errors: [], result: null }), { status: 500 });
      }
      return realHandle(req);
    });
    await expect(syncDomain(e, cfg, d, (await load(d.id)).cf, { attach: true })).rejects.toMatchObject({ status: 500 });
    const stored = (await load(d.id)).cf;
    expect(stored.hostnameId).toBe(fake.state.hostnames[0]!.id);
    expect(stored.lastError).toBe("cloudflare_500");
  });

  it("re-creates a stored route that vanished and stores the new id", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    fake.state.routes.length = 0;
    const r2 = await syncDomain(e, cfg, d, r, { attach: true });
    expect(fake.state.routes).toHaveLength(1);
    expect(r2.routeId).toBe(fake.state.routes[0]!.id);
    expect(r2.routeId).not.toBe(r.routeId);
  });

  it("outside without SaaS config fails with code -1 and writes nothing", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    await expect(syncDomain(e, { ...cfg, cnameTarget: null }, d, cf, { attach: true })).rejects.toMatchObject({ status: 0, codes: [-1] });
    expect(fake.calls).toEqual([]);
  });
});

describe("syncDomain account", () => {
  it("no record: creates the placeholder record and the route on the zone", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    expect(fake.state.dns).toEqual([expect.objectContaining({ zoneId: "z1", type: "AAAA", name: "go.example.com", proxied: true })]);
    expect(fake.state.routes).toEqual([{ id: expect.any(String), zoneId: "z1", pattern: "go.example.com/*", script: "lw" }]);
    expect(r).toMatchObject({ dnsRecordId: fake.state.dns[0]!.id, routeId: fake.state.routes[0]!.id, dns: "found", ownership: "verified", certificate: "issued", lastError: null });
    const before = writes(fake.calls).length;
    await syncDomain(e, cfg, d, r, { attach: true });
    expect(writes(fake.calls)).toHaveLength(before);
    expect(isVerified(r)).toBe(true);
  });

  it("Review Focus 1: an existing proxied record without confirmTakeover is dns_record_exists with zero writes", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-theirs", zoneId: "z1", type: "A", name: "www.example.com", content: "192.0.2.1", proxied: true, comment: null });
    const { d, cf } = await mk("www.example.com", "account", { zone_id: "z1" });
    const err = await syncDomain(e, cfg, d, cf, { attach: true }).catch((x) => x);
    expect(err).toBeInstanceOf(AttachError);
    expect(err.code).toBe("dns_record_exists");
    expect(writes(fake.calls)).toEqual([]);
    expect((await load(d.id)).cf.lastError).toBe("dns_record_exists");

    fake.calls.length = 0;
    const r = await syncDomain(e, cfg, d, (await load(d.id)).cf, { attach: true, confirmTakeover: true });
    expect(writes(fake.calls).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /zones/z1/workers/routes"]);
    expect(fake.state.dns).toEqual([expect.objectContaining({ id: "rec-theirs", content: "192.0.2.1", proxied: true })]);
    expect(r).toMatchObject({ dnsRecordId: null, routeId: fake.state.routes[0]!.id, dns: "found", ownership: "verified", lastError: null });

    // a later poll of the attached domain re-checks without asking again and writes nothing
    fake.calls.length = 0;
    await syncDomain(e, cfg, d, r, { attach: false });
    expect(writes(fake.calls)).toEqual([]);
  });

  it("a non-proxied record is dns_not_proxied even with confirmTakeover", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-grey", zoneId: "z1", type: "CNAME", name: "www.example.com", content: "host.example.net", proxied: false, comment: null });
    const { d, cf } = await mk("www.example.com", "account", { zone_id: "z1" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true })).rejects.toMatchObject({ code: "dns_not_proxied" });
    expect(writes(fake.calls)).toEqual([]);
  });

  it("a TXT record at the host is not a conflict", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-txt", zoneId: "z1", type: "TXT", name: "go.example.com", content: "v=x", proxied: false, comment: null });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    await syncDomain(e, cfg, d, cf, { attach: true });
    expect(fake.state.dns).toHaveLength(2);
  });

  it("a route bound to another script is route_in_use, with no write", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-theirs", zoneId: "z1", pattern: "go.example.com/*", script: "other" });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true })).rejects.toMatchObject({ code: "route_in_use" });
    expect(writes(fake.calls)).toEqual([]);
  });

  it("a sub-subdomain reports certificate not_covered", async () => {
    installFakeCloudflare({ zones });
    const { d, cf } = await mk("a.b.example.com", "account", { zone_id: "z1" });
    expect((await syncDomain(e, cfg, d, cf, { attach: true })).certificate).toBe("not_covered");
  });

  it("without attach and no route: status only, zero writes, ownership pending", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-theirs", zoneId: "z1", type: "A", name: "www.example.com", content: "192.0.2.1", proxied: true, comment: null });
    const { d, cf } = await mk("www.example.com", "account", { zone_id: "z1" });
    const r = await syncDomain(e, cfg, d, cf, { attach: false });
    expect(writes(fake.calls)).toEqual([]);
    expect(r).toMatchObject({ dns: "found", ownership: "pending", certificate: "issued", lastError: null });
    expect(isVerified(r)).toBe(false);
  });

  it("a hand-made route to this worker reads as verified but is never adopted", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-hand", zoneId: "z1", pattern: "go.example.com/*", script: "lw" });
    fake.state.dns.push({ id: "rec-theirs", zoneId: "z1", type: "A", name: "go.example.com", content: "192.0.2.1", proxied: true, comment: null });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    expect(await syncDomain(e, cfg, d, cf, { attach: false })).toMatchObject({ ownership: "verified", routeId: null });
    const r = await syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true });
    expect(writes(fake.calls)).toEqual([]);
    expect(r).toMatchObject({ routeId: null, dnsRecordId: null });
    await detachDomain(e, cfg, d, r);
    expect(fake.state.routes).toHaveLength(1);
  });

  it("stores the zone id when it was missing", async () => {
    installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.example.com", "account");
    expect((await syncDomain(e, cfg, d, cf, { attach: false })).zoneId).toBe("z1");
  });
});

describe("routeCovers", () => {
  it.each([
    ["shop.owned.test/*", true], ["shop.owned.test/a/*", true], ["*.owned.test/*", true], ["*owned.test/*", true],
    ["*/*", true], ["*", true], ["SHOP.owned.test/*", true], ["https://shop.owned.test/*", true],
    ["owned.test/*", false], ["*.other.test/*", false], ["x.shop.owned.test/*", false], ["*.shop.owned.test/*", false],
  ])("%s -> %s", (pattern, want) => expect(routeCovers(pattern, "shop.owned.test")).toBe(want));
});

describe("syncDomain account: wildcards and delegations (I1)", () => {
  const wild = (proxied: boolean) => ({ id: "rec-wild", zoneId: "zo", type: "A", name: "*.owned.test", content: "192.0.2.9", proxied, comment: null });
  it("a proxied wildcard record needs confirmTakeover; with it only a route is added", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push(wild(true));
    const { d, cf } = await mk("shop.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true })).rejects.toMatchObject({ code: "dns_record_exists" });
    expect(writes(fake.calls)).toEqual([]);
    fake.calls.length = 0;
    const r = await syncDomain(e, cfg, d, (await load(d.id)).cf, { attach: true, confirmTakeover: true });
    expect(writes(fake.calls).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /zones/zo/workers/routes"]);
    expect(fake.state.dns).toEqual([wild(true)]);
    expect(r).toMatchObject({ dnsRecordId: null, dns: "found", ownership: "verified", lastError: null });
  });
  it("a non-proxied wildcard is dns_not_proxied even with confirmTakeover", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push(wild(false));
    const { d, cf } = await mk("shop.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true })).rejects.toMatchObject({ code: "dns_not_proxied" });
    expect(writes(fake.calls)).toEqual([]);
  });
  it("a wildcard two labels up covers a deeper host (no closer name exists)", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push(wild(true));
    const { d, cf } = await mk("a.b.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true })).rejects.toMatchObject({ code: "dns_record_exists" });
    expect(writes(fake.calls)).toEqual([]);
  });
  it("the closest wildcard wins", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push(wild(false), { id: "rec-wb", zoneId: "zo", type: "A", name: "*.b.owned.test", content: "192.0.2.8", proxied: true, comment: null });
    const { d, cf } = await mk("a.b.owned.test", "account", { zone_id: "zo" });
    const r = await syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true });
    expect(writes(fake.calls).map((c) => c.method + " " + c.path)).toEqual(["POST /zones/zo/workers/routes"]);
    expect(r.dns).toBe("found");
  });
  it("an NS record at an ancestor label (delegated subzone) is refused even with confirmTakeover, zero writes", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-ns", zoneId: "zo", type: "NS", name: "b.owned.test", content: "ns1.elsewhere.test", proxied: false, comment: null });
    const { d, cf } = await mk("a.b.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true })).rejects.toMatchObject({ code: "dns_not_proxied" });
    expect(writes(fake.calls)).toEqual([]);
  });
  it("the apex has no parent wildcard to look up", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("owned.test", "account", { zone_id: "zo" });
    await syncDomain(e, cfg, d, cf, { attach: true });
    expect(fake.calls.filter((c) => c.path.includes("dns_records?")).map((c) => c.path)).toEqual(["/zones/zo/dns_records?name=owned.test"]);
  });
  it("a wildcard route to another script is route_in_use with zero writes; one to our worker is fine", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-wild", zoneId: "zo", pattern: "*.owned.test/*", script: "tenant" });
    const { d, cf } = await mk("shop.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true })).rejects.toMatchObject({ code: "route_in_use" });
    expect(writes(fake.calls)).toEqual([]);
    fake.state.routes[0]!.script = "lw";
    await syncDomain(e, cfg, d, (await load(d.id)).cf, { attach: true });
    expect(fake.state.routes.map((x) => x.pattern)).toEqual(["*.owned.test/*", "shop.owned.test/*"]);
  });
  it("an NS record at the host (delegated) is refused even with confirmTakeover, zero writes", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-ns", zoneId: "zo", type: "NS", name: "shop.owned.test", content: "ns1.elsewhere.test", proxied: false, comment: null });
    const { d, cf } = await mk("shop.owned.test", "account", { zone_id: "zo" });
    await expect(syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true })).rejects.toMatchObject({ code: "dns_not_proxied" });
    expect(writes(fake.calls)).toEqual([]);
  });
});

describe("syncDomain account repair (I2)", () => {
  it("after a takeover attach, the owner deleting their record never makes a poll create one", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.dns.push({ id: "rec-theirs", zoneId: "z1", type: "A", name: "www.example.com", content: "192.0.2.1", proxied: true, comment: null });
    const { d, cf } = await mk("www.example.com", "account", { zone_id: "z1" });
    const r = await syncDomain(e, cfg, d, cf, { attach: true, confirmTakeover: true });
    fake.state.dns.length = 0;
    fake.calls.length = 0;
    const r2 = await syncDomain(e, cfg, d, r, { attach: false });
    expect(writes(fake.calls)).toEqual([]);
    expect(r2).toMatchObject({ dns: "missing", dnsRecordId: null });
  });
  it("our own placeholder is re-created by a poll", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    fake.state.dns.length = 0;
    const r2 = await syncDomain(e, cfg, d, r, { attach: false });
    expect(fake.state.dns).toHaveLength(1);
    expect(r2.dnsRecordId).toBe(fake.state.dns[0]!.id);
  });
});

describe("syncDomain error-path save", () => {
  it("a failing error-path save warns without the token and rethrows the original error", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    fake.failNext(/workers\/routes$/, 500); // first match is the route GET
    const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(syncDomain(broken, cfg, d, cf, { attach: true })).rejects.toMatchObject({ status: 500 });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
  });
});

describe("syncDomain concurrency", () => {
  it("two concurrent syncs of a new outside domain end with one hostname, one route and the real ids stored", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    await Promise.allSettled([syncDomain(e, cfg, d, cf, { attach: true }), syncDomain(e, cfg, d, cf, { attach: true })]);
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/custom_hostnames"))).toHaveLength(2); // both raced to create
    expect(fake.state.hostnames).toHaveLength(1);
    expect(fake.state.routes).toHaveLength(1);
    const r = await syncDomain(e, cfg, d, (await load(d.id)).cf, { attach: true });
    expect(r).toMatchObject({ hostnameId: fake.state.hostnames[0]!.id, routeId: fake.state.routes[0]!.id, lastError: null });
  });
});

describe("syncDomain manual", () => {
  it("returns the row unchanged with no calls", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.example.com", "manual");
    expect(await syncDomain(e, cfg, d, cf, { attach: true })).toEqual(cf);
    expect(fake.calls).toEqual([]);
  });
});

describe("detachDomain", () => {
  it("deletes only stored ids and leaves everything else", async () => {
    const fake = installFakeCloudflare({ zones });
    fake.state.routes.push({ id: "r-other", zoneId: "z1", pattern: "x.example.com/*", script: "lw" });
    const { d, cf } = await mk("go.example.com", "account", { zone_id: "z1" });
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    fake.calls.length = 0;
    await detachDomain(e, cfg, d, r);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /zones/z1/workers/routes/${r.routeId}`, `DELETE /zones/z1/dns_records/${r.dnsRecordId}`]);
    expect(fake.state.routes.map((x) => x.id)).toEqual(["r-other"]);
    expect(fake.state.dns).toEqual([]);
  });

  it("outside: route then hostname; a 404 counts as done; other errors reject", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    const r = await syncDomain(e, cfg, d, cf, { attach: true });
    fake.state.routes.length = 0; // already gone: 404
    fake.calls.length = 0;
    await detachDomain(e, cfg, d, r);
    expect(fake.calls.map((c) => c.path)).toEqual([`/zones/saas1/workers/routes/${r.routeId}`, `/zones/saas1/custom_hostnames/${r.hostnameId}`]);
    expect(fake.state.hostnames).toEqual([]);
    fake.failNext(/workers\/routes/, 500);
    await expect(detachDomain(e, cfg, d, r)).rejects.toMatchObject({ status: 500 });
  });

  it("an unadopted, unstored route and hostname are never deleted", async () => {
    const fake = installFakeCloudflare({ zones });
    const { d, cf } = await mk("go.outside.test", "outside");
    await detachDomain(e, cfg, d, cf);
    expect(fake.calls).toEqual([]);
  });
});

describe("isVerified", () => {
  const base = rowToCf({ kind: "outside", errors: "[]", dns: "found", ownership: "verified", certificate: "issued" });
  it("outside needs dns found, ownership verified, certificate issued, no error", () => {
    expect(isVerified(base)).toBe(true);
    for (const p of [{ dns: "unknown" }, { dns: "wrong_target" }, { ownership: "pending" }, { certificate: "pending" }, { certificate: "not_covered" }, { lastError: "cloudflare_500" }] as Partial<CfRow>[])
      expect(isVerified({ ...base, ...p })).toBe(false);
  });
  it("account needs an attach (ownership verified, dns found, no error); not_covered is allowed", () => {
    const a = { ...base, kind: "account" as const, certificate: "not_covered" as const };
    expect(isVerified(a)).toBe(true);
    expect(isVerified({ ...a, ownership: "pending" })).toBe(false);
    expect(isVerified({ ...a, lastError: "route_in_use" })).toBe(false);
  });
  it("manual keeps S1 behaviour", () => expect(isVerified({ ...base, kind: "manual", dns: "unknown", ownership: "unknown" })).toBe(true));
});
