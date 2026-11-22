// No imports: shared by the Worker (src/api/links.ts) and the dashboard (web/src/links/rules.ts) so the two cannot drift.

/** NFC-normalizes (never trims) and checks 8 to 128 code points. */
export function passwordRule(raw: string): { ok: true; value: string } | { ok: false; reason: "password_short" | "password_long" } {
  const value = raw.normalize("NFC");
  const n = [...value].length;
  if (n < 8) return { ok: false, reason: "password_short" };
  if (n > 128) return { ok: false, reason: "password_long" };
  return { ok: true, value };
}
