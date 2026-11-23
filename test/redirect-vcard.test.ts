import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { harness, now, seed, visit } from "./helpers/redirect";
import { emptyVcard, vcardData, VCARD_URL } from "../src/vcard";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5));

/** The seeded `spring` link turned into a vCard link. */
async function vcardLink(o: Record<string, unknown> = {}) {
  const d = await seed(o);
  await run("UPDATE links SET kind = 'vcard', url = ? WHERE id = ?", VCARD_URL, d.link);
  await run("INSERT INTO vcards (link_id, data, photo) VALUES (?,?,?)", d.link,
    vcardData({ ...emptyVcard(), firstName: "Ada", lastName: "Lovelace", phones: [{ type: "cell", number: "+1 555 0100" }] }), JPEG);
  return d;
}

describe("vCard link", () => {
  it("200 with the contact file, attachment named after the slug; no redirect", async () => {
    const d = await vcardLink();
    const r = await exports.default.fetch(`https://${d.host}/Spring?x=1`, { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="spring.vcf"');
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    const body = await r.text();
    expect(body).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\nN:Lovelace;Ada;;;\r\n/);
    expect(body).toContain("TEL;TYPE=CELL:+1 555 0100\r\n");
    expect(body).toContain(`PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}\r\n`);
  });

  it("HEAD answers the headers without a body; POST is not allowed", async () => {
    const d = await vcardLink();
    const h = await exports.default.fetch(`https://${d.host}/spring`, { method: "HEAD" });
    expect([h.status, h.headers.get("content-type"), await h.text()]).toEqual([200, "text/vcard; charset=utf-8", ""]);
    expect((await exports.default.fetch(`https://${d.host}/spring`, { method: "POST" })).status).toBe(405);
  });

  it("counts the click like a redirect, with the QR marker", async () => {
    const d = await vcardLink();
    const { points, go } = harness();
    const r = await go(d.host, "/spring?lw=qr", visit());
    expect(r.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs!.slice(1, 3)).toEqual([d.link, "spring"]);
    expect(points[0]!.blobs![6]).toBe("qr");
  });

  it("start and expiry apply: not yet started or expired is not found", async () => {
    const early = await vcardLink({ starts: now() + 3600 });
    expect((await exports.default.fetch(`https://${early.host}/spring`, { redirect: "manual" })).status).toBe(404);
    const late = await vcardLink({ expires: now() - 1 });
    expect((await exports.default.fetch(`https://${late.host}/spring`, { redirect: "manual" })).status).toBe(404);
  });

  it("a vCard link without its card row is not found, never a redirect to the placeholder", async () => {
    const d = await seed();
    await run("UPDATE links SET kind = 'vcard', url = ? WHERE id = ?", VCARD_URL, d.link);
    const r = await exports.default.fetch(`https://${d.host}/spring`, { redirect: "manual" });
    expect(r.status).toBe(404);
  });

  it("deleting the link deletes its card (trigger)", async () => {
    const d = await vcardLink();
    await run("DELETE FROM links WHERE id = ?", d.link);
    expect(await env.DB.prepare("SELECT 1 FROM vcards WHERE link_id = ?").bind(d.link).first()).toBeNull();
  });
});
