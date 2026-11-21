import { expect, vi } from "vitest";

type Json = Record<string, unknown>;
export type FakeZone = { id: string; name: string; accountName?: string };

/**
 * In-memory Cloudflare API + DoH. Install with `vi.spyOn(globalThis, "fetch").mockImplementation((i, init) => fake.handle(new Request(i, init)))`
 * (see installFakeCloudflare). Unknown URLs throw so a test can never reach the real API.
 * Error shapes mirror measured live behaviour: 403 code 10000 for a missing permission (POST workers/routes: 403 with no code),
 * 401 code 10000 for a bad token, 400 for validation, 404 code 10003 for a missing ruleset entrypoint, 404 code 1551 for an unset fallback origin.
 */
export function fakeCloudflare(opts: { zones?: FakeZone[]; doh?: Record<string, string[]> } = {}) {
  let seq = 0;
  const nid = (p: string) => `${p}${++seq}`;
  const state = {
    zones: [...(opts.zones ?? [])],
    dns: [] as { id: string; zoneId: string; type: string; name: string; content: string; proxied: boolean; comment: string | null }[],
    routes: [] as { id: string; zoneId: string; pattern: string; script: string }[],
    hostnames: [] as { id: string; hostname: string; status: string; ssl: { status: string; validation_errors?: { message: string }[] }; verification_errors?: string[] }[],
    fallbackOrigin: null as string | null,
    rulesets: {} as Record<string, unknown>, // `${zoneId}/${phase}` -> ruleset
    /** DoH answers keyed `TYPE:name`, e.g. "CNAME:go.example.com" -> ["edge.test"]. */
    doh: { ...(opts.doh ?? {}) } as Record<string, string[]>,
  };
  /** Every fetch the fake did not recognise (it also throws). Assert empty with assertNoUnexpected(). */
  const unexpected: string[] = [];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const failures: { re: RegExp; status: number; body?: unknown }[] = [];

  const ok = (result: unknown, info?: Json) => json(200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
  const err = (status: number, code?: number) => json(status, { success: false, errors: [code === undefined ? { message: "error" } : { code, message: "error" }], messages: [], result: null });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      const type = url.searchParams.get("type") ?? "";
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      const num = { A: 1, CNAME: 5, AAAA: 28 }[type] ?? 0;
      const answers = state.doh[`${type}:${name}`] ?? [];
      return json(200, { Status: 0, ...(answers.length ? { Answer: answers.map((data) => ({ name, type: num, TTL: 60, data })) } : {}) });
    }
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith("/client/v4/")) {
      unexpected.push(`${req.method} ${req.url}`);
      throw new Error(`fakeCloudflare: unexpected fetch ${req.method} ${req.url}`);
    }
    const path = url.pathname.slice("/client/v4".length);
    const text = await req.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: path + url.search, body });
    const fi = failures.findIndex((f) => f.re.test(path + url.search));
    if (fi >= 0) {
      const f = failures.splice(fi, 1)[0]!;
      return json(f.status, f.body ?? { success: false, errors: [{ code: 10000, message: "error" }], messages: [], result: null });
    }
    if (!req.headers.get("authorization")?.startsWith("Bearer ")) return err(401, 10000);
    const m = req.method;
    const b = (body ?? {}) as Json;

    if (m === "GET" && path === "/zones") {
      const name = url.searchParams.get("name");
      const hit = state.zones.filter((z) => z.name === name).map((z) => ({ id: z.id, name: z.name, account: { name: z.accountName ?? null } }));
      return ok(hit, { total_count: hit.length });
    }
    let r: RegExpMatchArray | null;
    if ((r = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      const [, zoneId, id] = r;
      if (m === "GET") return ok(state.dns.filter((d) => d.zoneId === zoneId && d.name === url.searchParams.get("name")));
      if (m === "POST") {
        if (typeof b.name !== "string" || typeof b.type !== "string") return err(400, 9000);
        const rec = { id: nid("dns"), zoneId: zoneId!, type: b.type, name: b.name, content: String(b.content), proxied: b.proxied === true, comment: typeof b.comment === "string" ? b.comment : null };
        state.dns.push(rec);
        return ok(rec);
      }
      if (m === "DELETE") return remove(state.dns, (d) => d.id === id && d.zoneId === zoneId);
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/))) {
      const [, zoneId, id] = r;
      if (m === "GET") return ok(state.routes.filter((x) => x.zoneId === zoneId));
      if (m === "POST") {
        if (typeof b.pattern !== "string" || typeof b.script !== "string") return err(400, 10022);
        const rec = { id: nid("route"), zoneId: zoneId!, pattern: b.pattern, script: b.script };
        state.routes.push(rec);
        return ok(rec);
      }
      if (m === "DELETE") return remove(state.routes, (x) => x.id === id && x.zoneId === zoneId);
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/custom_hostnames\/fallback_origin$/))) {
      if (m === "GET") return state.fallbackOrigin ? ok({ origin: state.fallbackOrigin, status: "active" }) : err(404, 1551);
      if (m === "PUT") {
        if (typeof b.origin !== "string") return err(400, 1407);
        state.fallbackOrigin = b.origin;
        return ok({ origin: b.origin, status: "pending_deployment" });
      }
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/custom_hostnames(?:\/([^/]+))?$/))) {
      const id = r[2];
      if (m === "GET") {
        const h = url.searchParams.get("hostname");
        const rows = state.hostnames.filter((x) => !h || x.hostname === h);
        return ok(url.searchParams.get("per_page") === "1" ? rows.slice(0, 1) : rows, { total_count: rows.length });
      }
      if (m === "POST") {
        if (typeof b.hostname !== "string") return err(400, 1407);
        const rec = { id: nid("ch"), hostname: b.hostname, status: "pending", ssl: { status: "pending_validation" } };
        state.hostnames.push(rec);
        return ok(rec);
      }
      if (m === "DELETE") return remove(state.hostnames, (x) => x.id === id);
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/rulesets\/phases\/([^/]+)\/entrypoint$/))) {
      const key = `${r[1]}/${r[2]}`;
      if (m === "GET") return key in state.rulesets ? ok(state.rulesets[key]) : err(404, 10003);
      if (m === "PUT") return ok((state.rulesets[key] = { id: nid("rs"), ...b }));
    }
    unexpected.push(`${m} ${path}`);
    throw new Error(`fakeCloudflare: unhandled ${m} ${path}`);
  }

  function remove<T>(arr: T[], pred: (x: T) => boolean): Response {
    const i = arr.findIndex(pred);
    if (i < 0) return err(404, 7003);
    arr.splice(i, 1);
    return ok({ id: "deleted" });
  }

  return { handle, state, calls, unexpected, assertNoUnexpected: () => expect(unexpected).toEqual([]), failNext: (re: RegExp, status: number, body?: unknown) => void failures.push({ re, status, body }) };
}

let installed: ReturnType<typeof fakeCloudflare> | null = null;
/** Call from afterEach: fails the test if the installed fake saw an unknown URL, even one the code under test swallowed. */
export function assertNoUnexpectedCloudflareCalls() {
  const f = installed;
  installed = null;
  f?.assertNoUnexpected();
}

export function installFakeCloudflare(opts?: Parameters<typeof fakeCloudflare>[0]) {
  const fake = fakeCloudflare(opts);
  installed = fake;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => fake.handle(new Request(input as RequestInfo, init)));
  return fake;
}
