// Pure route picking for links that send visitors to different destinations by country or device.
import { deviceOf, UA_MAX } from "./clicks";

import type { Route, RouteDevice } from "./types";
export type { Route, RouteDevice };

// Compiled once per isolate (10 ms CPU budget). Order matters in osOf: Android UAs also say Linux, Windows Phone also says Android and iPhone.
const WINDOWS_PHONE = /Windows Phone/i;
const ANDROID = /Android/i;
const IOS = /iPhone|iPad|iPod/i;
const WINDOWS = /Windows NT/i;
const MACOS = /Macintosh|Mac OS X/i;
const CHROMEOS = /CrOS/;
const LINUX = /Linux/i; // not X11: FreeBSD and other Unix desktops send it too

function osOf(ua: string): RouteDevice | null {
  if (WINDOWS_PHONE.test(ua)) return null;
  if (ANDROID.test(ua)) return "android";
  if (IOS.test(ua)) return "ios";
  if (WINDOWS.test(ua)) return "windows";
  // iPadOS in desktop mode sends a Mac UA, so it lands here (macos, desktop): not detectable server-side.
  if (MACOS.test(ua)) return "macos";
  if (CHROMEOS.test(ua)) return "chromeos";
  if (LINUX.test(ua)) return "linux";
  return null;
}

/** The visitor's route device values: a form factor plus the OS when known. Bots and an empty UA are "desktop". */
export function routeDeviceOf(ua: string | null): RouteDevice[] {
  const s = ua?.slice(0, UA_MAX) ?? "";
  const d = deviceOf(s);
  const form = d === "other" ? "desktop" : d;
  const os = osOf(s);
  return os ? [form, os] : [form];
}

export function countryOf(req: Request): string | null {
  const c = (req.cf as { country?: unknown } | undefined)?.country;
  return typeof c === "string" && c ? c.toUpperCase() : null;
}

// Unknown (null), "XX" (no data) and "T1" (Tor) never satisfy a country rule.
const KNOWN = (c: string | null): c is string => c !== null && c !== "XX" && c !== "T1";

export function pickDestination(link: { url: string; routes: Route[] }, country: string | null, devices: RouteDevice[]): string {
  const hit = link.routes.find(
    (r) => (!r.countries.length || (KNOWN(country) && r.countries.includes(country))) && (!r.devices.length || r.devices.some((d) => devices.includes(d))),
  );
  return hit ? hit.url : link.url;
}

/** Pass the visitor's raw query through to the destination (raw bytes, no re-encoding). */
export function withQuery(dest: string, passQuery: boolean, search: string): string {
  // Web destinations only: a visitor query on mailto: could add cc/bcc, on tel: it would corrupt the number.
  if (!passQuery || !search || !/^https?:/i.test(dest)) return dest;
  const d = new URL(dest);
  d.search = d.search ? `${d.search}&${search.slice(1)}` : search;
  return d.toString();
}
