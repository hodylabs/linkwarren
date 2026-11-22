import { describe, expect, it } from "vitest";
import { checkLogo, LOGO_MAX_BYTES } from "../src/logo";

/** A PNG header (signature + IHDR) of the given size, padded with zeros to `total` bytes. */
function png(w: number, h: number, total = 64): Uint8Array {
  const b = new Uint8Array(Math.max(total, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const svg = (s: string) => new TextEncoder().encode(s);
const PNG = "image/png", SVG = "image/svg+xml";

describe("checkLogo", () => {
  it("accepts square PNGs", () => {
    expect(checkLogo(PNG, png(1, 1))).toEqual({ ok: true });
    expect(checkLogo(PNG, png(64, 64))).toEqual({ ok: true });
    expect(checkLogo(PNG, png(1024, 1024))).toEqual({ ok: true });
    expect(checkLogo(PNG, png(8, 8, LOGO_MAX_BYTES))).toEqual({ ok: true });
  });
  it("refuses a non-square PNG", () => expect(checkLogo(PNG, png(64, 32))).toEqual({ ok: false, reason: "not_square" }));
  it("refuses over 64 KiB and over 1024 px", () => {
    expect(checkLogo(PNG, png(8, 8, 65_537))).toEqual({ ok: false, reason: "too_large" });
    expect(checkLogo(PNG, png(1025, 1025))).toEqual({ ok: false, reason: "too_large" });
  });
  it("refuses HTML labelled PNG, an unknown type and a PNG labelled SVG", () => {
    expect(checkLogo(PNG, svg("<html><script>alert(1)</script></html>"))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo("text/html", png(1, 1))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo("image/webp", png(1, 1))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo(SVG, png(1, 1))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo(PNG, png(0, 0))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo(PNG, png(1, 1).slice(0, 20))).toEqual({ ok: false, reason: "bad_type" });
  });
  it("refuses an SVG without an svg root", () => {
    expect(checkLogo(SVG, svg("<html><svg></svg></html>"))).toEqual({ ok: false, reason: "bad_type" });
    expect(checkLogo(SVG, new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]))).toEqual({ ok: false, reason: "bad_type" });
  });
  it("refuses hostile SVGs", () => {
    for (const s of [
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      `<svg onload="x"></svg>`,
      `<svg><rect ONCLICK = 'x'/></svg>`,
      `<svg><foreignObject><div/></foreignObject></svg>`,
      `<svg><image xlink:href="https://e.x/a.png"/></svg>`,
      `<svg><a href="javascript:x"><rect/></a></svg>`,
      `<svg><a href=" #x"/></svg>`,
      `<svg><style>a{background:url(javascript:x)}</style></svg>`,
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>`,
      `<svg><!ENTITY x "y"></svg>`,
      `<!DOCTYPE svg><svg></svg>`,
    ]) expect([s, checkLogo(SVG, svg(s))]).toEqual([s, { ok: false, reason: "unsafe_svg" }]);
  });
  it("accepts a plain SVG with a local reference", () => {
    expect(checkLogo(SVG, svg(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><g id="g"/><use href="#g"/><use xlink:href="#g"/></svg>`))).toEqual({ ok: true });
    expect(checkLogo(SVG, svg(`﻿  <svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`))).toEqual({ ok: true });
  });
});
