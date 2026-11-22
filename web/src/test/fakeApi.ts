import { vi } from "vitest";

export type FakeReq = { method: string; url: URL; body: unknown };
/** `signIn`: the answer an expired Access session gives a `redirect: "manual"` fetch (an opaque redirect to the login page). */
export type FakeRes = { status?: number; body?: unknown; signIn?: boolean };
export type FakeRoutes = Record<string, (req: FakeReq) => FakeRes | Promise<FakeRes>>;

/**
 * Test only. Stubs `fetch` with handlers keyed "METHOD /path" (no query). Unknown routes answer 404 not_found.
 * A handler that throws makes fetch reject, which is how a dropped connection looks; `{ signIn: true }` is a login redirect.
 */
export function fakeApi(routes: FakeRoutes): { calls: { method: string; path: string; body: unknown }[] } {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), location.origin);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const handler = routes[`${method} ${url.pathname}`];
    const res = handler ? await handler({ method, url, body }) : { status: 404, body: { error: "not_found" } };
    if (res.signIn) return Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" });
    const status = res.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(res.body ?? {}), { status, headers: { "content-type": "application/json" } });
  });
  return { calls };
}
