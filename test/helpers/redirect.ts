// Direct handleRedirect harness (S4): a fake CLICKS dataset and ctx, and `cf` on the Request init is honoured.
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import { handleRedirect } from "../../src/redirect";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
let n = 0;
export const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
export const now = () => Math.floor(Date.now() / 1000);

/** One domain with one link `spring` -> https://dest.test/x; `routes` is the stored JSON, `password` the stored hash. */
export async function seed(o: Record<string, unknown> = {}) {
  const i = ++n;
  const d = { host: `go${i}.test`, id: `cd${i}`, link: `cl${i}` };
  await run("INSERT OR IGNORE INTO users (id,email,role,status,created_at) VALUES ('u1','o@x.com','owner','active',1)");
  await run(
    "INSERT INTO domains (id,host,type,status,owner_id,bare_redirect,noindex,case_sensitive,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    d.id, d.host, "main", o.status ?? "active", "u1", "https://bare.test/", 1, 0, 1,
  );
  await run(
    "INSERT INTO links (id,domain_id,slug,slug_key,url,redirect_code,starts_at,expires_at,pass_query,password_hash,routes,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    d.link, d.id, "spring", "spring", "https://dest.test/x", 302, o.starts ?? null, o.expires ?? null, o.pass ?? 1,
    o.password ?? null, o.routes === undefined ? "[]" : JSON.stringify(o.routes), "u1", "u1", 1, 1,
  );
  return d;
}

export type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
export function harness(o: { clicks?: boolean; ctx?: boolean; salt?: string | null; throws?: boolean } = {}) {
  const points: Point[] = [];
  const pending: Promise<unknown>[] = [];
  const fake = {
    writeDataPoint(p: Point) {
      if (o.throws) throw new Error("boom");
      points.push(p);
    },
  };
  const e: Env = { ...env, VISITOR_SALT: o.salt === null ? undefined : (o.salt ?? "test-salt") };
  if (o.clicks !== false) e.CLICKS = fake as unknown as AnalyticsEngineDataset;
  const ctx = o.ctx === false ? undefined : { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const go = async (host: string, path: string, init: RequestInit & { cf?: unknown } = {}, hook?: { req(r: Request): void; returned(): void }) => {
    const req = new Request(`https://${host}${path}`, init as RequestInit);
    hook?.req(req);
    const r = await handleRedirect(req, e, now(), ctx);
    hook?.returned();
    await Promise.all(pending);
    return r;
  };
  return { points, go };
}
export const visit = (headers: Record<string, string> = {}) => ({
  cf: { country: "ca" },
  headers: { "user-agent": IPHONE, referer: "https://www.instagram.com/p/1", "cf-connecting-ip": "203.0.113.7", ...headers },
});
