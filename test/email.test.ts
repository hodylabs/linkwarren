import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayName, emailConfigured, escapeHtml, inviteEmail, sendEmail, signInEmail } from "../src/email";
import type { Env } from "../src/env";
import { putSecretStmts } from "../src/secrets";

// DB: the key resolver falls back to the dashboard-stored value (empty table here) when the Worker secret is unset.
const cfg = (o: Partial<Env> = {}) => ({ DB: env.DB, EMAIL_FROM: "links@example.com", RESEND_API_KEY: "re_test", ...o }) as Env;
const mail = { to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" };
afterEach(() => { vi.restoreAllMocks(); });

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("signInEmail", () => {
  const m = signInEmail({ host: "a<b>.test", url: "https://a<b>.test/sign-in#token=x&y" });
  it("has the exact subject and text", () => {
    expect(m.subject).toBe("Your sign-in link for linkwarren");
    expect(m.text).toBe(
      "Use this link to sign in to linkwarren at a<b>.test:\n\nhttps://a<b>.test/sign-in#token=x&y\n\n" +
        "It works once and expires in 15 minutes. If you did not ask for it, ignore this email. Nobody can sign in without it.\n",
    );
  });
  it("escapes every interpolation in the HTML, one link, no images", () => {
    expect(m.html).not.toContain("a<b>");
    expect(m.html).toContain("a&lt;b&gt;.test");
    expect(m.html).toContain('<a href="https://a&lt;b&gt;.test/sign-in#token=x&amp;y">');
    expect(m.html.match(/<a /g)).toHaveLength(1);
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("<p>It works once and expires in 15 minutes.");
  });
});

describe("emailConfigured", () => {
  it.each([[{}, true], [{ EMAIL_FROM: " " }, false], [{ RESEND_API_KEY: "" }, false], [{ RESEND_API_KEY: undefined }, false]])("%j -> %j", async (o, want) => {
    expect(await emailConfigured(cfg(o as Partial<Env>))).toBe(want);
  });
});

describe("sendEmail", () => {
  it("posts the JSON body with the bearer key and a timeout", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ id: "1" }));
    expect(await sendEmail(cfg(), mail, f as typeof fetch)).toEqual({ ok: true });
    const [u, init] = f.mock.calls[0]!;
    expect(u).toBe("https://api.resend.com/emails");
    expect(init!.method).toBe("POST");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer re_test");
    expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init!.body))).toEqual({ from: "linkwarren <links@example.com>", to: ["a@example.com"], subject: "s", text: "t", html: "<p>t</p>" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it("returns not_configured without a fetch when the key is unset", async () => {
    const f = vi.fn();
    expect(await sendEmail(cfg({ RESEND_API_KEY: undefined }), mail, f as unknown as typeof fetch)).toEqual({ ok: false, reason: "not_configured" });
    expect(f).not.toHaveBeenCalled();
  });
  it("uses the dashboard-stored key when the Worker secret is unset", async () => {
    const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
    await env.DB.batch(await putSecretStmts(cfg({ SECRETS_KEY }), "u1", "RESEND_API_KEY", "re_dashboard_123456"));
    try {
      const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ id: "1" }));
      expect(await sendEmail(cfg({ RESEND_API_KEY: undefined, SECRETS_KEY }), mail, f as typeof fetch)).toEqual({ ok: true });
      expect(new Headers(f.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer re_dashboard_123456");
    } finally {
      await env.DB.batch(["settings", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    }
  });
  it("returns rejected on 422 and logs the status only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => Response.json({ message: "bad re_test a@example.com" }, { status: 422 }));
    expect(await sendEmail(cfg(), mail, f as unknown as typeof fetch)).toEqual({ ok: false, reason: "rejected" });
    expect(warn.mock.calls).toEqual([["resend_rejected", 422]]);
  });
  it("returns network when fetch throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => { throw new Error("boom re_test"); });
    expect(await sendEmail(cfg(), mail, f as unknown as typeof fetch)).toEqual({ ok: false, reason: "network" });
  });
});

describe("displayName", () => {
  it("strips header and quoting characters", () => {
    expect(displayName('Evil\r\nBcc: x"<a>')).toBe("EvilBcc: xa");
    expect(displayName("a\\b\u0007c")).toBe("abc");
  });
  it("trims, cuts to 60 and falls back to linkwarren", () => {
    expect(displayName("  x  ")).toBe("x");
    expect(displayName("y".repeat(80))).toHaveLength(60);
    for (const v of [null, "", "  ", '<>"']) expect(displayName(v)).toBe("linkwarren");
  });
});

describe("inviteEmail", () => {
  const o = { instanceName: "Acme", inviter: "Bo", dashboardHost: "links.example.com", role: "member" as const };
  it("has the exact subject and text, no owner line for members", () => {
    const m = inviteEmail(o);
    expect(m.subject).toBe("You're invited to Acme");
    expect(m.text).toBe("Bo invited you to Acme, a link shortener.\nSign in at https://links.example.com/ with your email.\n");
    expect(m.html).toContain('<a href="https://links.example.com/">https://links.example.com/</a>');
    expect(m.html).not.toContain("owner");
  });
  it("adds the owner line only for owners", () => {
    const m = inviteEmail({ ...o, role: "owner" });
    expect(m.text).toContain("You will be an owner: you can manage every person, domain and link.");
    expect(m.html).toContain("You will be an owner");
  });
  it("escapes names in HTML, raw only in text, and strips CR/LF from the subject", () => {
    const m = inviteEmail({ ...o, instanceName: "<b>x</b>", inviter: "<i>Bo</i>" });
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).not.toContain("<b>");
    expect(m.text).toContain("<b>x</b>");
    expect(inviteEmail({ ...o, instanceName: "A\r\nBcc: x" }).subject).not.toMatch(/[\r\n]/);
  });
  it("never mentions the old sign-in products", () => {
    for (const role of ["owner", "member"] as const) expect(inviteEmail({ ...o, role }).text).not.toMatch(/Google|one-time code|Access/);
  });
});

describe("instance name", () => {
  it("signInEmail subject uses the name, default linkwarren, CR/LF stripped", () => {
    expect(signInEmail({ host: "h", url: "https://h/x", name: "Acme" }).subject).toBe("Your sign-in link for Acme");
    expect(signInEmail({ host: "h", url: "https://h/x", name: "A\r\nB" }).subject).toBe("Your sign-in link for AB");
  });
  it("sendEmail's from carries the stored instance name (sanitized)", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('instance.name', ?, 1, 'u')").bind(JSON.stringify('Ac"me\r\n<x>')).run();
    try {
      const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ id: "1" }));
      await sendEmail(cfg(), mail, f as typeof fetch);
      expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).from).toBe("Acmex <links@example.com>");
    } finally {
      await env.DB.prepare("DELETE FROM settings").run();
    }
  });
  it("never logs the key", async () => {
    const logs = [vi.spyOn(console, "warn"), vi.spyOn(console, "log"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    await sendEmail(cfg(), mail, (async () => Response.json({}, { status: 500 })) as unknown as typeof fetch);
    expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("re_test");
  });
});
