-- S9 vCard links: a link is a redirect ('url') or a contact card ('vcard') that downloads as a .vcf instead of redirecting.
-- A vCard link keeps a fixed placeholder url (src/vcard.ts VCARD_URL), so every existing check and constraint on links.url still holds.
ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'url' CHECK(kind IN ('url','vcard'));
-- The card: `data` is the fields as JSON (no photo), `photo` a base64 JPEG or PNG (at most 64 KB decoded) or NULL.
CREATE TABLE vcards (
  link_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  photo TEXT
);
-- Every way a link is deleted (single, bulk, a forwarder cascade) takes its card with it.
CREATE TRIGGER vcards_follow_link AFTER DELETE ON links BEGIN DELETE FROM vcards WHERE link_id = OLD.id; END;
