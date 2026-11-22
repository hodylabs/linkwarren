import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import type { Env } from "../src/env";
import { links } from "../src/api/links";
import { domains } from "../src/api/domains";
import { analytics } from "../src/api/analytics";
import { resolveScope } from "../src/analytics";
import { FULL_GRANT, type Grant } from "../src/principal";
import { rowToUser, type UserRow } from "../src/types";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const one = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const EMAIL: Record<string, string> = { uo: "owner@example.com", ua: "a@example.com" };

/** Test-only app: the routes behind a principal set in-process, the way /api/v1 will set it. */
function as(userId: string, grant: Grant) {
  const a = new Hono<{ Bindings: Env; Variables: { user: UserRow; grant: Grant } }>();
  a.use("*", async (c, next) => {
    c.set("user", rowToUser((await one<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", userId))!));
    c.set("grant", grant);
    await next();
  });
  a.route("/api/links", links);
  a.route("/api/domains", domains);
  a.route("/api/analytics", analytics);
  return (method: string, path: string, body?: unknown) => a.request(`https://dash.test${path}`, {
    method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  }, env);
}
const restricted = (domains: string[], via: string | null = "Claude"): Grant => ({ write: true, del: true, domains, via });

async function dashCall(who: string, method: string, path: string, body?: unknown) {
  return dash(path, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(EMAIL[who]!), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["links", "slug_locks", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const [id, role] of [["uo", "owner"], ["ua", "member"]])
    await run("INSERT INTO users (id,email,role,status,created_at) VALUES (?,?,?,'active',1)", id, EMAIL[id], role);
  const dom = (id: string, host: string, type: string) =>
    run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES (?,?,?,'active','uo',1)", id, host, type);
  await dom("dA", "a.test", "main");
  await dom("dB", "b.test", "main");
  await dom("dS", "s.test", "shared");
  await run("INSERT INTO domain_members (domain_id,user_id) VALUES ('dS','ua')");
  const ln = (id: string, d: string, by: string) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'https://x.com/',?,?,1,1)", id, d, id, id, by, by);
  await ln("la", "dA", "ua");
  await ln("lb", "dB", "ua");
  await ln("ls", "dS", "ua");
});

const ids = async (r: Response) => ((await r.json()) as { items: { id: string }[] }).items.map((l) => l.id).sort();

describe("FULL_GRANT", () => {
  it("is unrestricted with no via", () => {
    expect(FULL_GRANT).toEqual({ write: true, del: true, domains: null, via: null });
  });
});

describe("restricted grant: domains", () => {
  it("list without domain returns only allowed domains' links, for the owner and a member", async () => {
    expect(await ids(await as("uo", restricted(["dA"]))("GET", "/api/links"))).toEqual(["la"]);
    expect(await ids(await as("ua", restricted(["dA", "dS"]))("GET", "/api/links"))).toEqual(["la", "ls"]);
    // Unknown ids add nothing; [] allows nothing.
    expect(await ids(await as("ua", restricted(["dB", "nope"]))("GET", "/api/links"))).toEqual(["lb"]);
    expect(await ids(await as("ua", restricted([]))("GET", "/api/links"))).toEqual([]);
    // Unrestricted owner still sees everything.
    expect(await ids(await as("uo", FULL_GRANT)("GET", "/api/links"))).toEqual(["la", "lb", "ls"]);
  });

  it("list and /check on a disallowed domain: 403", async () => {
    const call = as("uo", restricted(["dA"]));
    expect((await call("GET", "/api/links?domain=dB")).status).toBe(403);
    expect((await call("GET", "/api/links/check?domain=dB&slug=x")).status).toBe(403);
    expect((await call("GET", "/api/links/check?domain=dA&slug=x")).status).toBe(200);
  });

  it("domains GET / lists only the allowed domains", async () => {
    const r = await as("uo", restricted(["dA", "dS"]))("GET", "/api/domains");
    expect(((await r.json()) as { id: string }[]).map((d) => d.id).sort()).toEqual(["dA", "dS"]);
  });

  it("analytics/links?ids= for a link on a disallowed domain is refused", async () => {
    const call = as("uo", restricted(["dA"]));
    expect((await call("GET", "/api/analytics/links?ids=lb")).status).toBe(403);
    expect((await call("GET", "/api/analytics/links?ids=la,lb")).status).toBe(403);
    expect((await call("GET", "/api/analytics/links?ids=la")).status).toBe(200);
  });

  it("resolveScope honours the restriction, for the owner too", async () => {
    const owner = rowToUser((await one<Record<string, unknown>>("SELECT * FROM users WHERE id = 'uo'"))!);
    expect(await resolveScope(env, owner, null, "", ["dA"])).toEqual({ scope: { domainIds: ["dA"], linkIds: null }, truncated: false });
    expect(await resolveScope(env, owner, ["dB"], "", ["dA"])).toEqual({ error: "forbidden" });
    expect(await resolveScope(env, owner, null, "", null)).toEqual({ scope: { domainIds: null, linkIds: null }, truncated: false });
  });

  it("POST on a disallowed domain 403; PATCH and DELETE of a link there 403", async () => {
    const call = as("ua", restricted(["dA"]));
    expect((await call("POST", "/api/links", { domainId: "dB", slug: "n", url: "https://x.com" })).status).toBe(403);
    expect((await call("PATCH", "/api/links/lb", { url: "https://y.com" })).status).toBe(403);
    expect((await call("DELETE", "/api/links/lb")).status).toBe(403);
    expect(await one("SELECT 1 FROM links WHERE id = 'lb' AND url = 'https://x.com/'")).not.toBeNull();
  });
});

describe("audit via", () => {
  const vias = async (action: string) =>
    (await env.DB.prepare("SELECT via FROM audit_log WHERE action = ?").bind(action).all<{ via: string | null }>()).results.map((r) => r.via);

  it("writes made with via 'Claude' audit via = 'Claude' in the same batch", async () => {
    const call = as("ua", restricted(["dA"]));
    const r = await call("POST", "/api/links", { domainId: "dA", slug: "new", url: "https://x.com" });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await call("PATCH", `/api/links/${id}`, { url: "https://y.com" })).status).toBe(200);
    expect((await call("DELETE", `/api/links/${id}`)).status).toBe(204);
    expect([await vias("link.create"), await vias("link.update"), await vias("link.delete")]).toEqual([["Claude"], ["Claude"], ["Claude"]]);
    expect(await one("SELECT 1 FROM audit_log WHERE actor_id = 'ua' AND action = 'link.create'")).not.toBeNull();
  });

  it("dashboard writes keep via NULL", async () => {
    const r = await dashCall("ua", "POST", "/api/links", { domainId: "dA", slug: "fromdash", url: "https://x.com" });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await dashCall("ua", "PATCH", `/api/links/${id}`, { url: "https://y.com" })).status).toBe(200);
    expect((await dashCall("ua", "DELETE", `/api/links/${id}`)).status).toBe(204);
    expect([await vias("link.create"), await vias("link.update"), await vias("link.delete")]).toEqual([[null], [null], [null]]);
  });
});
