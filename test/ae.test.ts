import { afterEach, describe, expect, it, vi } from "vitest";
import { aeConfigured, aeDay, AeError, aeLinkDays, aeQuery, aeReport, MAX_SQL, ROW_CAP, sqlId } from "../src/ae";
import type { Env } from "../src/env";

const TOKEN = "ae-SECRET-tok";
const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const env = { DB: {}, CACHE: {}, CLICKS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: TOKEN } as unknown as Env;
const from = new Date("2026-11-18T00:00:00Z");
const to = new Date("2026-11-20T00:00:00Z");
const all = { domainIds: null, linkIds: null };

type Sent = { auth: string | null; body: { query: string; params: Record<string, unknown> } };
/** Fetch fake: only POST to the SQL endpoint answers; `reply` picks canned rows per query; unknown URLs throw. */
function fake(reply: (q: string) => unknown[] = () => [], status = 200) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== SQL_URL || init?.method !== "POST") throw new Error(`unexpected fetch ${init?.method} ${url}`);
    const body = JSON.parse(String(init.body));
    sent.push({ auth: new Headers(init.headers).get("authorization"), body });
    if (status !== 200) return new Response(`denied for ${TOKEN}`, { status });
    const data = reply(body.query);
    return Response.json({ data, rows: data.length, statistics: {} });
  });
  return { sent, spy };
}
afterEach(() => vi.restoreAllMocks());

describe("sqlId", () => {
  it("quotes a safe id", () => expect(sqlId("ab-1_C")).toBe("'ab-1_C'"));
  it("refuses anything else", () => {
    for (const v of ["x' OR '1'='1", "a b", "", "a".repeat(65)]) expect(() => sqlId(v)).toThrow("bad_sql_id");
  });
});

describe("aeConfigured", () => {
  it("needs account and token, blanks count as unset", () => {
    expect(aeConfigured(env)).toBe(true);
    expect(aeConfigured({ ...env, AE_READ_TOKEN: " " })).toBe(false);
    expect(aeConfigured({ ...env, CF_ACCOUNT_ID: undefined })).toBe(false);
  });
  it("is off without the CLICKS binding even with a token (nothing is recorded, so nothing to read)", () => {
    expect(aeConfigured({ ...env, CLICKS: undefined })).toBe(false);
  });
  it("validates the dataset name", () => {
    expect(aeConfigured({ ...env, AE_DATASET: "my_clicks" })).toBe(true);
    expect(aeConfigured({ ...env, AE_DATASET: "x;DROP" })).toBe(false);
    expect(aeConfigured({ ...env, AE_DATASET: 'a"b' })).toBe(false);
  });
});

describe("aeQuery", () => {
  it("posts JSON with bound params and the bearer token, returns data", async () => {
    const f = fake(() => [{ n: 1 }]);
    expect(await aeQuery(env, "SELECT 1", { a: "b" })).toEqual([{ n: 1 }]);
    expect(f.sent[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(f.sent[0].body).toEqual({ query: `SELECT 1 LIMIT ${ROW_CAP + 1}`, params: { a: "b" } });
  });
  it("a capped answer is an AeError, never a silently partial result", async () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({ n: 1 }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: rows(ROW_CAP + 1) }));
    await expect(aeQuery(env, "SELECT 1", {})).rejects.toMatchObject({ name: "AeError", message: "ae_truncated" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: rows(3), rows: 5 }));
    await expect(aeQuery(env, "SELECT 1", {})).rejects.toMatchObject({ message: "ae_truncated" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: rows(3), rows: 3, rows_before_limit_at_least: 9 }));
    await expect(aeQuery(env, "SELECT 1", {})).rejects.toMatchObject({ message: "ae_truncated" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: rows(ROW_CAP), rows: ROW_CAP }));
    expect(await aeQuery(env, "SELECT 1", {})).toHaveLength(ROW_CAP);
  });
  it("non-2xx rejects with ae_<status> and never leaks the token", async () => {
    fake(() => [], 500);
    const e = await aeQuery(env, "SELECT 1", {}).catch((x) => x);
    expect(e).toBeInstanceOf(AeError);
    expect(e.message).toBe("ae_500");
    expect(JSON.stringify(e) + String(e) + e.stack).not.toContain(TOKEN);
  });
  it("a network failure or timeout is an AeError without the cause text", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException(`timed out ${TOKEN}`, "TimeoutError"));
    const e = await aeQuery(env, "SELECT 1", {}).catch((x) => x);
    expect(e).toBeInstanceOf(AeError);
    expect(e.message).toBe("ae_timeout");
    expect(String(e) + e.stack).not.toContain(TOKEN);
  });
  it("a body without a data array is an AeError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ errors: [] }));
    await expect(aeQuery(env, "SELECT 1", {})).rejects.toMatchObject({ name: "AeError", message: "ae_bad_response" });
  });
  it("not configured is an AeError and sends nothing", async () => {
    const f = fake();
    await expect(aeQuery({ ...env, AE_DATASET: "x;DROP" }, "SELECT 1", {})).rejects.toMatchObject({ name: "AeError", message: "ae_off" });
    expect(f.spy).not.toHaveBeenCalled();
  });
});

const cur = new Date("2026-11-19T00:00:00Z");
const isSeries = (q: string) => q.includes("countIf(blob8 = $human AND blob7 = $qr)") && q.includes("AS bucket");

describe("aeReport", () => {
  it("refuses a bad id before any request (Review Focus 1)", async () => {
    const f = fake();
    await expect(aeReport(env, from, cur, to, "day", { domainIds: ["x' OR 1=1"], linkIds: null })).rejects.toThrow("bad_sql_id");
    await expect(aeReport(env, from, cur, to, "day", { domainIds: null, linkIds: ["a b"] })).rejects.toThrow("bad_sql_id");
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("an empty scope list matches nothing without a request", async () => {
    const f = fake();
    const none = { days: [], links: [], dims: [] };
    expect(await aeReport(env, from, cur, to, "day", { domainIds: null, linkIds: [] })).toEqual(none);
    expect(await aeReport(env, from, cur, to, "day", { domainIds: [], linkIds: null })).toEqual(none);
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("sends six queries with every value bound, none in the SQL text; links keep the domain clause", async () => {
    const f = fake();
    await aeReport(env, from, cur, to, "day", { domainIds: ["d1", "d2"], linkIds: ["l1"] });
    expect(f.sent).toHaveLength(6);
    for (const s of f.sent) {
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
      const q = s.body.query;
      expect(q).toContain(`FROM events.analyticsEngine."linkwarren_clicks"`);
      expect(q).toContain("accountTag = $account");
      expect(q).toMatch(/timestamp >= \$(from|cur) AND timestamp < \$to/);
      expect(q).toContain("(blob2 = $l0)");
      // A moved link's older points keep their domain: the domain clause stays next to the link clause.
      expect(q).toContain("(blob1 = $d0 OR blob1 = $d1)");
      expect(q).toMatch(/LIMIT \d+$/);
      // No literals at all: no quotes, only the SQL alphabet, and no input value outside a $param name.
      expect(q).toMatch(/^[A-Za-z0-9_ ,.()$=<>!*"]+$/);
      for (const v of ["d1", "d2", "l1", "acc1", "2026"]) expect(q).not.toMatch(new RegExp(`(?<![$\\w])${v}(?!\\w)`));
      expect(s.body.params).toMatchObject({ account: "acc1", from: "2026-11-18T00:00:00Z", cur: "2026-11-19T00:00:00Z", to: "2026-11-20T00:00:00Z", l0: "l1", d0: "d1", d1: "d2" });
    }
    // Series and visitors span the whole read; links and dims only the current window.
    expect(f.sent.filter((s) => s.body.query.includes("$from"))).toHaveLength(2);
    expect(f.sent.filter((s) => s.body.query.includes("$cur"))).toHaveLength(4);
  });

  it("a domain scope is a bound blob1 clause", async () => {
    const f = fake();
    await aeReport(env, from, cur, to, "day", { domainIds: ["d1", "d2"], linkIds: null });
    for (const s of f.sent) expect(s.body.query).toContain("(blob1 = $d0 OR blob1 = $d1)");
  });

  it("groups in SQL: by bucket, by link, by value, never bucket x link (I1)", async () => {
    const f = fake();
    await aeReport({ ...env, AE_DATASET: "other_ds" }, from, cur, to, "hour", all);
    const groups = f.sent.map((s) => s.body.query.replace(/ LIMIT \d+$/, "").split(" GROUP BY ")[1]).sort();
    expect(groups).toEqual(["blob2, blob1", "blob4", "blob5", "blob6", "toStartOfHour(timestamp)", "toStartOfHour(timestamp)"]);
    for (const s of f.sent) {
      expect(s.body.query).toContain(`FROM events.analyticsEngine."other_ds"`);
      expect(s.body.query).not.toMatch(/blob[12] = /);
    }
  });

  it("maps the summed rows and adds them up across chunks", async () => {
    const day = "2026-11-19 00:00:00";
    fake((q) => {
      if (q.includes("COUNT(DISTINCT blob9)")) return [{ bucket: day, n: "2" }];
      if (q.includes("blob4 AS value")) return [{ value: "CA", n: 4 }, { value: "US", n: 1 }];
      if (q.includes("blob5 AS value")) return [{ value: "mobile", n: 5 }];
      if (q.includes("blob6 AS value")) return [{ value: "", n: 2 }];
      if (q.includes("blob2 AS linkId")) return [{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 5 }];
      return [{ bucket: day, qr: 3, typed: "2", bots: 4 }, { bucket: "2026-11-18T00:00:00Z", qr: 0, typed: 0, bots: 1 }];
    });
    const r = await aeReport(env, from, cur, to, "day", all);
    expect(r.days).toEqual([
      { bucket: "2026-11-19", qr: 3, typed: 2, bots: 4, visitors: 2 },
      { bucket: "2026-11-18", qr: 0, typed: 0, bots: 1, visitors: 0 },
    ]);
    expect(r.links).toEqual([{ linkId: "l1", domainId: "d1", slug: "spring", clicks: 5 }]);
    expect(r.dims).toEqual([
      { dim: "country", value: "CA", clicks: 4 },
      { dim: "country", value: "US", clicks: 1 },
      { dim: "device", value: "mobile", clicks: 5 },
      { dim: "referrer", value: "", clicks: 2 },
    ]);
  });

  it("formats hour buckets as ISO hours; an unreadable bucket is an AeError", async () => {
    fake((q) => (isSeries(q) ? [{ bucket: "2026-11-19 13:00:00", qr: 0, typed: 1, bots: 0 }] : []));
    expect((await aeReport(env, from, cur, to, "hour", all)).days[0].bucket).toBe("2026-11-19T13:00:00Z");
    vi.restoreAllMocks();
    fake((q) => (isSeries(q) ? [{ bucket: "soon", qr: 0, typed: 1, bots: 0 }] : []));
    await expect(aeReport(env, from, cur, to, "day", all)).rejects.toMatchObject({ name: "AeError", message: "ae_bad_response" });
  });

  it("filters human, non-empty visitor and typed-only referrers by bound params", async () => {
    const f = fake();
    await aeReport(env, from, cur, to, "day", all);
    const qs = f.sent.map((s) => s.body);
    const vis = qs.find((b) => b.query.includes("COUNT(DISTINCT blob9)"))!;
    expect(vis.query).toContain("blob8 = $human AND blob9 != $none");
    expect(vis.params).toMatchObject({ human: "human", none: "", qr: "qr", typed: "typed" });
    expect(qs.find((b) => b.query.includes("blob6 AS value"))!.query).toContain("blob8 = $human AND blob7 = $typed");
    for (const c of ["blob4", "blob5", "blob2 AS linkId"]) expect(qs.find((b) => b.query.includes(c))!.query).toContain("blob8 = $human");
  });

  it("no current window inside the read: only series and visitors are queried", async () => {
    const f = fake();
    await aeReport(env, from, to, to, "day", all);
    expect(f.sent).toHaveLength(2);
  });

  it("any query failing rejects with an AeError", async () => {
    fake(() => [], 403);
    await expect(aeReport(env, from, cur, to, "day", all)).rejects.toMatchObject({ name: "AeError", message: "ae_403" });
  });
});

describe("aeDay", () => {
  it("one UTC day, grouped to exactly the rollup rows", async () => {
    const f = fake((q) => {
      // l1 moved from d1 to d2 that day: each domain keeps its own clicks, visitors and dim rows.
      if (q.includes("COUNT(DISTINCT blob9)")) return [{ linkId: "l1", domainId: "d1", n: 2 }, { linkId: "l1", domainId: "d2", n: 1 }];
      if (q.includes("blob4 AS value")) return [{ linkId: "l1", domainId: "d1", value: "CA", n: 4 }, { linkId: "l1", domainId: "d2", value: "CA", n: 1 }];
      if (q.includes("argMax(blob3")) return [
        { linkId: "l1", domainId: "d1", slug: "spring", qr: 3, typed: 2, bots: 4 }, { linkId: "l1", domainId: "d2", slug: "spring", qr: 1, typed: 0, bots: 0 },
        { linkId: "l2", domainId: "d1", slug: "x", qr: 0, typed: 0, bots: 1 },
      ];
      return [];
    });
    const r = await aeDay(env, "2026-11-18");
    expect(f.sent).toHaveLength(5);
    for (const s of f.sent) expect(s.body.params).toMatchObject({ from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z" });
    const groups = f.sent.map((s) => s.body.query.replace(/ LIMIT \d+$/, "").split(" GROUP BY ")[1]).sort();
    expect(groups).toEqual(["blob2, blob1", "blob2, blob1", "blob2, blob1, blob4", "blob2, blob1, blob5", "blob2, blob1, blob6"]);
    for (const s of f.sent) expect(s.body.query).not.toContain("argMax(blob1");
    expect(r.tot).toEqual([
      { linkId: "l1", domainId: "d1", slug: "spring", qr: 3, typed: 2, bots: 4, visitors: 2 },
      { linkId: "l1", domainId: "d2", slug: "spring", qr: 1, typed: 0, bots: 0, visitors: 1 },
      { linkId: "l2", domainId: "d1", slug: "x", qr: 0, typed: 0, bots: 1, visitors: 0 },
    ]);
    expect(r.dims).toEqual([
      { linkId: "l1", domainId: "d1", dim: "country", value: "CA", clicks: 4 },
      { linkId: "l1", domainId: "d2", dim: "country", value: "CA", clicks: 1 },
    ]);
  });
});

describe("statement size limit", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `link${String(i).padStart(4, "0")}`);
  const linkOf = (p: Record<string, unknown>) => Object.entries(p).filter(([k]) => /^l\d+$/.test(k)).map(([, v]) => String(v));

  it("a 500-id scope splits into statements under the budget and sums the rows", async () => {
    const f = fake((q) => (isSeries(q) ? [{ bucket: "2026-11-18 00:00:00", qr: 0, typed: 1, bots: 0 }] : []));
    const out = await aeReport(env, from, cur, to, "day", { domainIds: ["d1"], linkIds: ids });
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    expect(f.sent.length).toBe(12);
    const seen = f.sent.flatMap((s) => linkOf(s.body.params));
    expect(new Set(seen).size).toBe(500);
    expect(out.days).toEqual([{ bucket: "2026-11-18", qr: 0, typed: 2, bots: 0, visitors: 0 }]);
  });

  it("a repeated id is sent once", async () => {
    const f = fake();
    await aeReport(env, from, cur, to, "day", { domainIds: null, linkIds: ["a", "b", "a", "b"] });
    expect(new Set(f.sent.map((s) => linkOf(s.body.params).join(",")))).toEqual(new Set(["a,b"]));
  });

  it("a bad id in a later chunk sends nothing at all", async () => {
    const f = fake();
    await expect(aeReport(env, from, cur, to, "day", { domainIds: null, linkIds: [...ids, "bad id"] })).rejects.toThrow("bad_sql_id");
    await expect(aeLinkDays(env, from, to, [...ids, "bad id"])).rejects.toThrow("bad_sql_id");
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("a member's 1000 usable domains are chunked too (M2)", async () => {
    const doms = Array.from({ length: 1000 }, (_, i) => `dom${String(i).padStart(4, "0")}`);
    const f = fake();
    await aeReport(env, from, cur, to, "day", { domainIds: doms, linkIds: null });
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    const seen = f.sent.flatMap((s) => Object.entries(s.body.params).filter(([k]) => /^d\d+$/.test(k)).map(([, v]) => v));
    expect(new Set(seen).size).toBe(1000);
    expect(f.sent.length % 6).toBe(0);
  });

  it("both lists at scale: every statement under the budget, every (link, domain) pair sent exactly once; too many is refused unsent", async () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `dom${String(i).padStart(4, "0")}`);
    const f = fake();
    await expect(aeReport(env, from, cur, to, "day", { domainIds: huge, linkIds: ids })).rejects.toMatchObject({ message: "ae_scope_too_big" });
    expect(f.spy).not.toHaveBeenCalled();
    const doms = huge.slice(0, 300);
    await aeReport(env, from, cur, to, "day", { domainIds: doms, linkIds: ids });
    expect(f.sent.length).toBeLessThanOrEqual(36);
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    const pairs = new Set<string>();
    for (const s of f.sent.filter((x) => x.body.query.includes("AS bucket, countIf"))) {
      const d = Object.entries(s.body.params).filter(([k]) => /^d\d+$/.test(k)).map(([, v]) => v);
      for (const l of linkOf(s.body.params)) for (const x of d) {
        expect(pairs.has(`${l}|${x}`)).toBe(false);
        pairs.add(`${l}|${x}`);
      }
    }
    expect(pairs.size).toBe(500 * 300);
  });

  it("aeLinkDays keeps a domain clause when given one, none when null", async () => {
    const f = fake();
    await aeLinkDays(env, from, to, ["a"], ["d1"]);
    await aeLinkDays(env, from, to, ["a"]);
    expect(f.sent.map((s) => s.body.query.includes("(blob1 = $d0)"))).toEqual([true, false]);
    expect(await aeLinkDays(env, from, to, ["a"], [])).toEqual([]);
    expect(f.sent).toHaveLength(2);
  });

  it("aeLinkDays chunks the same way and concatenates", async () => {
    const f = fake(() => [{ bucket: "2026-11-18 00:00:00", linkId: "a", qr: 2, typed: 1 }]);
    const rows = await aeLinkDays(env, from, to, ids);
    expect(f.sent.length).toBeGreaterThan(1);
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    expect(new Set(f.sent.flatMap((s) => linkOf(s.body.params))).size).toBe(500);
    expect(rows).toHaveLength(f.sent.length);
    expect(rows[0]).toEqual({ bucket: "2026-11-18", linkId: "a", qr: 2, typed: 1 });
  });
});
