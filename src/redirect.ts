import { getDomainByHost, getLink } from "./cache";
import type { Env } from "./env";
import { normalizeHost, slugFromPath } from "./host";
import { notFoundPage, pendingPage } from "./pages";
import type { DomainRow } from "./types";
import { slugKey } from "./validate";

export async function handleRedirect(req: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(req.url);
  const domain = await getDomainByHost(env, normalizeHost(url.host));
  const head = req.method === "HEAD";
  const html = (body: string, status: number) =>
    new Response(head ? null : body, { status, headers: { "content-type": "text/html; charset=utf-8", ...robots(domain) } });

  if (!domain || domain.status === "disabled") return html(notFoundPage, 404);
  if (domain.status === "pending") return html(pendingPage, 200);

  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname === "/robots.txt") {
    const body = domain.noindex ? "User-agent: *\nDisallow: /" : "User-agent: *\nAllow: /";
    return new Response(head ? null : body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const miss = (target: string | null) => (target ? redirect(target, 302, domain) : html(notFoundPage, 404));
  if (url.pathname === "/") return miss(domain.bareRedirect);

  const slug = slugFromPath(url.pathname);
  const link = slug === null ? null : await getLink(env, domain.id, slugKey(slug, domain.caseSensitive));
  const live = link && (link.startsAt === null || link.startsAt <= now) && (link.expiresAt === null || link.expiresAt > now);
  if (!live) return miss(domain.notfoundRedirect);

  let dest = link.url;
  if (link.passQuery && url.search) {
    const d = new URL(dest);
    url.searchParams.forEach((v, k) => d.searchParams.append(k, v));
    dest = d.toString();
  }
  return redirect(dest, link.redirectCode, domain);
}

const robots = (d: DomainRow | null): Record<string, string> => (d?.noindex ? { "x-robots-tag": "noindex" } : {});

const redirect = (to: string, status: number, d: DomainRow) =>
  new Response(null, { status, headers: { location: to, "cache-control": "private, max-age=0", ...robots(d) } });
