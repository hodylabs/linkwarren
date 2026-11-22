import { type Ctx, getDomainByHost, getLink } from "./cache";
import { classifyAgent, referrerHost, splitQrMarker, UA_MAX, utcDay, visitorHash } from "./clicks";
import type { Env } from "./env";
import { normalizeHost, slugFromPath } from "./host";
import { notFoundPage, pendingPage } from "./pages";
import { countryOf, pickDestination, routeDeviceOf, withQuery } from "./routing";
import { handleProtected } from "./unlock";
import type { DomainRow, LinkRow } from "./types";
import { checkSlugShape, slugKey } from "./validate";

export async function handleRedirect(req: Request, env: Env, now: number, ctx?: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const domain = await getDomainByHost(env, normalizeHost(url.host), ctx);
  const head = req.method === "HEAD";
  const html = (body: string, status: number) =>
    new Response(head ? null : body, { status, headers: { "content-type": "text/html; charset=utf-8", ...robots(domain) } });

  if (!domain || domain.status === "disabled") return html(notFoundPage, 404);
  if (domain.status === "pending") return html(pendingPage, 200);
  // R8: POST is only for unlocking a protected link; everything else here is GET or HEAD.
  if (!head && req.method !== "GET" && req.method !== "POST") return notAllowed();
  const post = req.method === "POST";

  const miss = (target: string | null) => (target ? redirect(target, 302, domain) : html(notFoundPage, 404));
  if (url.pathname === "/") return post ? notAllowed() : miss(domain.bareRedirect);

  const slug = slugFromPath(url.pathname);
  // Junk slugs never reach D1 or KV. Reserved words are a creation-time rule only, so stored links stay reachable.
  const link = slug === null || !checkSlugShape(slug).ok ? null : await getLink(env, domain.id, slugKey(slug, domain.caseSensitive), ctx);
  const live = link && (link.startsAt === null || link.startsAt <= now) && (link.expiresAt === null || link.expiresAt > now);
  if (!live) {
    if (post) return notAllowed();
    // Built-in replies only when no live link owns the path (imported links may use these slugs).
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/robots.txt") {
      const body = domain.noindex ? "User-agent: *\nDisallow: /" : "User-agent: *\nAllow: /";
      return new Response(head ? null : body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return miss(domain.notfoundRedirect);
  }
  // A forwarder: one hop to the new short link with the raw query (lw=qr kept), so that link records the one click.
  if (link.forwardTo) return post ? notAllowed() : redirect(link.url + url.search, 302, domain);

  // Same predicate as the API's hasPassword: any stored hash, even a malformed one, gates the link (fails closed).
  if (link.passwordHash !== null) return handleProtected(req, env, link, domain, url, now, ctx);
  if (post) return notAllowed();

  const m = splitQrMarker(url.search);
  const res = redirect(destinationOf(req, link, m.search), link.redirectCode, domain);
  // Off the hot path: the response never waits for, or fails because of, analytics.
  if (req.method === "GET" && env.CLICKS && ctx) ctx.waitUntil(recordClick(env, req, link, domain, m.qr, now).catch(() => {}));
  return res;
}

/** Routed destination plus pass-through query (`search` already has the QR marker stripped); shared by the redirect and the unlock. */
export function destinationOf(req: Request, link: LinkRow, search: string): string {
  // The UA is read (capped) only when a route needs the device: a plain link does no agent work before it answers.
  const devices = link.routes.some((r) => r.devices.length) ? routeDeviceOf(req.headers.get("user-agent")) : [];
  return withQuery(pickDestination(link, countryOf(req), devices), link.passQuery, search);
}

export async function recordClick(env: Env, req: Request, link: LinkRow, domain: DomainRow, qr: boolean, now: number): Promise<void> {
  try {
    // A macrotask, not `await null`: microtasks still run before the response is handed back, a timer runs after it.
    await new Promise((r) => setTimeout(r, 0));
    // Capped: the agent regexes cost grows faster than linear on crafted long agents (Free plan: 10 ms CPU).
    const ua = req.headers.get("user-agent")?.slice(0, UA_MAX) ?? null;
    const cf = req.cf as { country?: unknown; verifiedBotCategory?: unknown } | undefined;
    const vb = typeof cf?.verifiedBotCategory === "string" ? cf.verifiedBotCategory : undefined;
    const { kind, device } = classifyAgent(ua, vb);
    const country = typeof cf?.country === "string" && cf.country ? cf.country.toUpperCase() : "XX";
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    const visitor = await visitorHash(env.VISITOR_SALT, utcDay(now), ip, ua ?? "");
    // An own-host referrer is the protected link's form page (same-origin policy), never where the visitor came from.
    const ref = referrerHost(req.headers.get("referer"));
    env.CLICKS?.writeDataPoint({
      indexes: [domain.id],
      blobs: [domain.id, link.id, link.slug, country, device, ref === referrerHost(req.url) ? "" : ref, qr ? "qr" : "typed", kind, visitor],
      doubles: [1],
    });
  } catch (e) {
    console.warn("click not recorded", e instanceof Error ? e.name : "unknown"); // name only: messages could carry request data
  }
}

export const robots = (d: DomainRow | null): Record<string, string> => (d?.noindex ? { "x-robots-tag": "noindex" } : {});

const redirect = (to: string, status: number, d: DomainRow) =>
  new Response(null, { status, headers: { location: to, "cache-control": "private, max-age=0", ...robots(d) } });

const notAllowed = () =>
  new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" } });
