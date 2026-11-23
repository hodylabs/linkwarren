// S8c: where the dashboard lives on its host. The Worker writes <meta name="lw-base" content="<prefix>"> into the shell
// ("" in host mode). Only a value of the server's DASHBOARD_PATH shape (src/dash.ts, R1) is used; anything else means "".
const PREFIX = /^\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const raw = typeof document === "undefined" ? null : document.querySelector('meta[name="lw-base"]')?.getAttribute("content");

export const BASE: string = raw && PREFIX.test(raw) ? raw : "";

/** An inner dashboard path (starting with "/") as a URL path on this host. */
export const withBase = (p: string): string => BASE + p;

/** The inner path of a pathname under the base; a path outside it comes back unchanged. */
export const stripBase = (pathname: string): string =>
  BASE !== "" && (pathname === BASE || pathname.startsWith(BASE + "/")) ? pathname.slice(BASE.length) || "/" : pathname;
