import { z } from "zod";
import { CfError, cf, parse, type CfConfig } from "./api";

export const SECURITY_LEVELS = ["essentially_off", "low", "medium", "high", "under_attack"] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];
export type Phase = "http_config_settings" | "http_ratelimit";
export type HostRule = { ref: string; expression: string } & Record<string, unknown>;

/** Cloudflare refused a new rule for quota, plan or entitlement reasons. */
export class PlanLimitError extends Error {
  constructor() {
    super("cloudflare_plan_limit");
    this.name = "PlanLimitError";
  }
}

export const secRef = (domainId: string) => `lw-${domainId}-sec`;
export const rlRef = (domainId: string) => `lw-${domainId}-rl`;

/** Guards rule injection: the host goes inside a quoted string of a Cloudflare expression. */
function hostExpression(host: string): string {
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("unsafe host for a rule expression");
  return `http.host eq "${host}"`;
}
export const securityRule = (domainId: string, host: string, level: SecurityLevel): HostRule => ({
  ref: secRef(domainId), expression: hostExpression(host), action: "set_config",
  action_parameters: { security_level: level }, description: "linkwarren security level",
});
// Free plan shape: period 10 s, ip.src + cf.colo.id, mitigation 10 s.
export const rateLimitRule = (domainId: string, host: string, requests: number): HostRule => ({
  ref: rlRef(domainId), expression: hostExpression(host), action: "block",
  ratelimit: { characteristics: ["ip.src", "cf.colo.id"], period: 10, requests_per_period: requests, mitigation_timeout: 10 },
  description: "linkwarren rate limit",
});

const q = encodeURIComponent;
const rulesetS = z.object({ id: z.string(), rules: z.array(z.looseObject({ id: z.string(), ref: z.string().nullish() })).nullish() });
type Ruleset = { id: string; rules: { id: string; ref?: string | null }[] };

/** The phase entrypoint, or null when the zone has none yet (live: 404 code 10003). */
async function entrypoint(cfg: CfConfig, zoneId: string, phase: Phase): Promise<Ruleset | null> {
  try {
    const r = parse(rulesetS, (await cf(cfg, "GET", `/zones/${q(zoneId)}/rulesets/phases/${phase}/entrypoint`)).result);
    return { id: r.id, rules: r.rules ?? [] };
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null;
    throw e;
  }
}

export const isForbidden = (e: unknown) =>
  e instanceof CfError && (e.status === 401 || (e.status === 403 && (e.codes.length === 0 || e.codes.includes(10000))));

// Measured live on a Free zone 2026-11-21: 400 20217 = the phase entrypoint already exists; 400 50001 = the phase rule quota is full.
const EXISTS = 20217, QUOTA = 50001;
const has = (e: unknown, code: number) => e instanceof CfError && e.status === 400 && e.codes.includes(code);
/** Only the quota code is a plan limit; every other error stays a CfError (permission or a plain Cloudflare failure). */
const onAdd = (e: unknown): unknown => (has(e, QUOTA) ? new PlanLimitError() : e);

/**
 * Adds or updates the one rule with `rule.ref` in the zone's phase entrypoint. Never PUTs an entrypoint and never sends a
 * rules list for an existing one, so rules other tools made stay untouched.
 */
export async function upsertHostRule(cfg: CfConfig, zoneId: string, phase: Phase, rule: HostRule): Promise<void> {
  const base = `/zones/${q(zoneId)}/rulesets`;
  let rs = await entrypoint(cfg, zoneId, phase);
  if (!rs) {
    try {
      await cf(cfg, "POST", base, { name: "default", kind: "zone", phase, rules: [rule] });
      return;
    } catch (e) {
      // Another tool created the entrypoint since our GET: re-read it and add to it.
      if (!has(e, EXISTS)) throw onAdd(e);
      rs = await entrypoint(cfg, zoneId, phase);
      if (!rs) throw onAdd(e);
    }
  }
  const ours = rs.rules.find((r) => r.ref === rule.ref);
  if (ours) {
    await cf(cfg, "PATCH", `${base}/${q(rs.id)}/rules/${q(ours.id)}`, rule);
    return;
  }
  try {
    await cf(cfg, "POST", `${base}/${q(rs.id)}/rules`, rule);
  } catch (e) {
    throw onAdd(e);
  }
}

/** Deletes only the rule with our `ref`; a missing entrypoint, rule or a 404 counts as gone. */
export async function deleteHostRule(cfg: CfConfig, zoneId: string, phase: Phase, ref: string): Promise<void> {
  const rs = await entrypoint(cfg, zoneId, phase);
  const ours = rs?.rules.find((r) => r.ref === ref);
  if (!rs || !ours) return;
  try {
    await cf(cfg, "DELETE", `/zones/${q(zoneId)}/rulesets/${q(rs.id)}/rules/${q(ours.id)}`);
  } catch (e) {
    if (!(e instanceof CfError && e.status === 404)) throw e;
  }
}
