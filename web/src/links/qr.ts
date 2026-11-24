import { encode } from "uqr";
import { QR_PARAM, QR_VALUE } from "../../../src/clicks";
import { shortUrl } from "./linkView";

const DARK = "#15181D";
const LIGHT = "#FFFFFF";

/** What the QR carries: the short link plus the marker the redirect strips and counts as a QR scan. */
/** S13: a labelled print carries its code after the marker (`?lw=qr.<code>`), so analytics can tell the prints apart. */
export const qrText = (host: string, slug: string, code?: string): string => `${shortUrl(host, slug)}?${QR_PARAM}=${QR_VALUE}${code ? `.${code}` : ""}`;

/** Error correction M unless given; the quiet zone is added when drawing. Throws when the text does not fit a QR code. */
export const qrMatrix = (text: string, ecc: "L" | "M" | "Q" | "H" = "M"): boolean[][] => encode(text, { ecc, border: 0 }).data;

/** Dark modules as horizontal runs in one path, offset by the quiet zone. */
export function qrPath(m: boolean[][], margin = 4): string {
  let d = "";
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (row[end + 1]) end++;
      d += `M${x + margin} ${y + margin}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return d;
}

/** `c` when it is #RRGGBB, else the default: only checked colors ever reach SVG markup. */
const hex = (c: string, dflt: string) => (/^#[0-9A-Fa-f]{6}$/.test(c) ? c : dflt);

/** The path on a white background (or `bg`) with a quiet zone of `margin` modules. A color that is not #RRGGBB falls back to the default. */
export function qrSvg(m: boolean[][], margin = 4, fg = DARK, bg = LIGHT): string {
  fg = hex(fg, DARK);
  bg = hex(bg, LIGHT);
  const size = m.length + 2 * margin;
  const d = qrPath(m, margin);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${bg}"/><path fill="${fg}" d="${d}"/></svg>`;
}

/** Drawn straight from the matrix (no image load), so the canvas is never tainted. */
export function qrPng(m: boolean[][], scale = 16, margin = 4, fg = DARK, bg = LIGHT): Promise<Blob> {
  const size = (m.length + 2 * margin) * scale;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas unavailable"));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = fg;
  m.forEach((row, y) => row.forEach((on, x) => on && ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale)));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png failed"))), "image/png"));
}

export const fileName = (host: string, slug: string, ext: "svg" | "png"): string => `${host}-${slug}`.replace(/[^A-Za-z0-9._-]/g, "-") + `.${ext}`;

export const REVOKE_MS = 1000;

/** Blob download that needs no inline script or style, so it works under the strict CSP. */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Not in the same tick: some browsers cancel a download whose blob URL is revoked that early.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}
