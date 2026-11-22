// Pure route picking for links that send visitors to different destinations by country or device.
import { deviceOf } from "./clicks";

export type RouteDevice = "mobile" | "tablet" | "desktop";
export type Route = { countries: string[]; devices: RouteDevice[]; url: string };

const UA_MAX = 512; // same cap as click recording, before any regex runs

/** Bots and an empty UA are "desktop" for routing. */
export function routeDeviceOf(ua: string | null): RouteDevice {
  const d = deviceOf(ua?.slice(0, UA_MAX) ?? "");
  return d === "other" ? "desktop" : d;
}

export function countryOf(req: Request): string | null {
  const c = (req.cf as { country?: unknown } | undefined)?.country;
  return typeof c === "string" && c ? c.toUpperCase() : null;
}

// Unknown (null), "XX" (no data) and "T1" (Tor) never satisfy a country rule.
const KNOWN = (c: string | null): c is string => c !== null && c !== "XX" && c !== "T1";

export function pickDestination(link: { url: string; routes: Route[] }, country: string | null, device: RouteDevice): string {
  const hit = link.routes.find(
    (r) => (!r.countries.length || (KNOWN(country) && r.countries.includes(country))) && (!r.devices.length || r.devices.includes(device)),
  );
  return hit ? hit.url : link.url;
}

/** Pass the visitor's raw query through to the destination (raw bytes, no re-encoding). */
export function withQuery(dest: string, passQuery: boolean, search: string): string {
  if (!passQuery || !search) return dest;
  const d = new URL(dest);
  d.search = d.search ? `${d.search}&${search.slice(1)}` : search;
  return d.toString();
}
