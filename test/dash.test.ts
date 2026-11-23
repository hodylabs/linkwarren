import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dash, dashUrl, innerRequest, isDiscoveryPath, reservedSlugs, underPrefix } from "../src/dash";
import type { Env } from "../src/env";
import { call, pathEnv } from "./helpers/path";

const hostEnv = (over: Partial<Env> = {}) => ({ ...env, DASHBOARD_HOST: "dash.test", AUTH_MODE: "app", ...over }) as Env;

afterEach(() => vi.restoreAllMocks());

describe("dash config (R1)", () => {
  it.each([undefined, "", "  "])("DASHBOARD_PATH %j is host mode", (p) => {
    const d = dash(hostEnv({ DASHBOARD_PATH: p }))!;
    expect(d).toMatchObject({ host: "dash.test", prefix: "", origin: "https://dash.test", base: "https://dash.test", legacy: null, pathMode: false });
    expect(d.cookie).toEqual({ name: "__Host-lw_session", path: "/" });
  });

  it.each(["/dashboard", "/d", "/go-2", "/" + "a".repeat(32)])("%j is a valid prefix", (p) => {
    const d = dash(pathEnv({ DASHBOARD_PATH: p }))!;
    expect(d).toMatchObject({ host: "short.test", prefix: p, origin: "https://short.test", base: "https://short.test" + p, pathMode: true });
    expect(d.cookie).toEqual({ name: "__Secure-lw_session", path: p });
  });

  it.each(["dashboard", "/dashboard/", "/Dashboard", "/a/b", "/.well-known", "/-x", "/x-", "/" + "a".repeat(33), " /dashboard", "/da shboard"])(
    "%j is misconfigured, logged by name only",
    (p) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(dash(pathEnv({ DASHBOARD_PATH: p }))).toBeNull();
      expect(log.mock.calls).toEqual([["dashboard config invalid: DASHBOARD_PATH"]]);
    },
  );

  it("path mode refuses AUTH_MODE=access and an unknown mode (R14); host mode does not", () => {
    expect(dash(pathEnv({ AUTH_MODE: "access" }))).toBeNull();
    expect(dash(pathEnv({ AUTH_MODE: "bogus" }))).toBeNull();
    expect(dash(pathEnv({ AUTH_MODE: undefined }))?.pathMode).toBe(true);
    expect(dash(hostEnv({ AUTH_MODE: "access" }))?.pathMode).toBe(false);
  });

  it.each(["short.test", "SHORT.TEST.", "not a host", "x", "1.2.3.4"])("LEGACY_DASHBOARD_HOST %j is misconfigured", (l) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dash(pathEnv({ LEGACY_DASHBOARD_HOST: l }))).toBeNull();
  });

  it("a valid legacy host is normalized; blank is none", () => {
    expect(dash(pathEnv({ LEGACY_DASHBOARD_HOST: "Old.Test." }))?.legacy).toBe("old.test");
    expect(dash(pathEnv({ LEGACY_DASHBOARD_HOST: " " }))?.legacy).toBeNull();
  });

  it("blank DASHBOARD_HOST is misconfigured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dash(hostEnv({ DASHBOARD_HOST: " " }))).toBeNull();
  });

  it("follows a changed env (memo keyed on the raw values)", () => {
    const e = pathEnv();
    expect(dash(e)?.prefix).toBe("/dashboard");
    e.DASHBOARD_PATH = "/d";
    expect(dash(e)?.prefix).toBe("/d");
  });

  it("dashUrl is base + path and throws when misconfigured", () => {
    expect(dashUrl(pathEnv(), "/join")).toBe("https://short.test/dashboard/join");
    expect(dashUrl(hostEnv(), "/join")).toBe("https://dash.test/join");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => dashUrl(pathEnv({ DASHBOARD_PATH: "x" }), "/")).toThrow();
  });

  it("reservedSlugs: the prefix segment on the dashboard host in path mode only", () => {
    expect(reservedSlugs(pathEnv(), "short.test")).toEqual(["dashboard"]);
    expect(reservedSlugs(pathEnv(), "other.test")).toEqual([]);
    expect(reservedSlugs(hostEnv(), "dash.test")).toEqual([]);
  });
});

describe("misconfigured answers", () => {
  it.each(["https://other.test/x", "https://short.test/hello", "https://short.test/dashboard/healthz", "https://old.test/x"])(
    "%s answers 500 misconfigured",
    async (url) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      for (const over of [{ DASHBOARD_PATH: "/Dashboard" }, { LEGACY_DASHBOARD_HOST: "short.test" }, { AUTH_MODE: "access" }]) {
        const r = await call(url, undefined, pathEnv(over));
        expect([r.status, await r.json()]).toEqual([500, { error: "misconfigured" }]);
      }
    },
  );
});

describe("underPrefix", () => {
  it.each([
    ["/dashboard", true], ["/dashboard/", true], ["/dashboard/x", true],
    ["/dashboardx", false], ["/Dashboard", false], ["/%64ashboard", false], ["//dashboard", false], ["/dashboard%2fx", false], ["/", false],
  ])("%s -> %s", (p, want) => expect(underPrefix(p, "/dashboard")).toBe(want));
  it("an empty prefix covers everything", () => expect(underPrefix("/anything", "")).toBe(true));
});

describe("innerRequest", () => {
  it("host mode returns the request itself", () => {
    const req = new Request("https://dash.test/x");
    expect(innerRequest(req, dash(hostEnv())!)).toBe(req);
  });
  it("path mode strips the prefix and keeps method, headers, body and query", async () => {
    const d = dash(pathEnv())!;
    const r = innerRequest(new Request("https://short.test/dashboard/api/x?q=1", { method: "POST", headers: { "x-a": "1" }, body: "hi" }), d)!;
    expect([r.url, r.method, r.headers.get("x-a"), await r.text()]).toEqual(["https://short.test/api/x?q=1", "POST", "1", "hi"]);
    expect(innerRequest(new Request("https://short.test/dashboard"), d)!.url).toBe("https://short.test/");
    expect(innerRequest(new Request("https://short.test/dashboard/"), d)!.url).toBe("https://short.test/");
    expect(innerRequest(new Request("https://short.test/dashboardx"), d)).toBeNull();
  });
});

describe("isDiscoveryPath", () => {
  it.each([
    ["/.well-known/oauth-authorization-server", true], ["/.well-known/oauth-protected-resource/dashboard/mcp", true],
    ["/.well-known/openid-configuration", true], ["/.well-known/openid-configuration/x", true],
    ["/.well-known/security.txt", false], ["/oauth-x", false], ["/.WELL-KNOWN/oauth-x", false],
  ])("%s -> %s", (p, want) => expect(isDiscoveryPath(p)).toBe(want));
});
