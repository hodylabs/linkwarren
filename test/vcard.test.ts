import { describe, expect, it } from "vitest";
import { checkVcard, emptyVcard, fold, PHOTO_B64_MAX, PHOTO_MAX, serializeVcard, vcardData, vcardOfRow, type VCard } from "../src/vcard";

// The smallest headers that pass the magic-byte check, padded with zero bytes.
const b64 = (bytes: number[], pad = 0) => btoa(String.fromCharCode(...bytes, ...new Array(pad).fill(0)));
export const JPEG = b64([0xff, 0xd8, 0xff, 0xe0], 20);
export const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16);
const card = (o: Partial<VCard> = {}): VCard => ({ ...emptyVcard(), firstName: "Ada", ...o });
const octets = (s: string) => new TextEncoder().encode(s).length;

describe("serializeVcard", () => {
  it("vCard 3.0 with CRLF line endings only and the fields in order", () => {
    const s = serializeVcard(card({
      lastName: "Lovelace", org: "Example Ltd", title: "Engineer",
      phones: [{ type: "cell", number: "+1 555 0100" }, { type: "other", number: "555-0101" }],
      emails: ["ada@example.com"], websites: ["https://example.com/"],
      address: { street: "1 Main St", city: "Springfield", region: "ON", postalCode: "K1A 0B1", country: "Canada" },
      note: "Line one\nLine two",
    }));
    expect(s.endsWith("END:VCARD\r\n")).toBe(true);
    expect(s.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(s.split("\r\n")).toEqual([
      "BEGIN:VCARD", "VERSION:3.0", "N:Lovelace;Ada;;;", "FN:Ada Lovelace", "ORG:Example Ltd", "TITLE:Engineer",
      "TEL;TYPE=CELL:+1 555 0100", "TEL;TYPE=VOICE:555-0101", "EMAIL;TYPE=INTERNET:ada@example.com", "URL:https://example.com/",
      "ADR:;;1 Main St;Springfield;ON;K1A 0B1;Canada", "NOTE:Line one\\nLine two", "END:VCARD", "",
    ]);
  });

  it("escapes backslash, comma, semicolon and newline; a name with a comma and a semicolon stays one component", () => {
    const s = serializeVcard(card({ firstName: "Ann, Jr;", lastName: "O\\Brien", org: "A;B,C", note: "x\ny" }));
    expect(s).toContain("\r\nN:O\\\\Brien;Ann\\, Jr\\;;;;\r\n");
    expect(s).toContain("\r\nFN:Ann\\, Jr\\; O\\\\Brien\r\n");
    expect(s).toContain("\r\nORG:A\\;B\\,C\r\n");
    expect(s).toContain("\r\nNOTE:x\\ny\r\n");
  });

  it("folds at 75 octets, continuation lines start with one space, never inside a UTF-8 character", () => {
    const s = serializeVcard(card({ note: "é".repeat(100) + "z".repeat(80) }));
    const lines = s.split("\r\n");
    for (const l of lines) expect(octets(l)).toBeLessThanOrEqual(75);
    // Unfolding (drop CRLF + one space) gives the original line back.
    expect(s.replace(/\r\n /g, "")).toContain(`NOTE:${"é".repeat(100)}${"z".repeat(80)}\r\n`);
    expect(fold("a".repeat(75))).toBe("a".repeat(75));
    expect(fold("a".repeat(76))).toBe(`${"a".repeat(75)}\r\n a`);
    expect(fold("a".repeat(74) + "é")).toBe(`${"a".repeat(74)}\r\n é`);
  });

  it("writes the photo as PHOTO;ENCODING=b with its type, folded", () => {
    const big = b64([0xff, 0xd8, 0xff], 300);
    const s = serializeVcard(card({ photo: big }));
    expect(s).toContain("\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/");
    expect(s.replace(/\r\n /g, "")).toContain(`PHOTO;ENCODING=b;TYPE=JPEG:${big}\r\n`);
    expect(serializeVcard(card({ photo: PNG }))).toContain("PHOTO;ENCODING=b;TYPE=PNG:");
  });

  it("a company card: FN is the organization and Apple shows it as the name", () => {
    const s = serializeVcard({ ...emptyVcard(), org: "Example Ltd" });
    expect(s).toContain("\r\nN:;;;;\r\nFN:Example Ltd\r\nORG:Example Ltd\r\nX-ABShowAs:COMPANY\r\n");
  });
});

describe("checkVcard", () => {
  it("trims, normalizes websites and line breaks", () => {
    const r = checkVcard(card({ firstName: " Ada ", websites: ["HTTPS://Example.COM"], note: "a\r\nb\rc" }));
    expect(r).toMatchObject({ ok: true, vcard: { firstName: "Ada", websites: ["https://example.com/"], note: "a\nb\nc" } });
  });

  it("needs a first name, a last name or an organization", () => {
    expect(checkVcard(emptyVcard())).toEqual({ ok: false, field: "name" });
    expect(checkVcard({ ...emptyVcard(), org: "X" }).ok).toBe(true);
  });

  it.each([
    [{ firstName: "a\u0000" }, "firstName"],
    [{ title: "a\nb" }, "title"],
    [{ note: "a\u0007" }, "note"],
    [{ phones: [{ type: "cell" as const, number: "call me" }] }, "phones.0"],
    [{ emails: ["a@example.com", "not an email"] }, "emails.1"],
    [{ emails: ["a@example.com\r\nBcc: b@example.com"] }, "emails.0"],
    [{ websites: ["javascript:alert(1)"] }, "websites.0"],
    [{ websites: ["ftp://example.com"] }, "websites.0"],
    [{ address: { ...emptyVcard().address, city: "x\ny" } }, "address.city"],
    [{ phones: new Array(11).fill({ type: "cell", number: "1" }) }, "rows"],
  ])("refuses %j (%s)", (o, field) => {
    expect(checkVcard(card(o as Partial<VCard>))).toEqual({ ok: false, field });
  });

  it("photo: JPEG or PNG by magic bytes only, at most 64 KB decoded", () => {
    expect(checkVcard(card({ photo: JPEG })).ok).toBe(true);
    expect(checkVcard(card({ photo: PNG })).ok).toBe(true);
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const photo of [svg, btoa("GIF89a......"), "not base64!", "abc", b64([0xff, 0xd8, 0xff], PHOTO_MAX)])
      expect(checkVcard(card({ photo }))).toEqual({ ok: false, field: "photo" });
    expect(checkVcard(card({ photo: b64([0xff, 0xd8, 0xff], PHOTO_MAX - 3) })).ok).toBe(true);
    expect(PHOTO_B64_MAX).toBe(87384);
  });
});

describe("storage", () => {
  it("round-trips through the data and photo columns; a broken row reads as empty", () => {
    const v = card({ phones: [{ type: "work", number: "1" }], photo: JPEG });
    expect(vcardOfRow(vcardData(v), v.photo)).toEqual(v);
    expect(JSON.parse(vcardData(v))).not.toHaveProperty("photo");
    expect(vcardOfRow("{", null)).toEqual(emptyVcard());
  });
});
