// S9 vCard links: the card's fields, their checks and the vCard 3.0 file. Pure (no Worker or Node APIs), shared with the dashboard.
import { ADDR, checkDestination } from "./validate";

/** links.url of every vCard link: a valid https URL on a reserved TLD (RFC 2606), so nothing that reads links.url ever breaks or goes anywhere. */
export const VCARD_URL = "https://vcard.invalid/";

export const PHONE_TYPES = ["cell", "work", "home", "other"] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];
export type VCardAddress = { street: string; city: string; region: string; postalCode: string; country: string };
export type VCard = {
  firstName: string; lastName: string; org: string; title: string;
  phones: { type: PhoneType; number: string }[]; emails: string[]; websites: string[];
  address: VCardAddress; note: string;
  /** Base64 JPEG or PNG, at most PHOTO_MAX bytes decoded; null for none. */
  photo: string | null;
};

/** Caps, in UTF-16 units. The dashboard and the API schema use the same numbers. */
export const VCARD_MAX = {
  firstName: 100, lastName: 100, org: 200, title: 100, phone: 40, email: 254, website: 2048,
  street: 200, city: 100, region: 100, postalCode: 20, country: 100, note: 1000, rows: 10,
} as const;
export const PHOTO_MAX = 64 * 1024;
/** Base64 length of PHOTO_MAX bytes: the string is refused above this before anything is decoded. */
export const PHOTO_B64_MAX = Math.ceil(PHOTO_MAX / 3) * 4;

export const emptyVcard = (): VCard => ({
  firstName: "", lastName: "", org: "", title: "", phones: [], emails: [], websites: [],
  address: { street: "", city: "", region: "", postalCode: "", country: "" }, note: "", photo: null,
});

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PHONE = /^\+?[0-9 ().\/-]*[0-9][0-9 ().\/-]*$/;
const EMAIL = new RegExp(`^${ADDR}$`);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** "JPEG" or "PNG" from the decoded file's magic bytes, else null (SVG, GIF and everything else are refused). */
export function photoType(bin: string): "JPEG" | "PNG" | null {
  const at = (i: number) => bin.charCodeAt(i);
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "JPEG";
  return bin.startsWith("\x89PNG\r\n\x1a\n") ? "PNG" : null;
}

/** The decoded bytes (a binary string) of a stored or offered photo, or null when it is not valid base64 within PHOTO_MAX. */
function decodePhoto(b64: string): string | null {
  if (b64.length > PHOTO_B64_MAX || b64.length % 4 !== 0 || !B64.test(b64)) return null;
  try {
    const bin = atob(b64);
    return bin.length <= PHOTO_MAX ? bin : null;
  } catch {
    return null;
  }
}

/** Input already shaped and capped by the API schema; every field present. */
export type VCardInput = VCard;

/**
 * Checks and normalizes a card: one-line fields trimmed and free of control characters, the note's line breaks as \n,
 * phones in a dial-able charset, plain email addresses, http(s) websites, the photo a JPEG or PNG within PHOTO_MAX.
 * `field` names the first bad one (photo, name, phones.0, emails.1, websites.2, note, address.city, ...).
 */
export function checkVcard(v: VCardInput): { ok: true; vcard: VCard } | { ok: false; field: string } {
  const bad = (field: string) => ({ ok: false as const, field });
  const one = (s: string) => s.trim();
  const fields = ["firstName", "lastName", "org", "title"] as const;
  for (const f of fields) if (CTRL.test(v[f]) || v[f].length > VCARD_MAX[f]) return bad(f);
  const address = { ...v.address };
  for (const k of ["street", "city", "region", "postalCode", "country"] as const) {
    if (CTRL.test(address[k]) || address[k].length > VCARD_MAX[k]) return bad(`address.${k}`);
    address[k] = one(address[k]);
  }
  const note = v.note.replace(/\r\n?/g, "\n").trim();
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(note) || note.length > VCARD_MAX.note) return bad("note");
  if (v.phones.length > VCARD_MAX.rows || v.emails.length > VCARD_MAX.rows || v.websites.length > VCARD_MAX.rows) return bad("rows");
  const phones: VCard["phones"] = [];
  for (const [i, p] of v.phones.entries()) {
    const number = one(p.number);
    if (!PHONE_TYPES.includes(p.type) || number.length > VCARD_MAX.phone || !PHONE.test(number)) return bad(`phones.${i}`);
    phones.push({ type: p.type, number });
  }
  const emails: string[] = [];
  for (const [i, e] of v.emails.entries()) {
    const s = one(e);
    if (s.length > VCARD_MAX.email || !EMAIL.test(s)) return bad(`emails.${i}`);
    emails.push(s);
  }
  const websites: string[] = [];
  for (const [i, w] of v.websites.entries()) {
    // A contact's website may be any web address (a short link included): no loop check, http(s) only.
    const r = checkDestination(one(w), [], { webOnly: true });
    if (!r.ok || r.url.href.length > VCARD_MAX.website) return bad(`websites.${i}`);
    websites.push(r.url.href);
  }
  const card: VCard = {
    firstName: one(v.firstName), lastName: one(v.lastName), org: one(v.org), title: one(v.title),
    phones, emails, websites, address, note, photo: null,
  };
  if (!card.firstName && !card.lastName && !card.org) return bad("name");
  if (v.photo !== null) {
    const bin = decodePhoto(v.photo);
    if (bin === null || !photoType(bin)) return bad("photo");
    card.photo = v.photo;
  }
  return { ok: true, vcard: card };
}

/** What a card shows as its name: the person, else the organization. */
export const fullName = (v: Pick<VCard, "firstName" | "lastName" | "org">): string =>
  [v.firstName, v.lastName].filter(Boolean).join(" ") || v.org;

/** RFC 2426 text escaping: backslash, comma, semicolon and line breaks. */
export const escapeText = (s: string): string => s.replace(/[\\,;]/g, "\\$&").replace(/\n/g, "\\n");

const utf8Len = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Folds one content line at 75 octets (continuations start with one space), never inside a UTF-8 sequence. */
export function fold(line: string): string {
  const parts: string[] = [];
  if (/^[\x00-\x7f]*$/.test(line)) {
    // Fast path for the photo line (tens of thousands of ASCII characters).
    parts.push(line.slice(0, 75));
    for (let i = 75; i < line.length; i += 74) parts.push(line.slice(i, i + 74));
    return parts.join("\r\n ");
  }
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = utf8Len(ch.codePointAt(0)!);
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const TEL: Record<PhoneType, string> = { cell: "CELL", work: "WORK", home: "HOME", other: "VOICE" };

/** The card as a vCard 3.0 file (best supported by iOS and Android): CRLF line endings, folded at 75 octets. */
export function serializeVcard(v: VCard): string {
  const t = escapeText;
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${[v.lastName, v.firstName, "", "", ""].map(t).join(";")}`, `FN:${t(fullName(v))}`];
  if (v.org) lines.push(`ORG:${t(v.org)}`);
  // A card without a person's name is a company card (Apple Contacts shows the organization as the name).
  if (!v.firstName && !v.lastName) lines.push("X-ABShowAs:COMPANY");
  if (v.title) lines.push(`TITLE:${t(v.title)}`);
  for (const p of v.phones) lines.push(`TEL;TYPE=${TEL[p.type]}:${p.number}`);
  for (const e of v.emails) lines.push(`EMAIL;TYPE=INTERNET:${e}`);
  // URL values are URIs (checked http(s) hrefs: no spaces or line breaks), not escaped text.
  for (const w of v.websites) lines.push(`URL:${w}`);
  const a = v.address;
  if (a.street || a.city || a.region || a.postalCode || a.country)
    lines.push(`ADR:;;${[a.street, a.city, a.region, a.postalCode, a.country].map(t).join(";")}`);
  if (v.note) lines.push(`NOTE:${t(v.note)}`);
  if (v.photo) {
    const type = photoType(decodePhoto(v.photo) ?? "");
    if (type) lines.push(`PHOTO;ENCODING=b;TYPE=${type}:${v.photo}`);
  }
  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** The stored row's card: `data` (JSON, no photo) and `photo`. A malformed row reads as an empty card, never a throw. */
export function vcardOfRow(data: unknown, photo: unknown): VCard {
  const base = emptyVcard();
  try {
    const d = JSON.parse(String(data)) as Partial<VCard>;
    return { ...base, ...d, address: { ...base.address, ...(d.address ?? {}) }, photo: typeof photo === "string" ? photo : null };
  } catch {
    return { ...base, photo: typeof photo === "string" ? photo : null };
  }
}

/** The `data` column: every field but the photo, which has its own column. */
export const vcardData = ({ photo: _, ...rest }: VCard): string => JSON.stringify(rest);
