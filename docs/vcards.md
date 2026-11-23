---
title: Contact card links
description: Short links that download a contact card (vCard) to the phone, with name, phones, emails, websites, address, note and photo.
slug: docs/vcards
---

# Contact card links

A contact card link is a short link that hands the visitor a contact instead of redirecting them. Opening or scanning `go.example.com/ada` downloads a vCard file, and iOS and Android offer to add it to the phone's contacts. Put it on a business card, a badge or a printed QR code.

## Make one in the dashboard

1. Open New link (`N`) and set **Type** to **Contact card**.
2. Pick the domain and the slug, as for any link.
3. Fill in the card. A card needs a first name, a last name or an organization; everything else is optional:
   - first and last name, organization and job title;
   - up to 10 phones, each marked mobile, work, home or other;
   - up to 10 email addresses;
   - up to 10 websites (`http` or `https`);
   - one postal address: street, city, region, postal code and country;
   - a note (at most 1000 characters, line breaks allowed);
   - a photo.
4. Create it. To change the card later, open the link and edit it there.

**The photo.** Pick a JPEG or PNG. The dashboard redraws it in your browser as a JPEG of at most 256 by 256 pixels before it is saved, so only a small copy is sent, never the original file or its metadata. The server accepts JPEG or PNG only (checked by the file's first bytes; SVG and GIF are refused), at most 64 KB, stored with the card in D1.

## What a visitor gets

The short link answers `200` with the card itself as a vCard 3.0 file (`Content-Type: text/vcard; charset=utf-8`, saved as `<slug>.vcf`). vCard 3.0 is the version iOS and Android read most reliably. A card with no person's name is marked as a company card, so Apple Contacts shows the organization as the name.

A contact card behaves like any other link in most ways:

- Clicks and QR scans are counted the same way (see [analytics.md](analytics.md)), and its QR code works as for any link.
- **Starts** and **Ends** apply: outside its window the card answers like a missing link.
- Bulk move and copy carry the card to the new domain, a delete removes it, and forwarders and [slug locks](links.md#slug-locks) work as usual.

And it differs in a few:

- It has no destination. Its stored `url` is the placeholder `https://vcard.invalid/`, which never changes.
- It takes **no password and no routing**: a card is for sharing, so anyone with the short link can download it. Do not put anything on a card you would not print.
- Its redirect type and query pass-through are ignored, because it never redirects.
- Its type is fixed when it is made: a link cannot become a card, or a card a link.

The audit log records that a link is a card, never what is on it.

## Over the API

`POST /api/v1/links` with `"kind": "vcard"` and a `vcard` object (and no `url`) creates a card; `PATCH` with `vcard` replaces the whole card. The fields, their limits and the errors are in [api.md](api.md#contact-cards).

```sh
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"domainId":"<domain id>","slug":"ada","kind":"vcard","vcard":{"firstName":"Ada","lastName":"Lovelace","org":"Example Ltd","phones":[{"type":"work","number":"+1 555 0100"}],"emails":["ada@example.com"],"websites":["https://example.com"]}}' \
  "$LW/links"
```

AI agents can read cards (`get_link` and `search_links` show the fields, with `hasPhoto` instead of the image) but cannot create or edit them; see [mcp.md](mcp.md).

## Import and export

The full export holds each card in the `vcards` table. A JSON import can bring cards back with their `vcard` fields; a CSV cannot (see [import.md](import.md)).
