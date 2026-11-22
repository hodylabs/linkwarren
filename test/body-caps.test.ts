import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dash } from "./helpers/access";
import { signedIn, withCookie } from "./helpers/session";

const e = env as unknown as Record<string, string | undefined>;
const prevMode = e.AUTH_MODE;
const big = "a".repeat(20_000);
let cookie: string;
beforeEach(async () => {
  e.AUTH_MODE = "app";
  e.SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32)));
  await env.DB.batch(["sessions", "links", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const o = await signedIn("owner@example.com", { role: "owner" });
  cookie = o.cookie;
  await env.DB.prepare("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('d1','go.test','main','active',?,1)").bind(o.user.id).run();
});
afterEach(() => { e.AUTH_MODE = prevMode; e.SECRETS_KEY = undefined; });

// Every free-text field in a dashboard JSON body has a zod .max(), so an oversized string is refused before any other work.
const cases: [string, string, unknown][] = [
  ["POST", "/api/links", { domainId: "d1", slug: "x", url: `https://x.test/${big}` }],
  ["POST", "/api/links", { domainId: "d1", slug: big, url: "https://x.test/" }],
  ["POST", "/api/links", { domainId: big, slug: "x", url: "https://x.test/" }],
  ["POST", "/api/links", { domainId: "d1", slug: "x", url: "https://x.test/", routes: [{ url: big }] }],
  ["POST", "/api/links", { domainId: "d1", slug: "x", url: "https://x.test/", routes: [{ countries: [big], url: "https://y.test/" }] }],
  ["POST", "/api/domains", { host: big, type: "private" }],
  ["PATCH", "/api/domains/d1", { bareRedirect: big }],
  ["PATCH", "/api/domains/d1", { notfoundRedirect: big }],
  ["PATCH", "/api/domains/d1", { reservedExtra: [big] }],
  ["POST", "/api/import?dryRun=1", { mainHost: "go.test", domains: [], links: [{ host: null, slug: "x", destination: `https://x.test/${big}`, enabled: true }] }],
  ["POST", "/api/import?dryRun=1", { mainHost: "go.test", domains: [{ host: big }], links: [] }],
  ["PUT", "/api/settings/secrets/resend", { value: `re_${big}` }],
];

describe("body string caps", () => {
  it.each(cases)("%s %s with an oversized string is 400 invalid_body", async (method, path, body) => {
    const r = await dash(path, withCookie(cookie, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect([r.status, await r.json()]).toEqual([400, { error: "invalid_body" }]);
  });
});
