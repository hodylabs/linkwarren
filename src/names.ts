// Control, zero-width, line-separator and bidi characters (ALM, ZWSP/ZWNJ/ZWJ, LRM/RLM, embeddings, word joiner and invisibles, isolates, BOM).
const HIDDEN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");

/** The one name sanitizer (passkeys and people): strips hidden characters (a name like "evil‮exe" would display reversed), collapses whitespace, 1-40 characters or null. */
export const cleanName = (raw: string): string | null => {
  const n = raw.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  return n && n.length <= 40 ? n : null;
};

/** A provider's display name (untrusted): cleaned, cut to 40 characters, or null. Never fails a sign-in. */
export const providerName = (raw: unknown): string | null =>
  typeof raw === "string" ? cleanName(raw.replace(HIDDEN, "").replace(/\s+/g, " ").trim().slice(0, 40)) : null;
