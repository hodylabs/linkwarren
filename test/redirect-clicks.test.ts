import { describe, expect, it, vi } from "vitest";
import { harness, now, seed, visit } from "./helpers/redirect";

describe("click recording", () => {
  it("one point with the fixed layout per live GET", async () => {
    const d = await seed();
    const h = harness();
    const r = await h.go(d.host, "/spring", visit());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://dest.test/x");
    expect(h.points).toHaveLength(1);
    const p = h.points[0];
    expect(p.indexes).toEqual([d.id]);
    expect(p.doubles).toEqual([1]);
    expect(p.blobs?.slice(0, 8)).toEqual([d.id, d.link, "spring", "CA", "mobile", "instagram.com", "typed", "human"]);
    expect(p.blobs?.[8]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(p)).not.toMatch(/203\.0\.113\.7|iPhone|\/p\/1/);
  });

  it("qr marker is stripped byte for byte and recorded", async () => {
    const d = await seed();
    const h = harness();
    expect((await h.go(d.host, "/spring?a=%20&lw=qr&b=1", visit())).headers.get("location")).toBe("https://dest.test/x?a=%20&b=1");
    expect(h.points[0].blobs?.[6]).toBe("qr");
    expect((await h.go(d.host, "/spring?lw=qrx", visit())).headers.get("location")).toBe("https://dest.test/x?lw=qrx");
    expect(h.points[1].blobs?.[6]).toBe("typed");
    expect((await h.go(d.host, "/spring?lw=qr", visit())).headers.get("location")).toBe("https://dest.test/x");
    expect(h.points[2].blobs?.[6]).toBe("qr");
  });

  it("pass_query off: Location is the stored URL, source still qr", async () => {
    const d = await seed({ pass: 0 });
    const h = harness();
    expect((await h.go(d.host, "/spring?lw=qr", visit())).headers.get("location")).toBe("https://dest.test/x");
    expect(h.points[0].blobs?.[6]).toBe("qr");
  });

  it("chat previews are kind preview; no salt leaves the visitor empty", async () => {
    const d = await seed();
    const h = harness({ salt: null });
    await h.go(d.host, "/spring", visit({ "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" }));
    expect(h.points[0].blobs?.[7]).toBe("preview");
    expect(h.points[0].blobs?.[8]).toBe("");
  });

  it("no point for HEAD, bare domain, unknown slug, expired link, pending domain, robots, favicon", async () => {
    const d = await seed();
    const old = await seed({ expires: now() - 10 });
    const pend = await seed({ status: "pending" });
    const h = harness();
    expect((await h.go(d.host, "/spring", { ...visit(), method: "HEAD" })).status).toBe(302);
    expect((await h.go(d.host, "/", visit())).status).toBe(302);
    expect((await h.go(d.host, "/nope", visit())).status).toBe(404);
    expect((await h.go(d.host, "/robots.txt", visit())).status).toBe(200);
    expect((await h.go(d.host, "/favicon.ico", visit())).status).toBe(204);
    expect((await h.go(old.host, "/spring", visit())).status).toBe(404);
    expect((await h.go(pend.host, "/spring", visit())).status).toBe(200);
    expect(h.points).toHaveLength(0);
  });

  it("writeDataPoint throwing still answers the same redirect, nothing escapes", async () => {
    const d = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({ throws: true });
    const r = await h.go(d.host, "/spring?lw=qr&z=1", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x?z=1"]);
    expect(warn).toHaveBeenCalledWith("click not recorded", "Error");
    warn.mockRestore();
  });

  it("HMAC failing still answers the same redirect", async () => {
    const d = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sign = vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new TypeError("no"));
    const h = harness();
    const r = await h.go(d.host, "/spring", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x"]);
    expect(h.points).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("click not recorded", "TypeError");
    sign.mockRestore();
    warn.mockRestore();
  });

  it("no CLICKS or no ctx: same redirect, no point", async () => {
    const d = await seed();
    const a = harness({ clicks: false });
    expect((await a.go(d.host, "/spring", visit())).headers.get("location")).toBe("https://dest.test/x");
    const b = harness({ ctx: false });
    const r = await b.go(d.host, "/spring", visit());
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x"]);
    expect(b.points).toHaveLength(0);
  });

  it("no point for a scheduled link, a disabled domain or a POST", async () => {
    const later = await seed({ starts: now() + 3600 });
    const off = await seed({ status: "disabled" });
    const d = await seed();
    const h = harness();
    expect((await h.go(later.host, "/spring", visit())).status).toBe(404);
    expect((await h.go(off.host, "/spring", visit())).status).toBe(404);
    expect((await h.go(d.host, "/spring", { ...visit(), method: "POST" })).status).toBe(405);
    expect(h.points).toHaveLength(0);
  });

  it("the marker is case sensitive: LW=qr passes through and counts as typed", async () => {
    const d = await seed();
    const h = harness();
    expect((await h.go(d.host, "/spring?LW=qr", visit())).headers.get("location")).toBe("https://dest.test/x?LW=qr");
    expect(h.points[0].blobs?.[6]).toBe("typed");
  });

  it("no user-agent work before the redirect returns; a 64 KB UA is cut to 512 chars", async () => {
    const d = await seed();
    const h = harness();
    // Human desktop UA in the first 512 chars, a bot word only after them.
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${"a".repeat(600)} bot ${"b".repeat(64 * 1024)}`;
    let returned = false;
    let readBeforeReturn = false;
    const r = await h.go(d.host, "/spring", visit({ "user-agent": ua }), {
      req(req) {
        const get = req.headers.get.bind(req.headers);
        req.headers.get = (k: string) => {
          if (k.toLowerCase() === "user-agent" && !returned) readBeforeReturn = true;
          return get(k);
        };
      },
      returned: () => void (returned = true),
    });
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://dest.test/x"]);
    expect(readBeforeReturn).toBe(false);
    expect(h.points[0].blobs?.slice(4, 8)).toEqual(["desktop", "instagram.com", "typed", "human"]);
  });
});
