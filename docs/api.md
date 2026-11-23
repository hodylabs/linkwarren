---
title: API reference
description: The /api/v1 machine API for scripts, authenticated with personal API keys. Every endpoint, with its shapes, errors and a curl example.
slug: docs/api
---

# API reference

`/api/v1` is the API for scripts. It covers links, domains and link click counts. Everything else (people, roles, settings, domain administration, imports, the audit log) stays in the dashboard; any other path under `/api/v1` answers `404 {"error":"not_found"}`. How to create a key, and the AI agent side, are in [agents.md](agents.md).

## Base URL and authentication

The base URL is `https://<dashboard host>/api/v1`, always at the root of the host: `https://dash.example.com/api/v1`, or `https://example.com/api/v1` with the dashboard at `https://example.com/dashboard` (never under the dashboard path).

Send a personal API key as a Bearer token: `Authorization: Bearer lw_...`. Keys are created on the API & agents screen, shown once, and kept only as a hash. Each key has:

- **access**: read only (the default), read and write, or read, write and delete;
- **domains**: every domain the person can use, or a chosen few;
- **expiry**: 30, 90 or 365 days.

A key acts as its person with their current role, narrowed by the key's access and domains. It never does more than the person could in the dashboard. Changes made with a key appear in the audit log as "person via API key name".

Request bodies are JSON (`Content-Type: application/json`). No `Origin` header is needed. Times are Unix seconds. Ids are strings.

The examples use:

```sh
export LW_KEY='<your key>'
export LW=https://dash.example.com/api/v1
```

Keep the key in an environment variable, not on the command line or in a file you commit. The examples pass it with `-H`, so the expanded key is in curl's arguments while it runs; on a machine other people can log in to, give curl the header on standard input instead:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$LW_KEY" | curl -s -K - "$LW/domains"
```

## Errors

Errors are JSON, `{"error":"<code>"}`, with these statuses on every endpoint:

| Status | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | No `Authorization` header. |
| 401 | `invalid_key` | Wrong, revoked or expired key, or its person is disabled. |
| 403 | `keys_not_allowed` | The person's role does not allow personal API keys. The key is kept and works again if the role gets the permission back. |
| 403 | `read_only` | A read-only key tried to create or change a link. |
| 403 | `delete_not_allowed` | The key may not delete links. |
| 403 | `forbidden` | Not a domain or link this key may use, or the role does not allow it. |
| 404 | `not_found` | No such link or domain, or a path that is not part of `/api/v1`. |
| 415 | `unsupported_media_type` | A body that is not JSON. |
| 429 | `rate_limited` | A rate limit was reached (below). |
| 503 | `unavailable` | The database or the rate limiter could not be reached. Nothing was done. |

## Rate limits

Keys and AI agents share these limits: 120 requests per minute per person, 60 per minute per key, 1000 per person per UTC day, and 3000 per UTC day for the whole instance. A refused request writes nothing. Bulk requests count once per minute, and one unit per link on the daily caps. The reasons and the costs are in [deploy.md](deploy.md#limits).

## The link object

Every endpoint that returns a link returns this shape:

```json
{
  "id": "6f1c0d2e-...",
  "domainId": "a1b2...",
  "slug": "spring",
  "slugKey": "spring",
  "url": "https://example.org/spring-sale",
  "redirectCode": 302,
  "startsAt": null,
  "expiresAt": 1767225600,
  "passQuery": true,
  "routes": [{ "countries": [], "devices": ["ios"], "url": "https://apps.example.com/ios" }],
  "forwardTo": null,
  "kind": "url",
  "createdBy": "<person id>",
  "updatedBy": "<person id>",
  "createdAt": 1764547200,
  "updatedAt": 1764547200,
  "hasPassword": false
}
```

- `slugKey` is the slug as it is matched: lowercased on a domain that is not case-sensitive.
- `routes` are tried in order; see [links.md](links.md#routing-r).
- `forwardTo` is `null` for a normal link, and the id of the moved link for a forwarder (an old address left by a move).
- The password is never returned, only `hasPassword`.
- `kind` is `url` (a redirect) or `vcard` (a [contact card](vcards.md)). A card also has a `vcard` object, its `url` is the fixed placeholder `https://vcard.invalid/`, and it never has a password or routes. Reading one link (`GET /links/{id}`, `GET /links/by-slug`) returns the card with its `photo`; lists and bulk results return `hasPhoto` (true or false) instead, to keep pages small.

## Domains

### `GET /domains`

The domains this key can create links on, sorted by host. Any key.

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/domains"
```

```json
[
  {
    "id": "a1b2...", "host": "go.example.com", "type": "main", "status": "active", "ownerId": "<person id>",
    "bareRedirect": null, "notfoundRedirect": "https://example.com/", "caseSensitive": false, "noindex": true,
    "reservedExtra": [], "createdAt": 1764547200, "isMember": false
  }
]
```

`type` is `main`, `shared` or `private`; `status` is `active`, `pending` or `disabled`. Link counts and Cloudflare details are only in the dashboard.

## Links

### `GET /links`

Search the links this key can see, newest first, 50 per page. Any key.

| Query | Meaning |
| --- | --- |
| `q` | Matches the slug or the destination (substring). At most about 48 characters (`400 q_too_long`). |
| `domain` | A domain id. `404 not_found` if it does not exist, `403 forbidden` if the key cannot use it. |
| `status` | `active`, `scheduled` (starts in the future) or `expired`. Anything else is `400 bad_status`. |
| `mine` | `1`: only links the key's person created. |
| `cursor` | The `next` value of the previous page (`400 bad_cursor` if malformed). |

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links?q=spring&domain=<domain id>"
```

```json
{ "items": [ { "id": "...", "slug": "spring", "...": "..." } ], "next": "1764547200.6f1c0d2e-..." }
```

`next` is `null` on the last page.

### `GET /links/check`

Whether a slug is free on a domain. Any key. Query: `domain` (a domain id) and `slug`.

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/check?domain=<domain id>&slug=spring"
```

Answers `{"status": "available"}`, `"taken"`, `"locked"` (a deleted link's slug, see [links.md](links.md#slug-locks)), `"reserved"`, or `{"status":"invalid","reason":"<code>"}` with `empty`, `slug_too_long`, `charset` or `leading_dot`. Errors: `404 not_found` (domain), `403 forbidden`.

### `GET /links/by-slug`

One link by its domain and slug. Any key. Query: `domain` (a domain id) and `slug`. The slug is matched the way the domain matches it (case-insensitive unless the domain is case-sensitive).

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/by-slug?domain=<domain id>&slug=spring"
```

Answers a link. Errors: `404 not_found` (domain or link), `403 forbidden`.

### `GET /links/{id}`

One link by id. Any key.

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/<link id>"
```

Answers a link. Errors: `404 not_found`, `403 forbidden`.

### `POST /links`

Create a link. Needs a write key and **Create links** in the role.

| Field | Required | Meaning |
| --- | --- | --- |
| `domainId` | yes | The domain id. |
| `slug` | yes | 1 to 64 of letters, digits, `.`, `_`, `~`, `-`; not starting with a dot. |
| `url` | yes, except for a card | The destination: `http(s)`, `tel:` or `mailto:` (see [links.md](links.md#destinations)). Leave it out for a contact card. |
| `kind` | no | `url` (the default) or `vcard`. |
| `vcard` | for a card | The card's fields (see [Contact cards](#contact-cards)). Only with `kind: "vcard"`. |
| `redirectCode` | no | `301` or `302`. Default: the instance default (`302` unless changed in Settings); always `302` when a password is set. |
| `passQuery` | no | Pass the visitor's query string through. Default: the instance default (on unless changed). |
| `startsAt`, `expiresAt` | no | Unix seconds, or `null`. |
| `password` | no | 8 to 128 characters. Never returned. |
| `routes` | no | Up to 10 rules, each `{ "countries": ["US"], "devices": ["ios"], "url": "..." }`, with at least one country or device. |

```sh
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"domainId":"<domain id>","slug":"spring","url":"https://example.org/spring-sale"}' "$LW/links"
```

Answers `201` with the link. Errors:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_body` | A field is missing, has the wrong type, or is unknown. |
| 400 | `empty`, `slug_too_long`, `charset`, `leading_dot`, `reserved` | The slug. |
| 400 | `not_url`, `scheme`, `userinfo`, `url_too_long`, `loop`, `bad_tel`, `bad_mailto` | The destination. `loop`: it points at one of your own short domains or the dashboard. |
| 400 | `bad_window` | `expiresAt` is not after `startsAt`. |
| 400 | `password_short`, `password_long` | The password is under 8 or over 128 characters. |
| 400 | `password_301` | A protected link cannot use `301`. |
| 400 | `bad_route` | A route is wrong; the answer also has `index` (which route) and `reason` (`route_country`, `route_empty`, or a destination code). |
| 400 | `bad_vcard` | A card field is wrong; the answer also has `field` (see [Contact cards](#contact-cards)). |
| 400 | `vcard_url`, `vcard_rule` | A card was sent a `url`, or a password or routes. |
| 404 | `not_found` | No such domain. |
| 403 | `forbidden` | The key cannot use that domain, or the role cannot create links. |
| 409 | `taken` | The slug is already in use on that domain. |
| 409 | `locked` | The slug is locked. |

### `PATCH /links/{id}`

Change a link. Needs a write key and the right to edit that link (see [links.md](links.md#who-can-change-a-link)). Send only the fields to change: `url`, `redirectCode`, `passQuery`, `startsAt`, `expiresAt`, `password` (a string sets it, `null` removes it) and `routes` (replaces the whole list; `[]` clears it). The domain and slug of a link cannot be changed here; use a bulk move.

```sh
# Change the destination
curl -s -X PATCH -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.org/summer-sale"}' "$LW/links/<link id>"

# Send iPhone and Android visitors to app store pages
curl -s -X PATCH -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"routes":[{"devices":["ios"],"url":"https://apps.example.com/ios"},{"devices":["android"],"url":"https://apps.example.com/android"}]}' \
  "$LW/links/<link id>"
```

On a contact card, send `vcard` to replace the whole card (and `startsAt` or `expiresAt` as for any link).

Answers `200` with the link. Errors: the same validation codes as `POST`, plus `404 not_found`, `403 forbidden`, `409 forwarder` (a forwarder is never edited, only deleted), `409 conflict` (the link changed since it was read; read it again and retry), `400 kind_change` (a `kind` other than the link's own) and `400 not_vcard` (`vcard` on a link that is not a card).

### Contact cards

A contact card link is created with `"kind": "vcard"` and a `vcard` object, and no `url`. Every field is optional, but the card needs a first name, a last name or an organization. A field left out is empty.

| Field | Meaning |
| --- | --- |
| `firstName`, `lastName` | At most 100 characters each. |
| `org`, `title` | Organization (at most 200) and job title (at most 100). |
| `phones` | Up to 10, each `{ "type": "work", "number": "+1 555 0100" }`. `type` is `cell` (the default), `work`, `home` or `other`; the number takes digits, spaces and `+ - ( ) . /`, at most 40 characters. |
| `emails` | Up to 10 plain email addresses. |
| `websites` | Up to 10 `http(s)` addresses. |
| `address` | `{ "street", "city", "region", "postalCode", "country" }`. |
| `note` | At most 1000 characters; line breaks allowed. |
| `photo` | Base64 of a JPEG or PNG, at most 64 KB decoded, or `null`. |

One-line fields refuse line breaks and control characters. A card that fails a check answers `400 {"error":"bad_vcard","field":"<field>"}`, where `field` is for example `name`, `photo`, `phones.0`, `emails.1`, `websites.2`, `address.city` or `note`.

```sh
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"domainId":"<domain id>","slug":"ada","kind":"vcard","vcard":{"firstName":"Ada","lastName":"Lovelace","org":"Example Ltd","phones":[{"type":"work","number":"+1 555 0100"}],"emails":["ada@example.com"]}}' \
  "$LW/links"
```

`GET /links?q=` matches a card by its name or organization as well as its slug.

### `DELETE /links/{id}`

Delete a link. Needs a key with delete access and the right to edit that link. The slug is locked, and any forwarders that lead to the link are deleted and locked too.

```sh
curl -s -X DELETE -H "Authorization: Bearer $LW_KEY" "$LW/links/<link id>"
```

Answers `204` with no body. Errors: `404 not_found`, `403 forbidden`, `409 conflict`.

### `POST /links/bulk`

Change up to 50 links in one request. Needs a write key and **Change many links at once** in the role; a `delete` needs delete access; a `copy` move also needs **Create links**. Each link is then checked with the same rules as a single change.

The body has an `action`, the `ids` (1 to 100 ids, at most 50 distinct after duplicates are dropped), and the fields of the action:

| `action` | Other fields |
| --- | --- |
| `delete` | none |
| `schedule` | `startsAt` and/or `expiresAt` (a time or `null`), or `endNow: true` (ends the links now; not together with `expiresAt`) |
| `redirect` | `redirectCode` (`301` or `302`) and/or `passQuery` |
| `password` | `password`: a string to set, `null` to remove |
| `move` | `domainId` (the target, which must be active) and `oldAddress`: `"forward"` or `"copy"` (required, no default) |

```sh
# Take links offline now
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"schedule","ids":["<link id>","<link id>"],"endNow":true}' "$LW/links/bulk"

# Move to another domain; the old addresses forward to the new ones
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"move","ids":["<link id>"],"domainId":"<target domain id>","oldAddress":"forward"}' "$LW/links/bulk"
```

The answer is `{ "results": [...], "pending": [...] }`, with results in the order of the ids. Each result is `{ "id", "ok": true, "link" }` (the changed link, or for a copy the new one; no `link` for a delete) or `{ "id", "ok": false, "error" }`. One refused link does not affect the others.

A password is hashed for one link per request. The other ids come back in `pending`: send the same request again with just those ids until `pending` is empty.

```sh
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"password","ids":["<id>","<id>","<id>"],"password":"a long passphrase"}' "$LW/links/bulk"
# {"results":[{"id":"<id>","ok":true,"link":{...}}],"pending":["<id>","<id>"]}
```

Request errors (nothing is changed):

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_body` | Wrong shape, an unknown field, or a schedule or redirect with nothing to change. |
| 400 | `too_many` | More than 50 distinct ids. |
| 400 | `password_short`, `password_long` | The password. |
| 400 | `target_not_active` | A move to a domain that is not active. |
| 403 | `forbidden` | The role cannot bulk edit, or the target domain does not exist or is not usable. |
| 409 | `conflict` | Two identical requests at once: the second was rolled back whole. |
| 429 | `kv_budget` | The instance's daily budget for bulk edits (500 KV deletes per UTC day) is used up, or this request does not fit in what is left. Try after 00:00 UTC. |
| 429 | `rate_limited` | A daily cap would be passed. |

Per-link `error` codes: `not_found`, `forbidden`, `conflict` (the link changed in between), `bad_window`, `password_301`, `vcard_rule` (a password on a contact card), `forwarder` (an old address can only be deleted), `same_domain`, `taken`, `locked`, `reserved`, `duplicate_slug` (two selected links would get the same slug on the target), `loop` (the destination or a route is on the target host), and the slug shape codes (`empty`, `slug_too_long`, `charset`, `leading_dot`).

## Click counts

### `GET /analytics/links`

Daily clicks for up to 50 links over the last 7 UTC days (today included). Any key. Query: `ids`, a comma-separated list of 1 to 50 link ids.

```sh
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/analytics/links?ids=<link id>,<link id>"
```

```json
{
  "items": [
    { "linkId": "<link id>", "days": [0, 3, 1, 0, 8, 2, 5], "clicks": 19, "qr": 4, "topCountry": "DE" }
  ],
  "live": "ok"
}
```

- `days` runs oldest first; `clicks` is their sum; `qr` is how many were QR scans; `topCountry` comes from the days already rolled up into D1 (or `null`).
- `live` is `ok` when Analytics Engine was read for the latest days, `off` when live analytics are not set up (only D1 totals), and `unavailable` when the live read failed.
- Ids that do not exist are left out of `items`.
- Bots and link previews are not counted.

Errors: `400 bad_query` (no ids, more than 50, or a malformed id), `403 forbidden` (a link on a domain the key cannot see analytics for).
