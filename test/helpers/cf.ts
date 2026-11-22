import { expect, vi } from "vitest";

type Json = Record<string, unknown>;
export type FakeZone = { id: string; name: string; accountName?: string };
export type FakePerm = "zone_read" | "dns_edit" | "routes_edit" | "ssl_edit";
/** With `tokens`, only listed bearer values are valid and each write/zone read needs its permission. Without it any bearer has every permission. */
export type FakeToken = { perms: FakePerm[]; status?: string; userOwned?: boolean };

/**
 * In-memory Cloudflare API + DoH. Install with `vi.spyOn(globalThis, "fetch").mockImplementation((i, init) => fake.handle(new Request(i, init)))`
 * (see installFakeCloudflare). Unknown URLs throw so a test can never reach the real API.
 * Rulesets: phase entrypoints with rules (foreign ones have no linkwarren ref), rule POST/PATCH/DELETE, create refused when the entrypoint exists and a per-zone rate limit cap (shapes assumed, not measured).
 * Error shapes mirror measured live behaviour: 403 code 10000 for a missing permission (POST workers/routes: 403 with no code),
 * 401 code 10000 for a bad token, duplicates rejected (DNS name+type 400 81058, route pattern 409 10020, custom hostname 409 1406), 400 for validation, 404 code 10003 for a missing ruleset entrypoint, 404 code 1551 for an unset fallback origin.
 */
export function fakeCloudflare(opts: { zones?: FakeZone[]; doh?: Record<string, string[]>; tokens?: Record<string, FakeToken> } = {}) {
  let seq = 0;
  const nid = (p: string) => `${p}${++seq}`;
  const state = {
    zones: [...(opts.zones ?? [])],
    dns: [] as { id: string; zoneId: string; type: string; name: string; content: string; proxied: boolean; comment: string | null }[],
    routes: [] as { id: string; zoneId: string; pattern: string; script: string }[],
    hostnames: [] as { id: string; hostname: string; status: string; ssl: { status: string; validation_errors?: { message: string }[] }; verification_errors?: string[] }[],
    fallbackOrigin: null as string | null,
    fallbackStatus: "active",
    /** `${zoneId}/${phase}` -> entrypoint ruleset. Rules without a `ref` model ones another tool made. */
    rulesets: {} as Record<string, { id: string; kind: string; phase: string; rules: (Json & { id: string; ref?: string })[] }>,
    /** Rate limiting rules allowed per zone (Free plan: 1). Over it, POST answers 400 with `planLimitCode` (undefined = no code). */
    ratelimitMax: Infinity,
    planLimitCode: undefined as number | undefined,
    /** DoH answers keyed `TYPE:name`, e.g. "CNAME:go.example.com" -> ["edge.test"]. */
    doh: { ...(opts.doh ?? {}) } as Record<string, string[]>,
  };
  /** Every fetch the fake did not recognise (it also throws). Assert empty with assertNoUnexpected(). */
  const unexpected: string[] = [];
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
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
    const auth = req.headers.get("authorization");
    calls.push({ method: req.method, path: path + url.search, body, auth });
    const fi = failures.findIndex((f) => f.re.test(path + url.search));
    if (fi >= 0) {
      const f = failures.splice(fi, 1)[0]!;
      if (f.status === 0) throw new TypeError("network connection lost"); // what cf() sees as unreachable or over the subrequest limit
      return json(f.status, f.body ?? { success: false, errors: [{ code: 10000, message: "error" }], messages: [], result: null });
    }
    if (!auth?.startsWith("Bearer ")) return err(401, 10000);
    const m = req.method;
    const b = (body ?? {}) as Json;
    const tok = opts.tokens ? opts.tokens[auth.slice(7)] : { perms: ["zone_read", "dns_edit", "routes_edit", "ssl_edit"] as FakePerm[] };
    let r: RegExpMatchArray | null;

    // Measured live: an account verify for a user-owned (or unknown) token answers 401 code 1000.
    if (m === "GET" && (r = path.match(/^\/(?:accounts\/[^/]+|user)\/tokens\/verify$/))) {
      if (!tok || (path.startsWith("/user") !== !!tok.userOwned)) return err(401, 1000);
      return ok({ id: "tok1", status: tok.status ?? "active" });
    }
    if (!tok) return err(401, 10000);
    // Live shapes: 403 code 10000 for a missing permission; POST workers/routes 403 carries no code.
    const need = (p: FakePerm) => (tok.perms.includes(p) ? null : p === "routes_edit" ? err(403) : err(403, p === "zone_read" ? 9109 : 10000));
    const zoneOut = (z: FakeZone) => ({ id: z.id, name: z.name, account: { name: z.accountName ?? null } });

    if (m === "GET" && path === "/zones") {
      const denied = need("zone_read");
      if (denied) return denied;
      const name = url.searchParams.get("name");
      const hit = state.zones.filter((z) => name === null || z.name === name).map(zoneOut);
      return ok(hit.slice(0, Number(url.searchParams.get("per_page") ?? 50)), { total_count: hit.length });
    }
    if (m === "GET" && (r = path.match(/^\/zones\/([^/]+)$/))) {
      const denied = need("zone_read");
      if (denied) return denied;
      const z = state.zones.find((x) => x.id === r![1]);
      return z ? ok(zoneOut(z)) : err(404, 7003);
    }
    if (m === "POST") {
      const p: FakePerm | null = /\/dns_records$/.test(path) ? "dns_edit" : /\/workers\/routes$/.test(path) ? "routes_edit" : /\/custom_hostnames$/.test(path) ? "ssl_edit" : null;
      const denied = p && need(p);
      if (denied) return denied;
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      const [, zoneId, id] = r;
      if (m === "GET") return ok(state.dns.filter((d) => d.zoneId === zoneId && d.name === url.searchParams.get("name")));
      if (m === "POST") {
        if (typeof b.name !== "string" || typeof b.type !== "string") return err(400, 9000);
        if (state.dns.some((d) => d.zoneId === zoneId && d.name === b.name && d.type === b.type)) return err(400, 81058);
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
        if (typeof b.pattern !== "string" || !b.pattern || typeof b.script !== "string") return err(400, 10022);
        if (state.routes.some((x) => x.zoneId === zoneId && x.pattern === b.pattern)) return err(409, 10020);
        const rec = { id: nid("route"), zoneId: zoneId!, pattern: b.pattern, script: b.script };
        state.routes.push(rec);
        return ok(rec);
      }
      if (m === "DELETE") return remove(state.routes, (x) => x.id === id && x.zoneId === zoneId);
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/custom_hostnames\/fallback_origin$/))) {
      if (m === "GET") return state.fallbackOrigin ? ok({ origin: state.fallbackOrigin, status: state.fallbackStatus }) : err(404, 1551);
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
        if (typeof b.hostname !== "string" || !b.hostname) return err(400, 1407);
        if (state.hostnames.some((x) => x.hostname === b.hostname)) return err(409, 1406);
        const rec = { id: nid("ch"), hostname: b.hostname, status: "pending", ssl: { status: "pending_validation" } };
        state.hostnames.push(rec);
        return ok(rec);
      }
      if (m === "DELETE") return remove(state.hostnames, (x) => x.id === id);
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/rulesets\/phases\/([^/]+)\/entrypoint$/))) {
      const key = `${r[1]}/${r[2]}`;
      if (m === "GET") return key in state.rulesets ? ok(state.rulesets[key]) : err(404, 10003);
      if (m === "PUT") return ok((state.rulesets[key] = { id: nid("rs"), kind: "zone", phase: r[2]!, rules: ((b.rules ?? []) as Json[]).map((x) => ({ id: nid("rule"), ...x })) }));
    }
    // Create a zone ruleset: a second entrypoint for the same phase is refused (unverified live: shape assumed 400).
    if (m === "POST" && (r = path.match(/^\/zones\/([^/]+)\/rulesets$/))) {
      const key = `${r[1]}/${b.phase}`;
      if (b.kind !== "zone" || typeof b.phase !== "string") return err(400, 20003);
      if (key in state.rulesets) return err(400, 20080);
      const rules = (b.rules ?? []) as Json[];
      if (b.phase === "http_ratelimit" && rules.length > state.ratelimitMax) return err(400, state.planLimitCode);
      return ok((state.rulesets[key] = { id: nid("rs"), kind: "zone", phase: b.phase, rules: rules.map((x) => ({ id: nid("rule"), ...x })) }));
    }
    if ((r = path.match(/^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/))) {
      const [, zoneId, rsId, ruleId] = r;
      const key = Object.keys(state.rulesets).find((k) => k.startsWith(`${zoneId}/`) && state.rulesets[k]!.id === rsId);
      if (!key) return err(404, 10003);
      const rs = state.rulesets[key]!;
      if (m === "POST" && !ruleId) {
        if (rs.phase === "http_ratelimit" && rs.rules.length >= state.ratelimitMax) return err(400, state.planLimitCode);
        rs.rules.push({ id: nid("rule"), ...b });
        return ok(rs);
      }
      const i = rs.rules.findIndex((x) => x.id === ruleId);
      if (i < 0) return err(404, 10003);
      if (m === "PATCH") return (rs.rules[i] = { ...b, id: ruleId! }), ok(rs);
      if (m === "DELETE") return rs.rules.splice(i, 1), ok(rs);
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
