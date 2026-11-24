// S13 capture: per-print QR codes (blob14) and UTM values (blob15-17) on the click point; the redirect itself is unchanged.
import { describe, expect, it } from "vitest";
import { harness, seed, visit } from "./helpers/redirect";

describe("print code and UTM capture", () => {
  it("?lw=qr answers and records exactly as before, with no print code", async () => {
    const d = await seed();
    const h = harness();
    const r = await h.go(d.host, "/spring?a=%20&lw=qr&b=1", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x?a=%20&b=1"]);
    expect(h.points[0].blobs?.[6]).toBe("qr");
    expect(h.points[0].blobs?.[13]).toBe("");
  });

  it("?lw=qr.<code> is a QR scan with its code, and the marker never reaches the destination", async () => {
    const d = await seed();
    const h = harness();
    expect((await h.go(d.host, "/spring?lw=qr.abc123", visit())).headers.get("location")).toBe("https://dest.test/x");
    expect((await h.go(d.host, "/spring?a=%20&lw=qr.abc123&b=1", visit())).headers.get("location")).toBe("https://dest.test/x?a=%20&b=1");
    expect(h.points).toHaveLength(2);
    for (const p of h.points) expect([p.blobs?.[6], p.blobs?.[13]]).toEqual(["qr", "abc123"]);
  });

  it("a malformed code is a QR scan with an empty code, the marker stripped all the same", async () => {
    const d = await seed();
    const h = harness();
    expect((await h.go(d.host, "/spring?lw=qr.NOT-OK&z=1", visit())).headers.get("location")).toBe("https://dest.test/x?z=1");
    expect([h.points[0].blobs?.[6], h.points[0].blobs?.[13]]).toEqual(["qr", ""]);
  });

  it("a typed visit carrying a print-looking value is typed, with no code", async () => {
    const d = await seed();
    const h = harness();
    await h.go(d.host, "/spring?lw=qrx.abc123", visit());
    expect([h.points[0].blobs?.[6], h.points[0].blobs?.[13]]).toEqual(["typed", ""]);
  });

  it("UTM values are normalised (lowercase, trimmed, controls stripped, 64 characters) and still passed through", async () => {
    const d = await seed();
    const h = harness();
    const long = "c".repeat(80);
    const r = await h.go(d.host, `/spring?utm_source=%20News%00Letter%20&utm_medium=EMAIL&utm_campaign=${long}`, visit());
    expect(r.headers.get("location")).toBe(`https://dest.test/x?utm_source=%20News%00Letter%20&utm_medium=EMAIL&utm_campaign=${long}`);
    expect(h.points[0].blobs?.slice(14)).toEqual(["newsletter", "email", "c".repeat(64)]);
  });

  it("the point never holds the IP or the user agent (17 blobs)", async () => {
    const d = await seed();
    const h = harness();
    await h.go(d.host, "/spring?lw=qr.abc123&utm_source=x", visit());
    expect(h.points[0].blobs).toHaveLength(17);
    expect(JSON.stringify(h.points[0])).not.toMatch(/203\.0\.113\.7|iPhone/);
  });
});
