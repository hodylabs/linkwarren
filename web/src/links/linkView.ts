import type { Domain, Link, Me, UserItem } from "../api";
import { shortDate } from "../time";

export type Tone = "ok" | "wait" | "bad" | "off";

export function linkState(l: Link, d: Domain | undefined, now: number): { label: string; tone: Tone } {
  if (d?.status === "pending") return { label: "Not active yet", tone: "wait" };
  if (d?.status === "disabled") return { label: "Domain disabled", tone: "off" };
  if (l.startsAt !== null && l.startsAt > now) return { label: `Starts ${shortDate(l.startsAt)}`, tone: "wait" };
  if (l.expiresAt !== null && l.expiresAt <= now) return { label: "Expired", tone: "off" };
  return { label: "Active", tone: "ok" };
}

export const shortUrl = (host: string, slug: string): string => `https://${host}/${slug}`;

/** "You"; the owner sees a name or email; a member only ever sees "Teammate". */
export function creatorLabel(createdBy: string, me: Me, users: UserItem[] | null): string {
  if (createdBy === me.id) return "You";
  if (me.role !== "owner") return "Teammate";
  const u = users?.find((x) => x.id === createdBy);
  return u ? u.name || u.email : "Teammate";
}

export type LinksFilter = { domain: string | null; q: string; status: "all" | "active" | "scheduled" | "expired"; mine: boolean; cursor: string | null };

/** Query string for GET /api/links without the "?". Empty values are left out, so never `cursor=`. */
export function linksQuery(o: LinksFilter): string {
  const p = new URLSearchParams();
  if (o.domain) p.set("domain", o.domain);
  if (o.q) p.set("q", o.q.slice(0, 48)); // the server caps the LIKE pattern
  if (o.status !== "all") p.set("status", o.status);
  if (o.mine) p.set("mine", "1");
  if (o.cursor) p.set("cursor", o.cursor);
  return p.toString();
}

/** Per-link 7-day stats from GET /api/analytics/links. `days` is oldest first, today last. */
export type LinkStats = { linkId: string; days: number[]; clicks: number; qr: number; topCountry: string | null };
export type StatsLive = "on" | "off" | "unavailable";

/** Polyline points for a 72x20 box. `of` is the full point count when only the first days are known. */
export function sparkPoints(days: number[], of = days.length): string {
  const max = Math.max(...days);
  return days
    .map((v, i) => `${+(i * 72 / (of - 1)).toFixed(1)},${max > 0 ? +(18 - 16 * v / max).toFixed(1) : 18}`)
    .join(" ");
}
