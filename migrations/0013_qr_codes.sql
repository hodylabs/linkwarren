-- S9 QR codes that are not short links. `data` is the kind's non-secret content (JSON); `secret` is the Wi-Fi password,
-- AES-GCM encrypted with SECRETS_KEY (src/secrets.ts encryptValue, AAD `qr.<id>`), NULL when there is none. `style` holds
-- the colors and error correction level (JSON). A `link` code stores the link id in `data`, never its URL.
CREATE TABLE qr_codes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  secret TEXT,
  style TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Members list their own codes, newest first.
CREATE INDEX qr_codes_created_by ON qr_codes(created_by, created_at);
