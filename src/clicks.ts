// Pure click classification for analytics. No raw IP, full user agent or full referrer leaves these helpers.
export const QR_PARAM = "lw";
export const QR_VALUE = "qr";
/** User-agent cap before any regex runs (agent regex cost grows faster than linear on crafted long agents). */
export const UA_MAX = 512;

export type Device = "mobile" | "tablet" | "desktop" | "other";
export type Kind = "human" | "bot" | "preview";
export type Source = "qr" | "typed";

const PREVIEW_RE =
  /Slackbot-LinkExpanding|Slack-ImgProxy|Twitterbot|facebookexternalhit|Facebot|LinkedInBot|WhatsApp|TelegramBot|Discordbot|SkypeUriPreview|Iframely|Embedly|redditbot|Pinterestbot|vkShare|Viber|Snapchat|Mastodon|Bluesky|Cardyb|MicrosoftPreview|Google-PageRenderer|\bLine\//i;
const BOT_RE =
  /bot|crawl|spider|slurp|curl\/|wget\/|python-requests|python-urllib|httpx|aiohttp|go-http-client|okhttp|java\/|libwww|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptimerobot|statuscake|GPTBot|ClaudeBot|anthropic-ai|PerplexityBot|Bytespider|Amazonbot|CCBot|ahrefs|semrush|MJ12bot|DotBot/i;

export function deviceOf(ua: string): Device {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return "mobile";
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return "desktop";
  return "other";
}

export function classifyAgent(ua: string | null, verifiedBot?: string): { kind: Kind; device: Device } {
  const s = ua ?? "";
  const device = deviceOf(s);
  if (!s) return { kind: "bot", device };
  if (verifiedBot) return { kind: "bot", device };
  if (PREVIEW_RE.test(s)) return { kind: "preview", device };
  if (BOT_RE.test(s)) return { kind: "bot", device };
  return { kind: "human", device };
}

// Buckets only (S10): a closed set plus "Other", never the raw agent. Order matters (iPad agents say "like Mac OS X", Android says Linux).
const OS: readonly (readonly [string, RegExp])[] = [
  ["iOS", /iPhone|iPad|iPod/], ["Android", /Android/], ["ChromeOS", /CrOS/], ["Windows", /Windows/],
  ["macOS", /Macintosh|Mac OS X/], ["Linux", /Linux|X11/],
];
// Edge, Opera and Samsung also say Chrome; Chrome also says Safari; so the specific ones go first.
const BROWSERS: readonly (readonly [string, RegExp])[] = [
  ["Edge", /Edg(?:e|A|iOS)?\//], ["Opera", /OPR\/|Opera/], ["Samsung Internet", /SamsungBrowser\//],
  ["Firefox", /Firefox\/|FxiOS\//], ["Chrome", /Chrome\/|CriOS\//], ["Safari", /Safari\//],
];
const bucket = (ua: string, table: typeof OS) => table.find(([, re]) => re.test(ua))?.[0] ?? "Other";
export const osOf = (ua: string): string => bucket(ua, OS);
export const browserOf = (ua: string): string => bucket(ua, BROWSERS);

/** The first Accept-Language tag, lowercased, its first two subtags only ("zh-Hant-TW" is "zh-hant"); "" when there is none. */
export function languageOf(h: string | null): string {
  const tag = (h ?? "").slice(0, 200).split(",")[0]!.split(";")[0]!.trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(tag) ? tag.split("-").slice(0, 2).join("-") : "";
}

// The same set as email.ts UNSAFE (controls, zero-width, bidi), built from code points so the dashboard bundle (qr.ts imports this file) never pulls email.ts.
const UNSAFE = new RegExp(
  `[${[[0x0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a!)}-${String.fromCharCode(b!)}`).join("")}]`,
  "g",
);

/** City as Cloudflare gives it (region when there is no city) with the country, so two Springfields stay apart; "" when cf has neither. */
export function placeOf(cf: { city?: unknown; region?: unknown } | undefined, country: string): string {
  const pick = (v: unknown) => (typeof v === "string" ? v.replace(UNSAFE, "").trim().slice(0, 64) : "");
  const p = pick(cf?.city) || pick(cf?.region);
  return p ? `${p}, ${country}` : "";
}

export function referrerHost(ref: string | null): string {
  if (!ref) return "";
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "").slice(0, 100);
  } catch {
    return "";
  }
}

/** S13 R4: the print code of `lw=qr.<code>`; any other shape still counts as a plain QR scan with no code. */
export const PRINT_CODE_RE = /^[a-z0-9]{3,16}$/;

// Works on the raw query string so pass-through keeps the visitor's exact encoding. `lw=qr` and every `lw=qr.<anything>`
// are QR markers and are stripped; `code` is the first well-shaped print code, "" otherwise.
export function splitQrMarker(search: string): { qr: boolean; code: string; search: string } {
  const parts = search.replace(/^\?/, "").split("&");
  const mark = `${QR_PARAM}=${QR_VALUE}`;
  const isMark = (p: string) => p === mark || p.startsWith(`${mark}.`);
  const rest = parts.filter((p) => !isMark(p));
  const qr = rest.length !== parts.length;
  const code = parts.filter(isMark).map((p) => p.slice(mark.length + 1)).find((c) => PRINT_CODE_RE.test(c)) ?? "";
  const joined = rest.join("&");
  return { qr, code, search: joined ? `?${joined}` : "" };
}

/** S13 R3: a visitor-controlled value (UTM) with controls stripped, trimmed, lowercased and cut to 64 characters; "" when absent. */
export const utmValue = (v: string | null): string => (v ?? "").slice(0, 1000).replace(UNSAFE, "").trim().toLowerCase().slice(0, 64).trim();

export async function visitorHash(salt: string | undefined, day: string, ip: string, ua: string): Promise<string> {
  if (!salt) return "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${day}|${ip}|${ua}`)));
  return Array.from(sig.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
