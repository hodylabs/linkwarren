import { describe, expect, it, vi } from "vitest";
import { api, ApiError, onSignedOut } from "./api";
import { fakeApi } from "./test/fakeApi";

describe("api", () => {
  it("maps a fetch that throws to ApiError(0, network)", async () => {
    fakeApi({ "GET /api/me": () => { throw new TypeError("Failed to fetch"); } });
    const err = await api("GET", "/api/me").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network" });
  });

  it("maps a JSON error answer to its status and code", async () => {
    fakeApi({ "GET /api/me": () => ({ status: 401, body: { error: "unauthenticated" } }) });
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("an error without a JSON code falls back to http_<status>", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }));
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("a 200 that is not JSON (a login page) counts as network", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>sign in</html>", { status: 200 }));
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("sends JSON with content-type only when there is a body, same-origin credentials", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await api("POST", "/api/links", { slug: "a" });
    await api("DELETE", "/api/links/x");
    const [post, del] = f.mock.calls as unknown as [string, RequestInit][];
    expect(post[1]).toMatchObject({ method: "POST", credentials: "same-origin", body: '{"slug":"a"}' });
    expect(new Headers(post[1].headers).get("content-type")).toBe("application/json");
    expect(del[1].body).toBeUndefined();
    expect(new Headers(del[1].headers).get("content-type")).toBeNull();
  });

  it("a cancel while the body is being read rejects with the AbortError and raises no sign-out", async () => {
    const ctrl = new AbortController();
    let reading!: () => void;
    const bodyStarted = new Promise<void>((r) => (reading = r));
    vi.stubGlobal("fetch", async () => ({
      status: 200,
      ok: true,
      json: () => {
        reading();
        return new Promise((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      },
    }));
    const out = vi.fn();
    const off = onSignedOut(out);
    const p = api("GET", "/api/links", undefined, ctrl.signal).catch((e: unknown) => e);
    await bodyStarted; // headers are in, the body is still being read
    ctrl.abort();
    expect(await p).toMatchObject({ name: "AbortError" });
    expect(out).not.toHaveBeenCalled();
    off();
  });

  it.each(["https://evil.example/api/x", "//evil.example/api/x", "/apix", "api/me"])("refuses the non-API path %s before fetching", async (p) => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const err = (await api("GET", p).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.message).toContain("/api/");
    expect(f).not.toHaveBeenCalled();
  });

  it("204 resolves undefined", async () => {
    fakeApi({ "DELETE /api/links/x": () => ({ status: 204 }) });
    await expect(api("DELETE", "/api/links/x")).resolves.toBeUndefined();
  });

  it("an aborted request rethrows the abort, not network", async () => {
    vi.stubGlobal("fetch", async (_: unknown, init: RequestInit) => { init.signal?.throwIfAborted(); return new Response("{}"); });
    const ac = new AbortController();
    ac.abort();
    const err = (await api("GET", "/api/me", undefined, ac.signal).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.name).toBe("AbortError");
  });

  it("tells signed-out listeners about 0 and 401 only", async () => {
    const seen = vi.fn();
    const off = onSignedOut(seen);
    fakeApi({
      "GET /api/a": () => { throw new TypeError("x"); },
      "GET /api/b": () => ({ status: 401, body: { error: "unauthenticated" } }),
      "GET /api/c": () => ({ status: 403, body: { error: "forbidden" } }),
    });
    for (const p of ["/api/a", "/api/b", "/api/c"]) await api("GET", p).catch(() => {});
    off();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
