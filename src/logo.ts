// Instance logo (R7, raster only): stored in KV under LOGO_KEY with metadata { type, v }, shown only through <img>, served with LOGO_HEADERS.
// SVG is refused outright: a deny-list filter over XML cannot be made safe (namespaces, declared encodings, CSS loads).
export const LOGO_KEY = "instance:logo";
export const LOGO_MAX_BYTES = 64 * 1024;
const MAX_PX = 1024;
export const LOGO_TYPES = ["image/png", "image/webp", "image/jpeg"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
export const LOGO_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "inline",
  "Cache-Control": "private, max-age=300",
} as const;

export type LogoCheck = { ok: true; type: LogoType } | { ok: false; reason: "too_large" | "logo_type" | "not_square" };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]; // signature + IHDR length and type
const at = (b: Uint8Array, i: number, s: string) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** Type and size from the bytes alone, or null when the header is not one we can read. */
function sniff(b: Uint8Array): { type: LogoType; w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && PNG_SIG.every((v, i) => b[i] === v)) return { type: "image/png", w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b.length >= 30 && at(b, 0, "RIFF") && at(b, 8, "WEBP")) {
    if (at(b, 12, "VP8X")) return { type: "image/webp", w: le24(b, 24) + 1, h: le24(b, 27) + 1 };
    if (at(b, 12, "VP8L") && b[20] === 0x2f) {
      const v = dv.getUint32(21, true);
      return { type: "image/webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (at(b, 12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
      return { type: "image/webp", w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the first start-of-frame marker (C0 to CF, except DHT C4, JPG C8 and DAC CC).
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) { i++; continue; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

/** The declared type is never trusted: the bytes decide, and anything but PNG, WebP or JPEG is logo_type. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const s = sniff(bytes);
  if (!s || !s.w || !s.h) return { ok: false, reason: "logo_type" };
  if (s.w !== s.h) return { ok: false, reason: "not_square" };
  return s.w > MAX_PX ? { ok: false, reason: "too_large" } : { ok: true, type: s.type };
}
