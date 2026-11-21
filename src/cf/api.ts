import { z } from "zod";
import type { Env } from "../env";
import { normalizeHost } from "../host";

const BASE = "https://api.cloudflare.com/client/v4";

export type CfConfig = { token: string; accountId: string; workerName: string; saasZoneId: string | null; cnameTarget: string | null };

export function cfConfig(env: Env, tokenOverride?: string): CfConfig | null {
  const t = (v: string | undefined) => v?.trim() || null;
  const token = t(tokenOverride ?? env.CF_API_TOKEN);
  const accountId = t(env.CF_ACCOUNT_ID);
  const workerName = t(env.CF_WORKER_NAME);
  if (!token || !accountId || !workerName) return null;
  const target = t(env.CF_CNAME_TARGET);
  return { token, accountId, workerName, saasZoneId: t(env.CF_SAAS_ZONE_ID), cnameTarget: target && normalizeHost(target) };
}

/** Message is the numeric status only: Cloudflare's own text can echo request input. */
export class CfError extends Error {
  constructor(public status: number, public codes: number[] = []) {
    super(`cloudflare_${status}`);
    this.name = "CfError";
  }
}

// Real errors can lack `code` (POST workers/routes 403), so it is optional.
const envelope = z.looseObject({
  success: z.boolean().optional(),
  errors: z.array(z.looseObject({ code: z.number().optional() })).nullish(),
  result: z.unknown().optional(),
  result_info: z.looseObject({ total_count: z.number().optional() }).nullish(),
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function cf<T = unknown>(cfg: CfConfig, method: Method, path: string, body?: unknown): Promise<{ result: T; info: { total_count?: number } }> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CfError(0);
  }
  const parsed = envelope.safeParse(await res.json().catch(() => null));
  const env = parsed.success ? parsed.data : null;
  const codes = (env?.errors ?? []).flatMap((e) => (e.code === undefined ? [] : [e.code]));
  if (!res.ok || !env || env.success === false) throw new CfError(res.status, codes);
  return { result: env.result as T, info: env.result_info ?? {} };
}

// Any 404 on a delete means it is already gone.
async function del(cfg: CfConfig, path: string): Promise<void> {
  try {
    await cf(cfg, "DELETE", path);
  } catch (e) {
    if (!(e instanceof CfError && e.status === 404)) throw e;
  }
}

const q = encodeURIComponent;
// A 2xx body that does not match the expected shape is still a Cloudflare failure, never a raw ZodError.
function parse<S extends z.ZodType>(s: S, v: unknown): z.infer<S> {
  const r = s.safeParse(v);
  if (!r.success) throw new CfError(200);
  return r.data;
}
const parseList = <S extends z.ZodType>(s: S, v: unknown) => parse(z.array(s), v);

const zoneS = z.object({ id: z.string(), name: z.string(), account: z.object({ name: z.string().nullish() }).nullish() });
export async function findZone(cfg: CfConfig, host: string): Promise<{ id: string; name: string; accountName: string | null } | null> {
  const labels = host.split(".");
  for (let i = 0; i < Math.min(labels.length - 1, 10); i++) {
    const { result } = await cf(cfg, "GET", `/zones?name=${q(labels.slice(i).join("."))}&account.id=${q(cfg.accountId)}`);
    const z0 = parseList(zoneS, result)[0];
    if (z0) return { id: z0.id, name: z0.name, accountName: z0.account?.name ?? null };
  }
  return null;
}

const dnsS = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string(), proxied: z.boolean().optional(), comment: z.string().nullish() });
export type DnsRecord = z.infer<typeof dnsS>;
export const listDns = async (cfg: CfConfig, zoneId: string, name: string): Promise<DnsRecord[]> =>
  parseList(dnsS, (await cf(cfg, "GET", `/zones/${q(zoneId)}/dns_records?name=${q(name)}`)).result);
export const createDns = async (cfg: CfConfig, zoneId: string, host: string): Promise<DnsRecord> =>
  parse(dnsS, (await cf(cfg, "POST", `/zones/${q(zoneId)}/dns_records`, { type: "AAAA", name: host, content: "100::", proxied: true, comment: "linkwarren" })).result);
export const deleteDns = (cfg: CfConfig, zoneId: string, id: string) => del(cfg, `/zones/${q(zoneId)}/dns_records/${q(id)}`);

const routeS = z.object({ id: z.string(), pattern: z.string(), script: z.string().nullish() });
export async function findRoute(cfg: CfConfig, zoneId: string, pattern: string): Promise<{ id: string; script: string | null } | null> {
  const r = parseList(routeS, (await cf(cfg, "GET", `/zones/${q(zoneId)}/workers/routes`)).result).find((x) => x.pattern === pattern);
  return r ? { id: r.id, script: r.script ?? null } : null;
}
export const createRoute = async (cfg: CfConfig, zoneId: string, pattern: string): Promise<{ id: string }> =>
  parse(z.object({ id: z.string() }), (await cf(cfg, "POST", `/zones/${q(zoneId)}/workers/routes`, { pattern, script: cfg.workerName })).result);
export const deleteRoute = (cfg: CfConfig, zoneId: string, id: string) => del(cfg, `/zones/${q(zoneId)}/workers/routes/${q(id)}`);

export type HostnameStatus = { status: string; sslStatus: string | null; errors: string[] };
const hostS = z.object({
  id: z.string(),
  status: z.string(),
  verification_errors: z.array(z.unknown()).nullish(),
  ssl: z.object({ status: z.string().nullish(), validation_errors: z.array(z.unknown()).nullish() }).nullish(),
});
const toHostname = (h: z.infer<typeof hostS>): HostnameStatus & { id: string } => ({
  id: h.id,
  status: h.status,
  sslStatus: h.ssl?.status ?? null,
  errors: [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? [])].flatMap((e) => {
    const m = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : null;
    return m === null ? [] : [m.slice(0, 200)];
  }).slice(0, 3),
});
const saas = (cfg: CfConfig) => {
  if (!cfg.saasZoneId) throw new CfError(0);
  return `/zones/${q(cfg.saasZoneId)}/custom_hostnames`;
};
export async function findHostname(cfg: CfConfig, host: string): Promise<(HostnameStatus & { id: string }) | null> {
  const h = parseList(hostS, (await cf(cfg, "GET", `${saas(cfg)}?hostname=${q(host)}`)).result)[0];
  return h ? toHostname(h) : null;
}
export const createHostname = async (cfg: CfConfig, host: string) =>
  toHostname(parse(hostS, (await cf(cfg, "POST", saas(cfg), { hostname: host, ssl: { method: "http", type: "dv" } })).result));
export const deleteHostname = async (cfg: CfConfig, id: string) => del(cfg, `${saas(cfg)}/${q(id)}`);
export const hostnameCount = async (cfg: CfConfig): Promise<number> => (await cf(cfg, "GET", `${saas(cfg)}?per_page=1`)).info.total_count ?? 0;

const originS = z.object({ origin: z.string().nullish() });
export async function getFallbackOrigin(cfg: CfConfig): Promise<string | null> {
  try {
    return parse(originS, (await cf(cfg, "GET", `${saas(cfg)}/fallback_origin`)).result).origin ?? null;
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null; // unset answers 404 code 1551
    throw e;
  }
}
export async function setFallbackOrigin(cfg: CfConfig): Promise<void> {
  if (!cfg.cnameTarget) throw new CfError(0);
  await cf(cfg, "PUT", `${saas(cfg)}/fallback_origin`, { origin: cfg.cnameTarget });
}
