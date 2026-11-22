import { z } from "zod";
import { cf, CfError, type CfConfig } from "./api";

type Key = "zone_read" | "dns_edit" | "routes_edit" | "ssl_edit" | "config_rules_edit" | "waf_edit";
type State = "ok" | "missing" | "unknown";

export const PERMISSIONS: readonly { key: Key; label: string; why: string; group: "core" | "outside" | "controls" }[] = [
  { key: "zone_read", label: "Zone, Zone, Read", why: "See which domains are in this account", group: "core" },
  { key: "dns_edit", label: "Zone, DNS, Edit", why: "Point your domains at linkwarren", group: "core" },
  { key: "routes_edit", label: "Zone, Workers Routes, Edit", why: "Send each domain's traffic to the app", group: "core" },
  { key: "ssl_edit", label: "Zone, SSL and Certificates, Edit", why: "Add outside domains with a CNAME (Cloudflare for SaaS)", group: "outside" },
  { key: "config_rules_edit", label: "Zone, Config Rules, Edit", why: "Security level per domain", group: "controls" },
  { key: "waf_edit", label: "Zone, Zone WAF, Edit", why: "Rate limit per domain", group: "controls" },
];

const AUTH_CODES = new Set([9109, 10000]);
/** R6, calibrated live: any 401/403 is missing (POST workers/routes 403 has no code); 400 with non-auth codes means the permission let the request through to validation. */
export function classifyProbe(status: number, codes: number[]): State {
  if (status === 401 || status === 403) return "missing";
  if (status === 400) return codes.some((c) => AUTH_CODES.has(c)) ? "missing" : "ok";
  return "unknown";
}

/** Runs a probe that must fail; a success (never expected) or a non-Cloudflare error is unknown. */
const probe = (p: Promise<unknown>): Promise<State> =>
  p.then(() => "unknown" as const, (e) => (e instanceof CfError ? classifyProbe(e.status, e.codes) : "unknown"));

const zoneS = z.object({ id: z.string(), account: z.object({ name: z.string().nullish() }).nullish() });
/** One account zone: the SaaS zone if set, else the first listed. Throws CfError when Cloudflare refuses. */
export async function sampleZone(cfg: CfConfig): Promise<{ id: string; accountName: string | null } | null> {
  const res = cfg.saasZoneId
    ? [(await cf(cfg, "GET", `/zones/${encodeURIComponent(cfg.saasZoneId)}`)).result]
    : (await cf(cfg, "GET", `/zones?account.id=${encodeURIComponent(cfg.accountId)}&per_page=1`)).result;
  const z0 = z.array(zoneS).safeParse(res);
  if (!z0.success) throw new CfError(200);
  const first = z0.data[0];
  return first ? { id: first.id, accountName: first.account?.name ?? null } : null;
}

const verifyS = z.object({ status: z.string() });
async function verify(cfg: CfConfig): Promise<boolean> {
  const get = async (path: string) => verifyS.safeParse((await cf(cfg, "GET", path)).result).data?.status === "active";
  try {
    try {
      return await get(`/accounts/${encodeURIComponent(cfg.accountId)}/tokens/verify`);
    } catch (e) {
      // Account verify only knows account-owned tokens; a user token answers 404 or 401 code 1000 there.
      if (!(e instanceof CfError && (e.status === 404 || (e.status === 401 && e.codes.includes(1000))))) throw e;
      return await get("/user/tokens/verify");
    }
  } catch (e) {
    if (e instanceof CfError && e.status >= 400 && e.status < 500) return false;
    throw e; // Cloudflare down or unreachable: not a verdict on the token
  }
}

/** Never writes (R6): edit permissions are probed with bodies Cloudflare must reject. The token never leaves this module except in the Authorization header. */
export async function checkToken(cfg: CfConfig): Promise<{ token: "active" | "invalid"; accountName: string | null; permissions: { key: string; state: State }[] }> {
  const out = (s: Partial<Record<Key, State>>) => PERMISSIONS.map((p) => ({ key: p.key, state: s[p.key] ?? "unknown" }));
  if (!(await verify(cfg))) return { token: "invalid", accountName: null, permissions: out({}) };
  let zone: Awaited<ReturnType<typeof sampleZone>> = null;
  let zoneRead: State;
  try {
    zone = await sampleZone(cfg);
    zoneRead = "ok";
  } catch (e) {
    zoneRead = e instanceof CfError && (e.status === 401 || e.status === 403) ? "missing" : "unknown";
  }
  const zp = zone && `/zones/${encodeURIComponent(zone.id)}`;
  const [dns, routes, ssl] = await Promise.all([
    zp ? probe(cf(cfg, "POST", `${zp}/dns_records`, {})) : "unknown",
    zp ? probe(cf(cfg, "POST", `${zp}/workers/routes`, { pattern: "" })) : "unknown",
    cfg.saasZoneId ? probe(cf(cfg, "POST", `/zones/${encodeURIComponent(cfg.saasZoneId)}/custom_hostnames`, { hostname: "" })) : "unknown",
  ] as const);
  // Ruleset edits have no safe invalid write (R6): reported unknown until first use.
  return { token: "active", accountName: zone?.accountName ?? null, permissions: out({ zone_read: zoneRead, dns_edit: dns, routes_edit: routes, ssl_edit: ssl }) };
}
