// Pure click classification for analytics. No raw IP, full user agent or full referrer leaves these helpers.
export const QR_PARAM = "lw";
export const QR_VALUE = "qr";

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

// Works on the raw query string so pass-through keeps the visitor's exact encoding.
export function splitQrMarker(search: string): { qr: boolean; search: string } {
  const parts = search.replace(/^\?/, "").split("&");
  const rest = parts.filter((p) => p !== `${QR_PARAM}=${QR_VALUE}`);
  const qr = rest.length !== parts.length;
  const joined = rest.join("&");
  return { qr, search: joined ? `?${joined}` : "" };
}

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
