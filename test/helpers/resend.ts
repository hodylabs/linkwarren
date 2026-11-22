import { vi } from "vitest";

export type SentMail = { to: string[]; from: string; subject: string; text: string; html: string };

/**
 * In-memory Resend: answers only POST https://api.resend.com/emails, any other URL throws so a test never reaches the network.
 * Every attempt is recorded in `sent` when fetch is called (before any hold), so a test can read it right after the response.
 * Restore with vi.restoreAllMocks().
 */
export function fakeResend() {
  const sent: SentMail[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let fail: { status: number; body?: unknown } | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails" || init?.method !== "POST") throw new Error(`unexpected fetch ${url}`);
    const mail = JSON.parse(String(init.body)) as SentMail;
    sent.push(mail);
    const f = fail;
    fail = null;
    if (gate) await gate;
    if (!f) return Response.json({ id: "email-1" });
    return Response.json(typeof f.body === "function" ? f.body(mail) : (f.body ?? { message: "error" }), { status: f.status });
  });
  return {
    sent,
    hold() { gate = new Promise((r) => { open = r; }); },
    release() { open?.(); gate = null; open = null; },
    /** The next call answers `status`; a function body is called with the request mail (to echo it like a real error might). */
    failNext(status: number, body?: unknown) { fail = { status, body }; },
    /** The link token in mail `i` (default the last one). */
    tokenFrom(i = sent.length - 1): string {
      const m = /#token=([A-Za-z0-9_-]{43})/.exec(sent[i]?.text ?? "");
      if (!m) throw new Error(`no token in mail ${i}`);
      return m[1]!;
    },
  };
}
