import type { Domain, Me, UserItem } from "../api";
import { checkDestination, checkSlugShape } from "../../../src/validate";
import type { Tone } from "../links/linkView";

/** Mirrors the server's canManageDomain: the instance owner, or the domain's own owner. */
export const canManage = (me: Me, d: Domain): boolean => me.role === "owner" || d.ownerId === me.id;

export function statusTag(d: Domain, isOwner: boolean): { label: string; tone: Tone } {
  if (d.status === "active") return { label: "Active", tone: "ok" };
  if (d.status === "pending") return { label: isOwner ? "Needs your approval" : "Waiting for approval", tone: "wait" };
  return { label: "Disabled", tone: "off" };
}

export type ReservedParse = { ok: true; list: string[] } | { ok: false; bad: string };

/** Commas and whitespace separate; case is kept; case-insensitive duplicates collapse to the first; at most 100. */
export function parseReserved(text: string): ReservedParse {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const t of text.split(/[\s,]+/)) {
    if (!t) continue;
    if (!checkSlugShape(t).ok) return { ok: false, bad: t };
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      list.push(t);
    }
  }
  return list.length > 100 ? { ok: false, bad: list[100]! } : { ok: true, list };
}

/** "You", or the owner's name (the instance owner can look people up); a member only ever sees "Someone else". */
export function ownerLabel(d: Domain, me: Me, users: UserItem[] | null): string {
  if (d.ownerId === me.id) return "You";
  if (me.role !== "owner") return "Someone else";
  const u = users?.find((x) => x.id === d.ownerId);
  return u ? u.name || u.email : "Someone else";
}

/** Text for the "Shared with" column. null = the column is hidden (members). */
export function sharedWith(d: Domain, users: UserItem[] | null, me: Me): string | null {
  if (me.role !== "owner") return null;
  if (d.type === "main") return "Everyone";
  const names = (users ?? [])
    .filter((u) => u.domains.some((x) => x.id === d.id && x.via === "member"))
    .map((u) => u.name || u.email);
  return names.length ? names.join(", ") : "Only the owner";
}

export type Draft = { bare: string; nf: string; noindex: boolean; reserved: string };
export const draftOf = (d: Domain): Draft => ({
  bare: d.bareRedirect ?? "",
  nf: d.notfoundRedirect ?? "",
  noindex: d.noindex,
  reserved: d.reservedExtra.join(", "),
});

export type DomainDiff = { body: Record<string, unknown>; errors: Partial<Record<"bare" | "nf" | "reserved", string>> };

/** Only the keys that differ from the saved domain. Empty redirect text clears it (null). Errors are error codes, one per field. */
export function domainDiff(d: Domain, draft: Draft, shortHosts: string[]): DomainDiff {
  const body: Record<string, unknown> = {};
  const errors: DomainDiff["errors"] = {};
  for (const [field, key, saved] of [["bare", "bareRedirect", d.bareRedirect], ["nf", "notfoundRedirect", d.notfoundRedirect]] as const) {
    const text = draft[field].trim();
    if (text === (saved ?? "")) continue;
    if (text === "") {
      body[key] = null;
      continue;
    }
    const r = checkDestination(text, shortHosts);
    if (r.ok) body[key] = text;
    else errors[field] = r.reason === "too_long" ? "url_too_long" : r.reason;
  }
  if (draft.noindex !== d.noindex) body.noindex = draft.noindex;
  const reserved = parseReserved(draft.reserved);
  if (!reserved.ok) errors.reserved = "invalid_reserved";
  else if (JSON.stringify(reserved.list) !== JSON.stringify(d.reservedExtra)) body.reservedExtra = reserved.list;
  return { body, errors };
}
