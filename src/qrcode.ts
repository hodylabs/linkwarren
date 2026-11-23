// QR codes that are not short links (S9): kinds, their exact encodings, input checks and the color rule.
// Pure functions shared by the Worker (src/api/qrcodes.ts) and the dashboard (web/src/qrcodes), so both judge input alike.

export const QR_KINDS = ["wifi", "url", "text", "email", "phone", "sms", "link"] as const;
export type QrKind = (typeof QR_KINDS)[number];
export const WIFI_SECURITY = ["WPA", "WEP", "nopass"] as const;
export type WifiSecurity = (typeof WIFI_SECURITY)[number];
export const ECC_LEVELS = ["L", "M", "Q", "H"] as const;
export type Ecc = (typeof ECC_LEVELS)[number];

/** Plain text is capped so the code stays small enough to scan from a printout (about version 15 at level M). */
export const TEXT_MAX = 300;
export const NAME_MAX = 80;
export const SSID_MAX_BYTES = 32; // the 802.11 limit
export const WIFI_PASSWORD_MAX = 64; // WPA: 8 to 63 characters, or 64 hex digits
export const SUBJECT_MAX = 150;
export const BODY_MAX = 500;
export const SMS_MAX = 300;
/** Any payload: under what version 40 holds at level H (1273 bytes), so every error correction level fits. */
export const PAYLOAD_MAX_BYTES = 1200;
/** WCAG contrast ratio the colors must reach; most scanners also need dark modules on a lighter background. */
export const MIN_CONTRAST = 4.5;

export type QrData = {
  wifi: { ssid: string; security: WifiSecurity; hidden: boolean };
  url: { url: string };
  text: { text: string };
  email: { to: string; subject: string; body: string };
  phone: { number: string };
  sms: { number: string; message: string };
  link: { linkId: string };
};
export type QrStyle = { fg: string; bg: string; ecc: Ecc };
export const DEFAULT_STYLE: QrStyle = { fg: "#15181D", bg: "#FFFFFF", ecc: "M" };

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** `\ ; , : "` each get a backslash, as the Wi-Fi QR format (ZXing) reads them. */
export const wifiEscape = (s: string): string => s.replace(/[\\;,:"]/g, "\\$&");

/** `WIFI:T:<sec>;S:<ssid>;P:<password>;H:true;;`: P left out for an open network, H only when hidden. */
export function wifiText(d: QrData["wifi"], password: string): string {
  const p = d.security === "nopass" ? "" : `P:${wifiEscape(password)};`;
  return `WIFI:T:${d.security};S:${wifiEscape(d.ssid)};${p}${d.hidden ? "H:true;" : ""};`;
}

/** `mailto:<to>`, then subject and body URL-encoded when given. */
export function mailtoText(d: QrData["email"]): string {
  const q = [d.subject && `subject=${encodeURIComponent(d.subject)}`, d.body && `body=${encodeURIComponent(d.body)}`].filter(Boolean);
  return `mailto:${d.to}${q.length ? `?${q.join("&")}` : ""}`;
}

/** Digits and a leading + only. */
export const phoneDigits = (n: string): string => n.trim().replace(/[\s().-]/g, "");
export const telText = (d: QrData["phone"]): string => `tel:${phoneDigits(d.number)}`;
export const smsText = (d: QrData["sms"]): string => `SMSTO:${phoneDigits(d.number)}:${d.message}`;

/** What the code carries for every kind but `link` (that one needs the link's address, see web/src/links/qr.ts qrText). */
export function payloadOf<K extends Exclude<QrKind, "link">>(kind: K, data: QrData[K], password = ""): string {
  switch (kind) {
    case "wifi": return wifiText(data as QrData["wifi"], password);
    case "url": return (data as QrData["url"]).url.trim();
    case "text": return (data as QrData["text"]).text;
    case "email": return mailtoText(data as QrData["email"]);
    case "phone": return telText(data as QrData["phone"]);
    default: return smsText(data as QrData["sms"]);
  }
}

const isWebUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && s.length <= 2048;
  } catch {
    return false;
  }
};
// No URI delimiters (`# % ? &` and list separators): the address goes into mailto: as is, never percent-encoded.
const EMAIL = /^[^\s@,;?&#%]+@[^\s@,;?&#%]+\.[^\s@,;?&#%]+$/;
// With the u flag a valid pair reads as one code point (not Cs), so only unpaired surrogates match.
const LONE_SURROGATE = /\p{Cs}/u;
const PHONE =/^\+?\d{3,20}$/;

/**
 * The first problem with a code's content, as an error code, or null. `password` is the Wi-Fi password the code will carry
 * (the stored one when an edit leaves it out). The `link` kind is checked by the server against the links table.
 */
export function qrProblem(kind: QrKind, data: QrData[QrKind], password = ""): string | null {
  // A lone surrogate makes encodeURIComponent throw and TextEncoder silently swap it for U+FFFD: refuse it up front.
  if ([password, ...Object.values(data)].some((v) => typeof v === "string" && LONE_SURROGATE.test(v))) return "qr_bad_text";
  switch (kind) {
    case "wifi": {
      const d = data as QrData["wifi"];
      if (!d.ssid) return "wifi_ssid";
      if (bytes(d.ssid) > SSID_MAX_BYTES) return "wifi_ssid_long";
      if (password.length > WIFI_PASSWORD_MAX) return "wifi_password_long";
      break;
    }
    case "url":
      if (!isWebUrl((data as QrData["url"]).url.trim())) return "qr_url";
      break;
    case "text": {
      const t = (data as QrData["text"]).text;
      if (!t) return "qr_text_empty";
      if ([...t].length > TEXT_MAX) return "qr_text_long";
      break;
    }
    case "email": {
      const d = data as QrData["email"];
      if (d.to.length > 254 || !EMAIL.test(d.to)) return "qr_email";
      if (d.subject.length > SUBJECT_MAX || d.body.length > BODY_MAX) return "qr_too_long";
      break;
    }
    case "phone":
      if (!PHONE.test(phoneDigits((data as QrData["phone"]).number))) return "qr_phone";
      break;
    case "sms": {
      const d = data as QrData["sms"];
      if (!PHONE.test(phoneDigits(d.number))) return "qr_phone";
      if (d.message.length > SMS_MAX) return "qr_too_long";
      break;
    }
    case "link":
      if (!(data as QrData["link"]).linkId) return "qr_link";
      return null;
  }
  return bytes(payloadOf(kind as Exclude<QrKind, "link">, data as never, password)) > PAYLOAD_MAX_BYTES ? "qr_too_long" : null;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** WCAG relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

/** bad_color (not #RRGGBB), inverted_colors (light on dark, which many scanners miss), low_contrast, or null. */
export function styleProblem(s: Pick<QrStyle, "fg" | "bg">): string | null {
  if (!HEX.test(s.fg) || !HEX.test(s.bg)) return "bad_color";
  if (luminance(s.fg) > luminance(s.bg)) return "inverted_colors";
  return contrast(s.fg, s.bg) < MIN_CONTRAST ? "low_contrast" : null;
}

/** A list or write answer of /api/qr-codes: never the password, only whether one is stored. `link` (link kind only) is null when the link is gone or not on a domain the viewer can use. */
export type QrItem = {
  id: string; name: string; kind: QrKind; data: QrData[QrKind]; style: QrStyle; hasPassword: boolean;
  createdBy: string; createdAt: number; updatedAt: number; link?: { host: string; slug: string } | null;
};
/** GET /api/qr-codes/:id adds the Wi-Fi password (null: none stored, or it cannot be decrypted). */
export type QrRead = QrItem & { password: string | null };
