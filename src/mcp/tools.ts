import { z } from "zod";
import { callApi, type Principal } from "../call";
import type { Env } from "../env";
import { normalizeHost, slugFromPath } from "../host";
import { LIMITS } from "../limits";
import { VERSION } from "../version";
import { ApiError } from "./run";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Api = (method: Method, path: string, body?: unknown) => Promise<unknown>;
type Domain = { id: string; host: string; type: string; status: string; linkCount: number };

/** /api/v1 as the principal; a 4xx/5xx becomes ApiError({ error, status }), never the rest of the body. */
export const apiAs = (env: Env, ctx: ExecutionContext, p: Principal): Api => async (method, path, body) => {
  const r = await callApi(env, ctx, p, method, path, body);
  if (r.status >= 400) {
    const e = (r.json as { error?: unknown } | null)?.error;
    throw new ApiError(typeof e === "string" ? e : "error", r.status);
  }
  return r.json;
};

const enc = encodeURIComponent;
const qs = (q: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined)).toString();

/** A host or id the person can use, else unknown_domain (a domain they cannot use is indistinguishable from none). */
async function domainOf(api: Api, hostOrId: string): Promise<Domain> {
  const list = (await api("GET", "/domains")) as Domain[];
  const host = normalizeHost(hostOrId);
  const d = list.find((x) => x.id === hostOrId || x.host === host);
  if (!d) throw new ApiError("unknown_domain", 404);
  return d;
}

const time = z.number().int().nonnegative().nullable().optional();
const rules = {
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
  startsAt: time,
  expiresAt: time,
  passQuery: z.boolean().optional(),
  password: z.string().nullable().optional().describe("Write-only: a string sets it, null clears it. Never returned."),
  routes: z.array(z.strictObject({
    countries: z.array(z.string()).optional(),
    devices: z.array(z.enum(["mobile", "tablet", "desktop"])).optional(),
    url: z.string(),
  })).max(10).optional(),
};
const id = z.string().min(1).max(64);

export type ToolDef = {
  description: string;
  input: z.ZodObject;
  write?: boolean;
  run: (api: Api, args: any, p: Principal, env: Env) => Promise<Record<string, unknown>>;
};

export const TOOLS: Record<string, ToolDef> = {
  server_info: {
    description: "This connection's access level, your role, the MCP URL and the rate limits.",
    input: z.strictObject({}),
    run: async (_api, _a, p, env) => ({
      version: VERSION,
      access: p.grant.del ? "write+delete" : p.grant.write ? "write" : "read",
      role: p.user.role,
      mcpUrl: `https://${normalizeHost(env.DASHBOARD_HOST)}/mcp`,
      limits: { perUserPerMinute: LIMITS.apiUser.n, perConnectionPerMinute: LIMITS.apiConn.n, perUserPerDay: LIMITS.apiDay.n },
    }),
  },
  search_links: {
    description: "Search the links you can see, newest first. `query` matches slug or destination; pass `next` back as `cursor` for more.",
    input: z.strictObject({
      query: z.string().min(1).max(48).optional(),
      domain: z.string().min(1).optional().describe("Host (go.example.com) or domain id"),
      status: z.enum(["active", "scheduled", "expired"]).optional(),
      cursor: z.string().min(1).max(128).optional(),
    }),
    run: async (api, a) => {
      const domain = a.domain === undefined ? undefined : (await domainOf(api, a.domain)).id;
      return (await api("GET", `/links?${qs({ q: a.query, domain, status: a.status, cursor: a.cursor })}`)) as Record<string, unknown>;
    },
  },
  get_link: {
    description: "One link by `id` or by `shortUrl` (go.example.com/spring, with or without https://). Pass exactly one.",
    input: z.strictObject({ id: id.optional(), shortUrl: z.string().min(1).max(2048).optional() }),
    run: async (api, a) => {
      if ((a.id === undefined) === (a.shortUrl === undefined)) throw new ApiError("bad_input", 400);
      if (a.id !== undefined) return (await api("GET", `/links/${enc(a.id)}`)) as Record<string, unknown>;
      const raw: string = a.shortUrl;
      const u = URL.parse(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const slug = u && slugFromPath(u.pathname);
      if (!u || !slug) throw new ApiError("bad_input", 400);
      const d = await domainOf(api, u.hostname);
      return (await api("GET", `/links/by-slug?${qs({ domain: d.id, slug })}`)) as Record<string, unknown>;
    },
  },
  create_link: {
    description: "Create a short link. Confirm with the person first. `domain` is a host or domain id.",
    input: z.strictObject({ domain: z.string().min(1), slug: z.string(), url: z.string(), ...rules }),
    write: true,
    run: async (api, { domain, ...rest }) =>
      (await api("POST", "/links", { domainId: (await domainOf(api, domain)).id, ...rest })) as Record<string, unknown>,
  },
  update_link: {
    description: "Change a link. This changes a live redirect that printed QR codes may use: confirm with the person first.",
    input: z.strictObject({ id, url: z.string().optional(), ...rules }),
    write: true,
    run: async (api, { id: linkId, ...rest }) => (await api("PATCH", `/links/${enc(linkId)}`, rest)) as Record<string, unknown>,
  },
  delete_link: {
    description: "Delete a link and lock its slug. Refuses without confirm: true; show the person the summary and ask first.",
    input: z.strictObject({ id, confirm: z.boolean().optional() }),
    write: true,
    run: async (api, a) => {
      if (a.confirm !== true) {
        const link = (await api("GET", `/links/${enc(a.id)}`)) as { domainId: string; slug: string };
        const d = await domainOf(api, link.domainId);
        return { refused: true, summary: `Deleting ${d.host}/${link.slug} sends visitors to the domain's not-found page and locks the slug.` };
      }
      await api("DELETE", `/links/${enc(a.id)}`);
      return { deleted: true, id: a.id };
    },
  },
  list_domains: {
    description: "The domains you can create links on.",
    input: z.strictObject({}),
    run: async (api) => ({
      items: ((await api("GET", "/domains")) as Domain[]).map(({ host, type, status, linkCount }) => ({ host, type, status, linkCount })),
    }),
  },
  check_slug: {
    description: "Whether a slug is available on a domain: available, taken, locked, reserved or invalid.",
    input: z.strictObject({ domain: z.string().min(1), slug: z.string() }),
    run: async (api, a) =>
      (await api("GET", `/links/check?${qs({ domain: (await domainOf(api, a.domain)).id, slug: a.slug })}`)) as Record<string, unknown>,
  },
  link_stats: {
    description: "Daily click counts for one link over the last 7 days.",
    input: z.strictObject({ id }),
    run: async (api, a) => (await api("GET", `/analytics/links?${qs({ ids: a.id })}`)) as Record<string, unknown>,
  },
};
