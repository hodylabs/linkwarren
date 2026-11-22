import { describe, expect, it } from "vitest";
import { readLogoFile } from "./logoFile";

describe("readLogoFile", () => {
  it("refuses a file over 64 KiB before upload", async () => {
    const f = new File([new Uint8Array(70 * 1024)], "big.png", { type: "image/png" });
    expect(await readLogoFile(f)).toEqual({ error: "too_large" });
  });
  it("refuses other types (GIF, SVG)", async () => {
    expect(await readLogoFile(new File([new Uint8Array(10)], "a.gif", { type: "image/gif" }))).toEqual({ error: "logo_type" });
    expect(await readLogoFile(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).toEqual({ error: "logo_type" });
  });
  it("reads a small PNG as base64", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    expect(await readLogoFile(new File([bytes], "a.png", { type: "image/png" }))).toEqual({ type: "image/png", data: "iVBORw0KGgr/" });
  });
  it("encodes a file larger than one chunk correctly", async () => {
    const bytes = new Uint8Array(40_000).map((_, i) => i % 256);
    const r = await readLogoFile(new File([bytes], "a.webp", { type: "image/webp" }));
    expect("data" in r && Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});
