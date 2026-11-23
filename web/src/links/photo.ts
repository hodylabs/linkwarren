import { PHOTO_B64_MAX } from "../../../src/vcard";

export const PHOTO_SIDE = 256;

/** w x h fitted into a side x side box, aspect kept, never enlarged. */
export function fitSize(w: number, h: number, side = PHOTO_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * A picked image redrawn on a canvas as a base64 JPEG of at most 256x256, so only a small re-encoded copy is ever sent (never
 * the original file, its metadata or an SVG). The quality steps down until it fits the server's 64 KB cap.
 */
export async function resizePhoto(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const { w, h } = fitSize(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no_canvas");
  ctx.fillStyle = "#fff"; // JPEG has no transparency: a transparent PNG gets a white background, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", q);
    const b64 = url.slice(url.indexOf(",") + 1);
    if (url.startsWith("data:image/jpeg;base64,") && b64.length <= PHOTO_B64_MAX) return b64;
  }
  throw new Error("too_big");
}

/** The data: URL a stored photo previews with (PNG by its base64 signature, else JPEG). */
export const photoSrc = (b64: string) => `data:image/${b64.startsWith("iVBORw0KGgo") ? "png" : "jpeg"};base64,${b64}`;
