import { describe, expect, it } from "vitest";
import { checkLogo, LOGO_MAX_BYTES } from "../src/logo";

const be32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer).setUint32(at, v);
/** A PNG header (signature + IHDR) of the given size, padded with zeros to `total` bytes. */
function png(w: number, h: number, total = 64): Uint8Array {
  const b = new Uint8Array(Math.max(total, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  be32(b, 16, w);
  be32(b, 20, h);
  return b;
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** An extended (VP8X) WebP header: canvas width-1 and height-1 as 24-bit little endian at 24 and 27. */
function webp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([...ascii("RIFF"), 56, 0, 0, 0, ...ascii("WEBPVP8X"), 10, 0, 0, 0]);
  b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 24);
  return b;
}
/** A JPEG: SOI, an APP0 segment, then a baseline SOF0 with the size. */
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}
const text = (s: string) => new TextEncoder().encode(s);

describe("checkLogo", () => {
  it("accepts square PNG, WebP and JPEG and names the type from the bytes", () => {
    expect(checkLogo(png(1, 1))).toEqual({ ok: true, type: "image/png" });
    expect(checkLogo(png(64, 64))).toEqual({ ok: true, type: "image/png" });
    expect(checkLogo(png(1024, 1024))).toEqual({ ok: true, type: "image/png" });
    expect(checkLogo(png(8, 8, LOGO_MAX_BYTES))).toEqual({ ok: true, type: "image/png" });
    expect(checkLogo(webp(64, 64))).toEqual({ ok: true, type: "image/webp" });
    expect(checkLogo(jpeg(300, 300))).toEqual({ ok: true, type: "image/jpeg" });
  });
  it("refuses non-square images", () => {
    for (const b of [png(64, 32), webp(64, 32), jpeg(64, 32)]) expect(checkLogo(b)).toEqual({ ok: false, reason: "not_square" });
  });
  it("refuses over 64 KiB and over 1024 px", () => {
    expect(checkLogo(png(8, 8, 65_537))).toEqual({ ok: false, reason: "too_large" });
    expect(checkLogo(png(1025, 1025))).toEqual({ ok: false, reason: "too_large" });
    expect(checkLogo(webp(2000, 2000))).toEqual({ ok: false, reason: "too_large" });
  });
  it("refuses HTML, truncated or zero-size images as logo_type", () => {
    expect(checkLogo(text("<html><script>alert(1)</script></html>"))).toEqual({ ok: false, reason: "logo_type" });
    expect(checkLogo(png(0, 0))).toEqual({ ok: false, reason: "logo_type" });
    expect(checkLogo(png(1, 1).slice(0, 20))).toEqual({ ok: false, reason: "logo_type" });
    expect(checkLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4]))).toEqual({ ok: false, reason: "logo_type" });
    expect(checkLogo(new Uint8Array(0))).toEqual({ ok: false, reason: "logo_type" });
  });
  it("refuses every SVG, including each review probe, simply because SVG is refused", () => {
    for (const s of [
      `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>`,
      `<svg><s:foreignObject xmlns:s="http://www.w3.org/2000/svg"/></svg>`,
      `<svg><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="https://e.x"/></svg>`,
      `<?xml version="1.0" encoding="ISO-2022-JP"?><svg><scr\x1b(Jipt>alert(1)</scr\x1b(Jipt></svg>`,
      `<svg><style>@import url(https://e.x/a.css)</style></svg>`,
      `<svg><rect style="fill:url(https://e.x/a.svg#p)"/></svg>`,
      `<svg><animate attributeName="href" values="https://e.x"/></svg>`,
    ]) expect([s, checkLogo(text(s))]).toEqual([s, { ok: false, reason: "logo_type" }]);
  });
});
