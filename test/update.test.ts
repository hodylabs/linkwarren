import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUpdate, LATEST_URL, newer, parseVersion, releaseUrl } from "../src/update";
import { VERSION } from "../src/version";
import worker from "../src/index";
import { dash, setupAccess, tokenFor } from "./helpers/access";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const NOW = Date.parse("2026-11-22T00:15:00Z") / 1000;
const REL = "https://github.com/hodylabs/linkwarren/releases/tag/v99.0.0";
const stored = async () => {
  const r = await env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = 'updates.latest'").first<{ value: string; updated_at: number }>();
  return r ? { ...JSON.parse(r.value), at: r.updated_at } : null;
};
const seed = (v: object) => run("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('updates.latest', ?, 1, 'system')", JSON.stringify(v));
function stubGh(res: () => Response | Promise<Response>) {
  const reqs: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url !== LATEST_URL) throw new Error("unexpected fetch");
    reqs.push(req);
    return res();
  });
  return reqs;
}
const release = (o: Record<string, unknown> = {}) => () => Response.json({ tag_name: "v99.0.0", html_url: REL, published_at: "2026-11-21T10:00:00Z", draft: false, prerelease: false, ...o });

beforeAll(setupAccess);
beforeEach(() => env.DB.prepare("DELETE FROM settings").run());
afterEach(() => vi.restoreAllMocks());

describe("semver", () => {
  it("parses x.y.z with an optional v, nothing else", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.3.0")).toEqual([0, 3, 0]);
    for (const bad of ["1.2", "1.2.3-rc.1", "1.2.3.4", "x1.2.3", " 1.2.3", "", "01.2.3x", "1.2.3\n"]) expect(parseVersion(bad)).toBeNull();
  });
  it("newer is strict: newer true, equal and older false, invalid false", () => {
    expect(newer("0.4.0", "0.3.0")).toBe(true);
    expect(newer("0.3.1", "0.3.0")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.10.0", "0.9.0")).toBe(true);
    expect(newer("0.3.0", "0.3.0")).toBe(false);
    expect(newer("0.2.9", "0.3.0")).toBe(false);
    expect(newer("banana", "0.3.0")).toBe(false);
    expect(newer("0.4.0", "nope")).toBe(false);
  });
});

describe("releaseUrl", () => {
  it("accepts only https github.com under /hodylabs/linkwarren/releases/", () => {
    expect(releaseUrl(REL)).toBe(REL);
    for (const bad of [
      "http://github.com/hodylabs/linkwarren/releases/tag/v1.0.0",
      "https://github.com.evil.test/hodylabs/linkwarren/releases/tag/v1.0.0",
      "https://evil.test/github.com/hodylabs/linkwarren/releases/",
      "https://github.com/hodylabs/linkwarren-evil/releases/tag/v1.0.0",
      "https://github.com/hodylabs/linkwarren/releases/../../../evil/x",
      "https://user@github.com/hodylabs/linkwarren/releases/tag/v1.0.0",
      "https://github.com:8443/hodylabs/linkwarren/releases/tag/v1.0.0",
      "https://github.com/other/linkwarren/releases/tag/v1.0.0",
      "javascript:alert(1)//github.com/hodylabs/linkwarren/releases/",
      "not a url",
      42,
      null,
    ]) expect(releaseUrl(bad)).toBeNull();
  });
});

describe("checkUpdate", () => {
  it("stores a valid release once, with a fixed User-Agent and no identifying header", async () => {
    const reqs = stubGh(release());
    vi.spyOn(console, "log").mockImplementation(() => {});
    await checkUpdate(env, NOW);
    expect(await stored()).toEqual({ version: "99.0.0", url: REL, publishedAt: "2026-11-21T10:00:00Z", checkedAt: NOW, at: NOW });
    expect(reqs).toHaveLength(1);
    const h = Object.fromEntries(reqs[0]!.headers);
    expect(h).toEqual({ "user-agent": "linkwarren-update-check", accept: "application/vnd.github+json" });
    expect(reqs[0]!.method).toBe("GET");
  });

  it("does not write when the release is unchanged", async () => {
    stubGh(release());
    vi.spyOn(console, "log").mockImplementation(() => {});
    await seed({ version: "99.0.0", url: REL, publishedAt: "2026-11-21T10:00:00Z", checkedAt: 5 });
    await checkUpdate(env, NOW);
    expect(await stored()).toEqual({ version: "99.0.0", url: REL, publishedAt: "2026-11-21T10:00:00Z", checkedAt: 5, at: 1 });
  });

  const OLD = { version: "0.3.1", url: "https://github.com/hodylabs/linkwarren/releases/tag/v0.3.1", publishedAt: null, checkedAt: 5 };
  it.each([
    ["404 (no releases yet)", () => new Response("{}", { status: 404 }), "update_http_404"],
    ["500", () => new Response("x", { status: 500 }), "update_http_500"],
    ["rate limit", () => new Response("{}", { status: 403 }), "update_http_403"],
    ["bad JSON", () => new Response("{nope", { status: 200 }), "update_bad_json"],
    ["invalid tag", release({ tag_name: "v1.0.0-beta.1" }), "update_bad_release"],
    ["no tag", release({ tag_name: undefined }), "update_bad_release"],
    ["bad URL", release({ html_url: "https://evil.test/hodylabs/linkwarren/releases/tag/v99.0.0" }), "update_bad_release"],
    ["prerelease", release({ prerelease: true }), "update_bad_release"],
    ["network", () => Promise.reject(new TypeError("boom secret detail")), "update_network"],
  ])("keeps the old value on %s and logs a fixed code only", async (_n, res, code) => {
    stubGh(res as () => Response);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await seed(OLD);
    await expect(checkUpdate(env, NOW)).resolves.toBeUndefined();
    expect(await stored()).toEqual({ ...OLD, at: 1 });
    expect(err).toHaveBeenCalledWith("update check failed", code);
  });

  it("does nothing when updates.check is off: no fetch, no write", async () => {
    const reqs = stubGh(release());
    await run("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('updates.check', 'false', 1, 'uo')");
    await checkUpdate(env, NOW);
    expect(reqs).toHaveLength(0);
    expect(await stored()).toBeNull();
  });

  it("runs from scheduled only in the 00:15 UTC run", async () => {
    const reqs = stubGh(release());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const at = (iso: string) => ({ cron: "15 * * * *", scheduledTime: Date.parse(iso), noRetry() {} }) as ScheduledController;
    await worker.scheduled(at("2026-11-22T13:15:00Z"), env, ctx);
    expect(reqs).toHaveLength(0);
    await worker.scheduled(at("2026-11-22T00:15:00Z"), env, ctx);
    expect(reqs).toHaveLength(1);
    expect((await stored())?.version).toBe("99.0.0");
  });
});

describe("GET /api/instance update", () => {
  const get = async (email: string) => (await (await dash("/api/instance", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email) } })).json()) as { update: unknown };
  beforeEach(async () => {
    await env.DB.batch(["users", "roles"].map((t) => env.DB.prepare(t === "roles" ? "DELETE FROM roles WHERE builtin = 0" : `DELETE FROM ${t}`)));
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('st','Settings','[\"settings\"]',0,1,1)");
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('uo','owner@example.com','owner',NULL,'active',1), ('ua','a@example.com','member',NULL,'active',1), ('us','s@example.com','member','st','active',1)");
  });

  it("owners and settings holders see a newer release; a member does not", async () => {
    await seed({ version: "99.0.0", url: REL, publishedAt: null, checkedAt: 5 });
    const want = { current: VERSION, latest: "99.0.0", url: REL };
    expect((await get("owner@example.com")).update).toEqual(want);
    expect((await get("s@example.com")).update).toEqual(want);
    expect((await get("a@example.com")).update).toBeNull();
  });

  it("null when the stored release is not newer, missing, has a bad URL, or the check is off", async () => {
    expect((await get("owner@example.com")).update).toBeNull();
    await seed({ version: VERSION, url: REL, publishedAt: null, checkedAt: 5 });
    expect((await get("owner@example.com")).update).toBeNull();
    await run("UPDATE settings SET value = ? WHERE key = 'updates.latest'", JSON.stringify({ version: "0.0.1", url: REL, publishedAt: null, checkedAt: 5 }));
    expect((await get("owner@example.com")).update).toBeNull();
    await run("UPDATE settings SET value = ? WHERE key = 'updates.latest'", JSON.stringify({ version: "99.0.0", url: "https://evil.test/hodylabs/linkwarren/releases/x", publishedAt: null, checkedAt: 5 }));
    expect((await get("owner@example.com")).update).toBeNull();
    await run("UPDATE settings SET value = ? WHERE key = 'updates.latest'", JSON.stringify({ version: "99.0.0", url: REL, publishedAt: null, checkedAt: 5 }));
    await run("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('updates.check', 'false', 1, 'uo')");
    expect((await get("owner@example.com")).update).toBeNull();
  });
});

describe("PATCH /api/settings updatesCheck", () => {
  const patch = async (email: string, body: unknown) =>
    dash("/api/settings", { method: "PATCH", headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeEach(async () => {
    await env.DB.batch(["users", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await run("DELETE FROM roles WHERE builtin = 0");
    await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('st','Settings','[\"settings\"]',0,1,1), ('dt','Data','[\"data\"]',0,1,1)");
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES ('uo','owner@example.com','owner',NULL,'active',1), ('us','s@example.com','member','st','active',1), ('ud','d@example.com','member','dt','active',1)");
  });

  it("defaults on; a settings holder turns it off and on, audited; a role without settings is refused", async () => {
    const get = await dash("/api/settings", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("owner@example.com") } });
    expect(((await get.json()) as { updatesCheck: boolean }).updatesCheck).toBe(true);
    const off = await patch("s@example.com", { updatesCheck: false });
    expect([off.status, ((await off.json()) as { updatesCheck: boolean }).updatesCheck]).toEqual([200, false]);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'updates.check'").first<{ value: string }>())?.value).toBe("false");
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'settings.update' AND target_id = 'updates.check'").first<{ n: number }>())?.n).toBe(1);
    const refused = await patch("d@example.com", { updatesCheck: true });
    expect([refused.status, await refused.json()]).toEqual([403, { error: "forbidden" }]);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'updates.check'").first<{ value: string }>())?.value).toBe("false");
    expect((await patch("owner@example.com", { updatesCheck: true })).status).toBe(200);
    expect((await patch("owner@example.com", { updatesCheck: "yes" })).status).toBe(400);
  });
});
