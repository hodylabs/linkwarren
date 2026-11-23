import { describe, expect, it } from "vitest";
import { contrast, mailtoText, payloadOf, qrProblem, smsText, styleProblem, telText, TEXT_MAX, wifiEscape, wifiText } from "../src/qrcode";

describe("QR encodings (S9)", () => {
  it("wifi: WPA with password, not hidden, omits H", () => {
    expect(wifiText({ ssid: "Cafe", security: "WPA", hidden: false }, "pass1234")).toBe("WIFI:T:WPA;S:Cafe;P:pass1234;;");
  });
  it("wifi: hidden network adds H:true", () => {
    expect(wifiText({ ssid: "Lab", security: "WEP", hidden: true }, "abc")).toBe("WIFI:T:WEP;S:Lab;P:abc;H:true;;");
  });
  it("wifi: an open network omits P even when a password is passed", () => {
    expect(wifiText({ ssid: "Guest", security: "nopass", hidden: false }, "ignored")).toBe("WIFI:T:nopass;S:Guest;;");
  });
  it('wifi: escapes \\ ; , : " in the SSID and password', () => {
    expect(wifiEscape('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f');
    expect(wifiText({ ssid: 'My;Net,"1"', security: "WPA", hidden: false }, "p:w\\d")).toBe('WIFI:T:WPA;S:My\\;Net\\,\\"1\\";P:p\\:w\\\\d;;');
  });
  it("url: the URL itself", () => {
    expect(payloadOf("url", { url: " https://example.com/menu " })).toBe("https://example.com/menu");
  });
  it("text: the text itself", () => {
    expect(payloadOf("text", { text: "Hello, world" })).toBe("Hello, world");
  });
  it("email: mailto with subject and body URL-encoded, each only when given", () => {
    expect(mailtoText({ to: "info@example.com", subject: "", body: "" })).toBe("mailto:info@example.com");
    expect(mailtoText({ to: "info@example.com", subject: "Hi & bye", body: "" })).toBe("mailto:info@example.com?subject=Hi%20%26%20bye");
    expect(mailtoText({ to: "info@example.com", subject: "Q?", body: "Line 1\nLine 2" })).toBe("mailto:info@example.com?subject=Q%3F&body=Line%201%0ALine%202");
  });
  it("phone: tel: with digits and a leading +", () => {
    expect(telText({ number: "+1 (555) 123-4567" })).toBe("tel:+15551234567");
  });
  it("sms: SMSTO:<number>:<message>", () => {
    expect(smsText({ number: "+1 555 123 4567", message: "Table 4: ready" })).toBe("SMSTO:+15551234567:Table 4: ready");
    expect(smsText({ number: "5551234", message: "" })).toBe("SMSTO:5551234:");
  });
});

describe("qrProblem", () => {
  it("checks each kind's content", () => {
    expect(qrProblem("wifi", { ssid: "", security: "WPA", hidden: false })).toBe("wifi_ssid");
    expect(qrProblem("wifi", { ssid: "x".repeat(33), security: "WPA", hidden: false })).toBe("wifi_ssid_long");
    expect(qrProblem("wifi", { ssid: "ok", security: "WPA", hidden: false }, "p".repeat(65))).toBe("wifi_password_long");
    expect(qrProblem("wifi", { ssid: "ok", security: "WPA", hidden: false }, "p".repeat(63))).toBeNull();
    expect(qrProblem("url", { url: "ftp://example.com" })).toBe("qr_url");
    expect(qrProblem("url", { url: "https://user:pw@example.com" })).toBe("qr_url");
    expect(qrProblem("url", { url: "https://example.com/" })).toBeNull();
    expect(qrProblem("text", { text: "" })).toBe("qr_text_empty");
    expect(qrProblem("text", { text: "é".repeat(TEXT_MAX) })).toBeNull();
    expect(qrProblem("text", { text: "a".repeat(TEXT_MAX + 1) })).toBe("qr_text_long");
    expect(qrProblem("email", { to: "nope", subject: "", body: "" })).toBe("qr_email");
    expect(qrProblem("email", { to: "a@example.com?cc=b@example.com", subject: "", body: "" })).toBe("qr_email");
    expect(qrProblem("email", { to: "sales#west@example.com", subject: "", body: "" })).toBe("qr_email");
    expect(qrProblem("email", { to: "a%40b@example.com", subject: "", body: "" })).toBe("qr_email");
    expect(qrProblem("email", { to: "a@example.com", subject: "", body: "x".repeat(501) })).toBe("qr_too_long");
    expect(qrProblem("phone", { number: "12" })).toBe("qr_phone");
    expect(qrProblem("phone", { number: "call me" })).toBe("qr_phone");
    expect(qrProblem("sms", { number: "+15551234567", message: "hi" })).toBeNull();
    expect(qrProblem("link", { linkId: "" })).toBe("qr_link");
  });
  it("refuses a payload too big for any error correction level", () => {
    // 500 characters that URL-encode to 6 bytes each.
    expect(qrProblem("email", { to: "a@example.com", subject: "", body: "é".repeat(500) })).toBe("qr_too_long");
  });
});

describe("styleProblem", () => {
  it("needs #RRGGBB colors", () => {
    expect(styleProblem({ fg: "black", bg: "#FFFFFF" })).toBe("bad_color");
    expect(styleProblem({ fg: "#000", bg: "#FFFFFF" })).toBe("bad_color");
    expect(styleProblem({ fg: '#000000"/>', bg: "#FFFFFF" })).toBe("bad_color");
  });
  it("refuses inverted and low-contrast pairs", () => {
    expect(styleProblem({ fg: "#FFFFFF", bg: "#000000" })).toBe("inverted_colors");
    expect(styleProblem({ fg: "#999999", bg: "#AAAAAA" })).toBe("low_contrast");
    expect(styleProblem({ fg: "#15181D", bg: "#FFFFFF" })).toBeNull();
    expect(styleProblem({ fg: "#1D4ED8", bg: "#FFF7E6" })).toBeNull();
  });
  it("computes the WCAG ratio", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });
});
