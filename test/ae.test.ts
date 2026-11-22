import { afterEach, describe, expect, it, vi } from "vitest";
import { aeAggregate, aeConfigured, AeError, aeLinkDays, aeQuery, MAX_SQL, sqlId } from "../src/ae";
import type { Env } from "../src/env";

const TOKEN = "ae-SECRET-tok";
const SQL_URL = "https://api.cloudflare.com/client/v4/analytics/sql";
const env = { DB: {}, CACHE: {}, CF_ACCOUNT_ID: "acc1", AE_READ_TOKEN: TOKEN } as unknown as Env;
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
    expect(f.sent[0].body).toEqual({ query: "SELECT 1", params: { a: "b" } });
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

describe("aeAggregate", () => {
  it("refuses a bad id before any request (Review Focus 1)", async () => {
    const f = fake();
    await expect(aeAggregate(env, from, to, "day", { domainIds: ["x' OR 1=1"], linkIds: null })).rejects.toThrow("bad_sql_id");
    await expect(aeAggregate(env, from, to, "day", { domainIds: null, linkIds: ["a b"] })).rejects.toThrow("bad_sql_id");
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("an empty scope list matches nothing without a request", async () => {
    const f = fake();
    expect(await aeAggregate(env, from, to, "day", { domainIds: null, linkIds: [] })).toEqual({ tot: [], dims: [] });
    expect(await aeAggregate(env, from, to, "day", { domainIds: [], linkIds: null })).toEqual({ tot: [], dims: [] });
    expect(f.spy).not.toHaveBeenCalled();
  });

  it("sends five scoped queries with every value bound, none in the SQL text", async () => {
    const f = fake();
    await aeAggregate(env, from, to, "day", { domainIds: ["d1", "d2"], linkIds: ["l1"] });
    expect(f.sent).toHaveLength(5);
    for (const s of f.sent) {
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
      const q = s.body.query;
      expect(q).toContain(`FROM events.analyticsEngine."linkwarren_clicks"`);
      expect(q).toContain("accountTag = $account");
      expect(q).toContain("timestamp >= $from AND timestamp < $to");
      expect(q).toContain("(blob1 = $d0 OR blob1 = $d1)");
      expect(q).toContain("(blob2 = $l0)");
      expect(q).toContain("toStartOfDay(timestamp)");
      // No literals at all: no quotes, only the SQL alphabet, and no input value outside a $param name.
      expect(q).toMatch(/^[A-Za-z0-9_ ,.()$=<>!*"]+$/);
      for (const v of ["d1", "d2", "l1", "acc1", "2026"]) expect(q).not.toMatch(new RegExp(`(?<![$\\w])${v}(?!\\w)`));
      expect(s.body.params).toMatchObject({ account: "acc1", from: "2026-11-18T00:00:00Z", to: "2026-11-20T00:00:00Z", d0: "d1", d1: "d2", l0: "l1" });
    }
  });

  it("uses the configured dataset and the hour bucket, no scope clause when unfiltered", async () => {
    const f = fake();
    await aeAggregate({ ...env, AE_DATASET: "other_ds" }, from, to, "hour", all);
    expect(f.sent).toHaveLength(5);
    for (const s of f.sent) {
      expect(s.body.query).toContain(`FROM events.analyticsEngine."other_ds"`);
      expect(s.body.query).toContain("toStartOfHour(timestamp)");
      expect(s.body.query).not.toMatch(/blob[12] = /);
    }
  });

  it("folds canned rows into TotRow and DimRow", async () => {
    const day = "2026-11-19 00:00:00";
    const at = { bucket: day, domainId: "d1", linkId: "l1" };
    fake((q) => {
      if (q.includes("COUNT(DISTINCT blob9)")) return [{ ...at, n: "2" }];
      if (q.includes("blob4 AS value")) return [{ ...at, value: "CA", n: 4 }, { ...at, value: "US", n: 1 }];
      if (q.includes("blob5 AS value")) return [{ ...at, value: "mobile", n: 5 }];
      if (q.includes("blob6 AS value")) return [{ ...at, value: "", n: 2 }];
      return [
        { ...at, slug: "spring", source: "qr", kind: "human", n: 3 },
        { ...at, slug: "spring", source: "typed", kind: "human", n: "2" },
        { ...at, slug: "spring", source: "typed", kind: "bot", n: 3 },
        { ...at, slug: "spring", source: "qr", kind: "preview", n: 1 },
        { bucket: "2026-11-18T00:00:00Z", domainId: "d1", linkId: "l2", slug: "x", source: "typed", kind: "bot", n: 1 },
      ];
    });
    const r = await aeAggregate(env, from, to, "day", all);
    expect(r.tot).toEqual([
      { bucket: "2026-11-18", domainId: "d1", linkId: "l2", slug: "x", qr: 0, typed: 0, bots: 1, visitors: 0 },
      { bucket: "2026-11-19", domainId: "d1", linkId: "l1", slug: "spring", qr: 3, typed: 2, bots: 4, visitors: 2 },
    ]);
    const d = { bucket: "2026-11-19", domainId: "d1", linkId: "l1" };
    expect(r.dims).toEqual([
      { ...d, dim: "country", value: "CA", clicks: 4 },
      { ...d, dim: "country", value: "US", clicks: 1 },
      { ...d, dim: "device", value: "mobile", clicks: 5 },
      { ...d, dim: "referrer", value: "", clicks: 2 },
    ]);
  });

  it("formats hour buckets as ISO hours", async () => {
    fake((q) => (q.includes("blob3 AS slug") ? [{ bucket: "2026-11-19 13:00:00", domainId: "d1", linkId: "l1", slug: "s", source: "typed", kind: "human", n: 1 }] : []));
    const r = await aeAggregate(env, from, to, "hour", all);
    expect(r.tot[0].bucket).toBe("2026-11-19T13:00:00Z");
  });

  it("an unreadable bucket is an AeError, not a bogus row", async () => {
    fake((q) => (q.includes("blob3 AS slug") ? [{ bucket: "soon", domainId: "d1", linkId: "l1", slug: "s", source: "typed", kind: "human", n: 1 }] : []));
    await expect(aeAggregate(env, from, to, "day", all)).rejects.toMatchObject({ name: "AeError", message: "ae_bad_response" });
  });

  it("filters human, non-empty visitor and typed-only referrers by bound params", async () => {
    const f = fake();
    await aeAggregate(env, from, to, "day", all);
    const qs = f.sent.map((s) => s.body);
    const vis = qs.find((b) => b.query.includes("COUNT(DISTINCT blob9)"))!;
    expect(vis.query).toContain("blob8 = $human AND blob9 != $none");
    expect(vis.params).toMatchObject({ human: "human", none: "" });
    const ref = qs.find((b) => b.query.includes("blob6 AS value"))!;
    expect(ref.query).toContain("blob8 = $human AND blob7 = $typed");
    expect(ref.params).toMatchObject({ typed: "typed" });
    for (const c of ["blob4", "blob5"]) expect(qs.find((b) => b.query.includes(`${c} AS value`))!.query).toContain("blob8 = $human");
  });

  it("any query failing rejects with an AeError", async () => {
    fake(() => [], 403);
    await expect(aeAggregate(env, from, to, "day", all)).rejects.toMatchObject({ name: "AeError", message: "ae_403" });
  });
});

describe("statement size limit", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `link${String(i).padStart(4, "0")}`);
  const linkOf = (p: Record<string, unknown>) => Object.entries(p).filter(([k]) => /^l\d+$/.test(k)).map(([, v]) => String(v));

  it("a 500-id scope splits into statements under the budget and merges the rows", async () => {
    const f = fake((q) => {
      const n = q.includes("blob3 AS slug") ? 1 : 0;
      return n ? [{ bucket: "2026-11-18 00:00:00", domainId: "d1", linkId: "x", slug: "s", source: "typed", kind: "human", n: 1 }] : [];
    });
    const out = await aeAggregate(env, from, to, "day", { domainIds: ["d1"], linkIds: ids });
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    expect(f.sent.length).toBeLessThanOrEqual(10);
    expect(f.sent.length % 5).toBe(0);
    const seen = f.sent.flatMap((s) => linkOf(s.body.params));
    expect(new Set(seen).size).toBe(500);
    expect(out.tot.reduce((a, r) => a + r.typed, 0)).toBe(f.sent.length / 5);
  });

  it("aeLinkDays chunks the same way and concatenates", async () => {
    const f = fake(() => [{ bucket: "2026-11-18 00:00:00", linkId: "a", source: "qr", n: 2 }]);
    const rows = await aeLinkDays(env, from, to, ids);
    expect(f.sent.length).toBeGreaterThan(1);
    for (const s of f.sent) expect(s.body.query.length).toBeLessThan(MAX_SQL);
    expect(new Set(f.sent.flatMap((s) => linkOf(s.body.params))).size).toBe(500);
    expect(rows).toHaveLength(f.sent.length);
  });
});
