// Instance logo (R7): stored in KV under LOGO_KEY with metadata { type, v }, shown only through <img>, served with LOGO_HEADERS.
export const LOGO_KEY = "instance:logo";
export const LOGO_MAX_BYTES = 64 * 1024;
const MAX_PX = 1024;
export const LOGO_TYPES = ["image/png", "image/svg+xml"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
export const LOGO_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "inline",
  "Cache-Control": "private, max-age=300",
} as const;

export type LogoCheck = { ok: true } | { ok: false; reason: "too_large" | "bad_type" | "not_square" | "unsafe_svg" };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]; // signature + IHDR length and type

// Anything that can run script, pull in another document or resource, or expand entities.
const UNSAFE = [/<script/i, /<foreignobject/i, /<!entity/i, /<!doctype/i, /[\s"'/]on[a-z0-9_.:-]*\s*=/i, /javascript:/i];
const HREF = /href\s*=\s*(["']?)([^"'>]*)/gi;

export function checkLogo(type: string, bytes: Uint8Array): LogoCheck {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (type === "image/png") {
    if (bytes.length < 24 || PNG_SIG.some((v, i) => bytes[i] !== v)) return { ok: false, reason: "bad_type" };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = dv.getUint32(16), h = dv.getUint32(20);
    if (!w || !h) return { ok: false, reason: "bad_type" };
    if (w !== h) return { ok: false, reason: "not_square" };
    return w > MAX_PX ? { ok: false, reason: "too_large" } : { ok: true };
  }
  if (type === "image/svg+xml") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); // drops a leading BOM
    } catch {
      return { ok: false, reason: "bad_type" };
    }
    if (UNSAFE.some((r) => r.test(text))) return { ok: false, reason: "unsafe_svg" };
    for (const m of text.matchAll(HREF)) if (!m[2]!.startsWith("#")) return { ok: false, reason: "unsafe_svg" };
    const body = text.trimStart().replace(/^<\?xml[^>]*\?>\s*/i, "");
    return /^<svg[\s>/]/i.test(body) ? { ok: true } : { ok: false, reason: "bad_type" };
  }
  return { ok: false, reason: "bad_type" };
}
