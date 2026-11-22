/** What the server takes (src/logo.ts, R7): raster only, at most 64 KiB. The server checks the bytes again; this only saves a wasted upload. */
export const LOGO_ACCEPT = "image/png,image/webp,image/jpeg";
const TYPES = LOGO_ACCEPT.split(",");
const MAX_BYTES = 64 * 1024;

/** The upload body `{ type, data: base64 }`, or the error code the server would answer with. */
export async function readLogoFile(file: File): Promise<{ type: string; data: string } | { error: "logo_type" | "too_large" }> {
  if (!TYPES.includes(file.type)) return { error: "logo_type" };
  if (file.size > MAX_BYTES) return { error: "too_large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  // Chunked: one String.fromCharCode call per 8 KiB keeps the argument list small.
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { type: file.type, data: btoa(bin) };
}
