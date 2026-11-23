import { afterEach, describe, expect, it, vi } from "vitest";

// BASE is read once at module load, so each case sets the meta, then loads fresh modules (React and RTL too, so hooks share one React).
async function load(content: string | null) {
  document.head.querySelectorAll('meta[name="lw-base"]').forEach((m) => m.remove());
  if (content !== null) {
    const m = document.createElement("meta");
    m.name = "lw-base";
    m.content = content;
    document.head.append(m);
  }
  vi.resetModules();
  return {
    base: await import("./base"),
    router: await import("./router"),
    api: await import("./api"),
    settings: await import("./settings/api"),
    next: await import("./signin/next"),
    rtl: await import("@testing-library/react"),
  };
}

afterEach(() => document.head.querySelectorAll('meta[name="lw-base"]').forEach((m) => m.remove()));

describe("BASE", () => {
  it.each([
    ["/dashboard", "/dashboard"], ["/go", "/go"], [null, ""], ["", ""], ["/evil/x", ""], ["//x", ""], ["/Dashboard", ""], ["/dashboard/", ""],
    ["https://evil.example", ""], ["/" + "a".repeat(33), ""],
  ])("meta %j gives %j", async (content, want) => {
    expect((await load(content)).base.BASE).toBe(want);
  });

  it("withBase and stripBase", async () => {
    const { withBase, stripBase } = (await load("/dashboard")).base;
    expect(withBase("/links")).toBe("/dashboard/links");
    expect(withBase("/")).toBe("/dashboard/");
    expect([stripBase("/dashboard/links"), stripBase("/dashboard"), stripBase("/dashboard/"), stripBase("/dashboardx"), stripBase("/x")]).toEqual(
      ["/links", "/", "/", "/dashboardx", "/x"],
    );
  });

  it("host mode: both are the identity", async () => {
    const { withBase, stripBase } = (await load(null)).base;
    expect([withBase("/links"), stripBase("/links")]).toEqual(["/links", "/links"]);
  });
});

describe("under a /dashboard base", () => {
  it("navigate pushes the prefixed path and NavLink links to it", async () => {
    const { router, rtl } = await load("/dashboard");
    router.navigate("/links");
    expect(location.pathname).toBe("/dashboard/links");
    router.navigate("/people?sel=u1", { replace: true });
    expect(location.pathname + location.search).toBe("/dashboard/people?sel=u1");
    const { container, unmount } = rtl.render(router.NavLink({ to: "/domains", children: "D" }));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/dashboard/domains");
    unmount();
  });

  it("useRoute reads the inner path", async () => {
    const { router, rtl } = await load("/dashboard");
    history.replaceState(null, "", "/dashboard/domains/x?sel=1");
    const { result, unmount } = rtl.renderHook(() => router.useRoute());
    expect([result.current.screen, result.current.sub, result.current.query.get("sel")]).toEqual(["domains", "x", "1"]);
    unmount();
  });

  it("a path outside the base falls back to /links under the base", async () => {
    const { router, rtl } = await load("/dashboard");
    history.replaceState(null, "", "/elsewhere");
    const { unmount } = rtl.renderHook(() => router.useRoute());
    expect(location.pathname).toBe("/dashboard/links");
    unmount();
  });

  it("api() fetches under the base", async () => {
    const { api } = await load("/dashboard");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) => (seen.push(String(u)), Response.json({ ok: true })));
    await api.api("GET", "/api/me");
    expect(seen).toEqual(["/dashboard/api/me"]);
  });

  it("logoUrl is under the base", async () => {
    const { settings } = await load("/dashboard");
    expect([settings.logoUrl(3), settings.logoUrl(null)]).toEqual(["/dashboard/api/instance/logo?v=3", "/dashboard/linkwarren-mark.svg"]);
  });

  it("next refuses a path that leaves the base and goNext prefixes it", async () => {
    const { next } = await load("/dashboard");
    expect([next.isSafeNext("/../hello"), next.isSafeNext("/./../x"), next.isSafeNext("/%2e%2e/x"), next.isSafeNext("/links?q=1")]).toEqual([false, false, false, true]);
    const assign = vi.spyOn(next.nav, "assign").mockImplementation(() => {});
    next.goNext("/domains?sel=d1");
    next.goNext("/../hello");
    expect(assign.mock.calls).toEqual([["/dashboard/domains?sel=d1"], ["/dashboard/"]]);
  });

  it("a next that already carries the base is stripped once, never doubled (R9, same as the server's safeNext)", async () => {
    const { next } = await load("/dashboard");
    const assign = vi.spyOn(next.nav, "assign").mockImplementation(() => {});
    for (const n of ["/dashboard/agents?sel=1", "/agents?sel=1", "/dashboard", "/dashboard?x=1", "/dashboard#a", "/dashboard//evil.example", "/dashboard/../hello", "/dashboardx"]) next.goNext(n);
    expect(assign.mock.calls.map((c) => c[0])).toEqual([
      "/dashboard/agents?sel=1", "/dashboard/agents?sel=1", "/dashboard/", "/dashboard/?x=1", "/dashboard/#a", "/dashboard/", "/dashboard/", "/dashboard/dashboardx",
    ]);
  });

  it("host mode leaves a /dashboard next alone", async () => {
    const { next } = await load(null);
    const assign = vi.spyOn(next.nav, "assign").mockImplementation(() => {});
    next.goNext("/dashboard/agents");
    expect(assign.mock.calls).toEqual([["/dashboard/agents"]]);
  });
});
