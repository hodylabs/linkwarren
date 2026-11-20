// Pure comparison logic for scripts/verify-redirects.ts.
export type Probe = { status: number | null; location: string | null; error?: string };
export type Target = { host: string; slug: string; path: string };

/** One request target per exported link (host null -> main host); the path keeps the slug exactly. */
export function probeTargets(e: { mainHost: string; links: { host: string | null; slug: string }[] }): Target[] {
  return e.links.map((l) => ({ host: l.host ?? e.mainHost, slug: l.slug, path: `/${encodeURIComponent(l.slug)}` }));
}

/** null when old and new agree on status and Location, otherwise a one-line description. */
export function compareProbe(oldP: Probe, newP: Probe): string | null {
  if (oldP.error || newP.error) return `request failed (old: ${oldP.error ?? "ok"}, new: ${newP.error ?? "ok"})`;
  if (oldP.status !== newP.status) return `status ${oldP.status} vs ${newP.status}`;
  if (oldP.location !== newP.location) return `location ${oldP.location} vs ${newP.location}`;
  return null;
}
