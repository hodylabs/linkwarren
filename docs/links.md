---
title: Links and link rules
description: Slugs and destinations, schedules, passwords, device and country routing, redirect types, moving links, bulk edit and slug locks.
slug: docs/links
---

# Links and link rules

A short link is a domain, a slug and a destination: `go.example.com/spring` sends visitors to `https://example.org/spring-sale`. Each domain has its own slugs, so `a.example.com/spring` and `b.example.com/spring` can go to different places.

Create a link with New link (`N`) on the Links page, from the command palette (`Ctrl+K`), over the [API](api.md) or from an [AI agent](mcp.md). Edits apply everywhere within a few minutes: redirects are cached in KV for up to about 5 minutes.

A link has one of two types, chosen when it is made: **Link**, a redirect (everything on this page), or **Contact card**, which downloads a contact to the visitor's phone instead (see [vcards.md](vcards.md)).

## Slugs

- 1 to 64 characters: letters, digits, `.`, `_`, `~` and `-`. A slug cannot start with a dot.
- Case-insensitive by default: `/Spring` and `/spring` are the same link. A domain can be made case-sensitive in its settings (see [domains.md](domains.md#case-sensitive-slugs)).
- Some words are reserved on every domain: `admin`, `api`, `login`, `logout`, `dash`, `dashboard`, `auth`, `oauth`, `mcp`, `signup`, `register`, `account`, `settings`, `app`, `static`, `assets`, `health`, `status`, `qr`, `.well-known`, `cdn-cgi`, `robots.txt`, `favicon.ico` and `sitemap.xml`. A domain can reserve more in its settings. With the dashboard at a path, the path's segment, `mcp` and `api` are also reserved on the main domain.
- The New link sheet checks the slug as you type: available, taken, locked (see [Slug locks](#slug-locks)) or reserved.

Short links answer over HTTPS only. When a plain-HTTP request reaches linkwarren, a `GET` or `HEAD` gets a `308` to the same address over HTTPS (path and query unchanged) before anything is served, and a `POST` is never redirected (`403` on a protected link, `405` otherwise). When the zone has Cloudflare's "Always Use HTTPS" on, Cloudflare answers plain HTTP itself with a `301` (POST included) before linkwarren sees it. Browsers block a contact card downloaded over plain HTTP.

## Destinations

A destination is one of:

- an `http` or `https` URL, at most 2048 characters, with no user name or password in it, that does not point at one of your own short domains or the dashboard host (`loop`);
- a `tel:` number, for example `tel:+1-555-123-4567`: an optional `+`, digits and `-` `.` `(` `)`, at most 32 characters, no parameters;
- a `mailto:` address, for example `mailto:sales@example.com?subject=Hello`: one or more plain addresses separated by commas, and an optional `subject` and `body`, with no line breaks.

Phones and computers hand `tel:` and `mailto:` links to the phone or mail app. A domain's bare and not-found redirects take `http(s)` only.

The New link sheet also has **Campaign tags** (`T`): fill in source, medium and campaign and it adds `utm_source`, `utm_medium` and `utm_campaign` to the destination.

## Rules

Open a rule in the New link sheet with its key (outside text boxes), or in the link's detail panel.

### Schedule (`S`)

- **Starts**: before this time the link answers like a missing link.
- **Ends**: from this time on the link answers like a missing link.

A missing link sends visitors to the domain's not-found redirect, or shows a "Not found" page when the domain has none. The end must be after the start (`bad_window`). Over the API, times are Unix seconds.

### Password (`P`)

Visitors get a small password form instead of a redirect; the right password sends them on. A password is 8 to 128 characters, and linkwarren never shows it again or returns it from the API. What visitors see, the rate limits and the costs are in [deploy.md](deploy.md#password-protected-links). In short:

- A protected link always uses a `302` redirect (`password_301` otherwise), and is only served over HTTPS.
- There is no unlock cookie: every visit asks again.
- 5 tries per link per network every 15 minutes, and 20 wrong passwords per network across all links. Use long passwords for anything sensitive.

### Routing (`R`)

Send some visitors to another destination by country or device. A link takes up to 10 rules, tried top to bottom; the first match wins, and everyone else goes to the main destination.

- **Countries**: two-letter codes such as `US` or `DE`. A visitor whose country is unknown, or who comes through Tor, never matches a country rule.
- **Devices**: a form factor (`mobile`, `tablet`, `desktop`), a phone OS (`ios`, `android`) or a computer OS (`windows`, `macos`, `linux`, `chromeos`). A rule matches a visitor who has any one of its values.
- A rule with both countries and devices needs both to match.

Every visitor has a form factor, and an OS when the browser names one: an iPhone is `mobile` and `ios`, a Chromebook is `desktop` and `chromeos`. An iPad in desktop mode sends a Mac user agent, so it counts as `macos` and `desktop`; no server can tell it apart from a Mac.

Use `302` for links with routes: a browser that once got a `301` keeps going to the first destination it saw.

### Redirect type and query pass-through

- **Redirect**: `302` (temporary) by default, so a printed QR code can change destination later. `301` (permanent) is opt-in per link; browsers cache it. The default for new links is set in Settings.
- **Pass query string through**: on by default (also set in Settings). Extra parameters on the short link (`go.example.com/spring?ref=mail`) reach `http(s)` destinations. They are never added to `tel:` or `mailto:` destinations.

### QR code (`Q`)

Every link has a QR code (SVG or PNG) in its detail panel. It encodes the short link with `?lw=qr` added, so analytics can count scans apart from typed visits; the marker is removed before the redirect. The QR code always encodes the short link, never the destination, so changing the destination never needs a new print. QR codes for Wi-Fi, text and more are on the QR codes screen (see [qr-codes.md](qr-codes.md)).

## Who can change a link

Editing or deleting a link needs a domain you can use, and one of these: you are an owner, you own the link's domain, you created the link and your role has **Create links**, or your role has **Edit anyone's links**. Roles are explained in [people-and-roles.md](people-and-roles.md).

Two people editing the same link at once: the second save is refused (`409 conflict`) and nothing is written. Reload and try again.

## Moving links and forwarding

Move one or more links to another domain from the bulk bar (`M`). The target must be an active domain you can use. You choose what happens to each old address; there is no default:

- **Forward**: the link moves, and its old address becomes a forwarder: a `302` to the new short link, one hop, with the query passed through. Printed QR codes keep working. A scan of the old address is counted once, on the moved link.
- **Copy**: an independent copy is made on the new domain, and the original stays as it is.

Forwarders are never edited, only deleted. Deleting a moved link also deletes its forwarders and locks their old slugs, so an old QR code ends on the not-found page and never lands on someone else's link. Moving a link back to a domain where its own forwarder sits takes that address back.

A move is refused for a link whose slug is taken, locked or reserved on the target, or whose destination is on the target host (`loop`). Clicks recorded before a move stay under the old domain when you filter analytics by domain.

## Bulk edit

Select links on the Links page with `X` (or a click or long-press), extend the selection with `Shift+J` and `Shift+K`, or select every loaded link with `Ctrl+A`. The bulk bar then offers:

| Key | Action |
| --- | --- |
| `Shift+D` | Delete |
| `S` | Schedule (start, end, or End now, which switches the links off) |
| `M` | Move or copy to another domain |
| `R` | Redirect type and query pass-through |
| `P` | Set or remove a password |
| `C` | Copy the short links |
| `Shift+E` | Export the selected links as CSV |

Rules:

- Bulk edit needs **Change many links at once** in your role, plus the right to change each link (above). A copy also needs **Create links**.
- At most 50 links per request. The dashboard splits larger selections for you.
- Each link is decided on its own: one refused link does not stop the others, and the result says why it was refused.
- A password is hashed one link per request, so setting a password on many links takes several requests (the dashboard sends them).
- Bulk edits share a budget of 500 KV deletes per UTC day for the whole instance (one per changed link, two for a forward move). A request that does not fit is refused whole with `kv_budget`.

The same actions are available over the API (`POST /api/v1/links/bulk`, see [api.md](api.md#post-linksbulk)) and to agents (`bulk_links`, see [mcp.md](mcp.md)).

## Slug locks

Deleting a link locks its slug on that domain, in any case. Nobody can create a link there, or move one onto it, until the lock is released. This stops a printed QR code for a deleted link from ever leading to an unrelated link someone makes later. Visitors to a locked slug get the domain's not-found redirect.

To reuse a locked slug, type it in the New link sheet: it shows as locked, and people whose role has **Edit anyone's links** (owners always) get a **Release lock** button. Releasing is recorded in the audit log.

An import turns disabled links into slug locks, and links that had a password into locked links you create again with their new password (see [import.md](import.md)).
