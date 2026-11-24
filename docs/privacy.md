---
title: Privacy
description: What linkwarren records per click, what it never stores, and what leaves your Cloudflare account.
slug: docs/privacy
---

# Privacy

This page describes what a linkwarren instance records when someone opens a short link. It applies to every instance that turns on click analytics (see [deploy.md](deploy.md), "Analytics"). Without analytics configured, nothing is recorded per click.

## What is recorded per click

Each visit to a live link (a redirect, or a contact card download) records one data point with:

- the domain and the link (its id and slug)
- the country code, as Cloudflare reports it
- the device class: mobile, tablet, desktop or other
- the referrer host only (for example `example.com`), never the full referring address
- whether the visit came from a QR code or was typed or clicked
- whether the visitor looks like a person, a bot, or a chat-app link preview
- a visitor code that changes every UTC day
- the operating system family (iOS, Android, Windows, macOS, Linux, ChromeOS or Other) and the browser family (Chrome, Safari, Firefox, Edge, Opera, Samsung Internet or Other), worked out from the user agent at the moment of the click; the user agent itself is not kept
- the visitor's preferred language: the first tag of the browser's Accept-Language header, lowercased and cut to two parts (for example `en-us`)
- the city as Cloudflare reports it (or the region when Cloudflare gives no city), with the country code, for example `Toronto, CA`; nothing finer than the city, never coordinates or a postal code
- for a scan of a labelled QR print (`?lw=qr.<code>`), the print's code (a short code the instance made, never anything about the visitor)
- the UTM values (`utm_source`, `utm_medium`, `utm_campaign`) of the short link's own address, as the visitor's link carried them: lowercased, trimmed, control characters removed and cut to 64 characters. Whoever builds the link chooses them; a UTM value can say anything, so do not put personal data in the UTM values of links you share. Other query values are never recorded.

Points recorded before these were added have them empty. Since 0.8.0 a daily detail rollup also keeps, in D1, the operating system, browser, language, city, print and UTM counts per link and day (the 20 biggest values of each, the rest added up as `(other)`), so these counts are kept until the instance is deleted, like the daily totals. On their own and together they are coarse buckets that many people share, not something that identifies a person, but a small instance with few visitors from one city should treat its reports as personal data and share them with care.

**Recent clicks** on the Analytics screen lists the last 50 clicks by people in the last 24 hours with their time, link, country and city, device, operating system, browser, language, source, print, referrer host and UTM values, read from the same Analytics Engine points. It shows no IP address, visitor code or user agent, and only to people who may see analytics for that link's domain. Nothing extra is stored for it.

A forwarder (the old address of a moved link, see [deploy.md](deploy.md#behaviour-to-know)) records no click. The visit is recorded once, by the link it forwards to, under that link's current domain. Points recorded before a move keep the domain of the moment.

The visitor code is a keyed hash of the day, the IP address and the user agent, cut to 16 hex characters. The key is a secret salt of the instance: without it the code cannot be turned back into an IP address. Because the day is part of the hash, the same person gets a different code the next day, so visits cannot be linked across days. Unique visitors are therefore counted per link per UTC day: a person who opens two links, or comes back tomorrow, counts again. A link moved to another domain during a day counts a visitor once per domain for that day in the daily totals. The most recent days (the ones not yet copied into the daily totals, normally yesterday and today) are counted live per UTC day across the links in view, so there a person who opens two links counts once. The 24-hour view counts unique visitors per hour instead, so in the 24-hour view a person who returns in a later hour counts again.

Bots and chat-app link previews are recorded the same way as people, as raw points kept for 90 days, but marked as bots or previews. They are left out of the click and visitor counts for people, so previews in chat apps do not inflate them.

## What linkwarren never stores

linkwarren's analytics, its database and its own log lines never contain:

- IP addresses
- full user agents
- full referrer URLs
- cookies
- any identifier that lasts beyond a day

The dashboard (in app sign-in mode) sets one cookie, the session: `__Host-lw_session` on the dashboard host, or `__Secure-lw_session` limited to the dashboard path (for example `/dashboard`) when the dashboard lives at a path on the main short domain. It holds only a random value; browsers never send it with a short-link visit, in either mode.

Short links set no cookies and run no scripts: a visitor gets a plain redirect, or for a password-protected link a small password page (still no cookies and no scripts). A click on a protected link is recorded only after a right password.

One exception to "no IP addresses" in the database: a visitor who submits a link password has their IP range (the /24 for IPv4, the /48 for IPv6, never the full address) stored as a rate-limit counter, only to limit password guessing. It is kept for the limiter window (15 minutes) plus the cleanup delay: an hourly cleanup deletes counters whose window started over an hour ago, so a range is normally gone within about two hours of the last attempt.

## Agents and API keys

When people connect agents (MCP) or create API keys (see [agents.md](agents.md)), linkwarren also stores, in the instance's D1 database:

- **Tool calls:** one row per MCP tool call with the time, the person, the agent's name (as shown on the approval screen), the connection id, the tool name and the outcome (`ok`, `refused`, `error` or `rate_limited`). Never the arguments, the results or any token. Kept 90 days, then the hourly cleanup deletes it.
- **API keys:** the name, the access chosen, the domains it is limited to, created, expiry, last use and revoked times, a SHA-256 hash of the key and its first 10 characters for display. The key itself is shown once and never stored.
- **Agent connections:** the agent's name, the host it redirects back to (for example `claude.ai`), the access chosen, when it was connected or disconnected. Last use is read from the tool calls.
- **Audit log:** a change made by an agent or a key is recorded like any other change, with "via" naming the agent or the key (for example "Mia via Claude"). Kept 3 years like the rest of the audit log.
- **The agents switch:** whether agents may connect is a row in the D1 `settings` table (`mcp.enabled`). Each change, by a person with the Settings permission, is audited as `settings.update`.
- **Bulk changes** write one audit row per link, with "via" like any change. A move records the old and new host, the slug, the destination and the id of the forwarder it left (`link.move`); a copy records the new link with the id it was copied from (`link.create`). Deleting a link also records one `link.delete` row per forwarder it removes (`forwarderOf` names the link). A password change records only that protection was set or cleared, never the password or its hash.

A bulk CSV export from the Links page is generated in your browser and never sent to the server. It holds destinations, rules and creators as that person may see them, and `has_password` (yes or no), never a password.

The OAuth state (registered clients, grants and hashed tokens) lives in the `OAUTH_KV` namespace. A grant carries only the person's id, the connection id and the agent's name, never link data. Grants end with Disconnect or when their refresh token expires (30 days unused); client registrations are kept 30 days. A role that loses AI agents keeps its people's grants and connections (refused, not deleted); an agent that keeps refreshing keeps its grant until it is disconnected.

When an agent tries to register with a callback address the instance does not allow, linkwarren logs one line with that address's origin and path (never its query, the agent's name or any secret), so the owner can decide to allow it.

`POST /register` is limited per IP range (the /24 or /48, never the full address) and `/authorize` per person; those counters live in the same rate-limit table as the password limits and are cleaned up the same way.

## People and email

The people who use the dashboard are stored in the instance's D1 database:

- **People:** email address, name (optional), role (Owner, Member or a custom role, shown by its name), status (invited, active or disabled) and when they were added.
- **Roles:** each custom role's name, its permission toggles, when it was created and changed, and who changed it last. Roles hold no personal data beyond that last editor.
- **Sign-in** (when the instance runs its own sign-in, `AUTH_MODE=app`): sessions with the sign-in method, the device (a short label from the browser) and the IP range (the /24 or /48, never the full address), passkeys (the public key and a name, never a private key), and email sign-in tokens, of which only a SHA-256 hash is stored. Sessions and tokens end when they expire or when the person signs out, is disabled or is removed.
- **Sign-in limiter:** a sign-in email request counts against the address (hashed) and against the requester's IP range (the /24 or /48, never the full address). These counters live in the same rate-limit table as the password limits and are cleaned up the same way, normally within about two hours.
- **Removing a person** deletes their row, sessions, passkeys, keys and agent connections. Their email address stays in the audit log, in the details of entries such as an invite, a role change, a revoked invite and the removal itself, for the 3-year audit retention.
- **The full export** (Settings, Backups and export, see [backup.md](backup.md)) contains every person's email address, name and role, the whole audit log, agent names and API key names, never secrets, password hashes or sessions. Treat the file like the database.

- **Weekly email** (opt-in, off by default): whether the person turned it on, their time zone, the last week sent and a random per-person secret that signs the unsubscribe link (a new one each time it is turned on). Removing the person deletes it. The secret is never in the export.

- **Link alerts** (opt-in, off by default): whether the person turned them on and which kinds, the last UTC day handled, a random per-person secret that signs the unsubscribe link, and which links they were already told about (link id, kind and day). Removing the person or the link deletes those rows.

## Share pages

A share page shows one link's or one domain's click totals to anyone who has its URL, without signing in (see [analytics.md](analytics.md#share-page)).

- **What it shows**: totals for the last 30 days, a daily table and the top countries, referrers and devices. Never a list of links, recent clicks, IP addresses, visitor codes or anything else about one visitor. Referrers are visitor-supplied text, shown escaped.
- **What is stored**: the SHA-256 of the page's token (never the token or the URL), the link or domain it covers, who made it, when, and when it was revoked. Making and revoking it are audit-logged without the token.
- **Reach**: it is the person who makes it who decides to share; the page stops when revoked, when the link or domain is deleted, when the link moves to another domain, or when its maker is disabled or removed. Search engines are told not to index it, and it sends no referrer.
- **Rate limit**: views count against the viewer's IP range (the /24 or /48, never the full address) for one minute, in the same table as the sign-in limits, cleaned up the same way.

The instance name is shown to signed-out visitors on the sign-in page and on the `/join` page an invite opens, so anyone who opens the dashboard address can see it.

## How long data is kept

- Raw click points live 90 days in Cloudflare Workers Analytics Engine (its documented retention is three months), then the platform removes them. The busiest-times view, recent clicks and filtered views read only these points, so they cover the last 90 days at most.
- Daily totals and the daily detail rollup (operating system, browser, language, city, print and UTM counts per link and day) stay in the instance's D1 database until the instance is deleted.
- QR print labels (the code, the label, who made it and when) are kept until the label or its link is deleted.
- The audit log of dashboard changes (including changes by agents and keys) is kept for 3 years.
- MCP tool calls are kept 90 days.

Everything linkwarren stores stays in the Cloudflare account that runs the instance. It sends two things elsewhere: the daily update check (see "Update check" below, off with one switch) and email: sign-in links, invites, test mails, the weekly summary and link alerts go through Resend, which receives the recipient's address and the text of the mail (for an invite: the instance name, the inviter's name or email and the dashboard address; for a sign-in link: the link itself; for the weekly summary: click totals and the addresses of the person's top 5 links; for an alert: the addresses and names of the links it lists and their click counts). See "People and email" below.

## Update check

Once a day (the 00:15 UTC run of the scheduled job) the instance asks GitHub for the latest linkwarren release: one `GET https://api.github.com/repos/hodylabs/linkwarren/releases/latest`. linkwarren sets only a fixed `User-Agent: linkwarren-update-check` and `Accept: application/vnd.github+json`, and sends no instance name, dashboard address, email or token. Cloudflare itself adds a `CF-Worker` header to every request a Worker sends; on a custom domain its value is the name of the zone that runs the instance (for example `example.com`), so GitHub learns that zone. linkwarren cannot remove that header: turn the check off if that matters. GitHub also sees the IP address Cloudflare sends the request from, as with any web request. The answer's version, release-notes link and date are stored in the `settings` table (key `updates.latest`); nothing installs by itself.

Owners and people with the Settings permission then see "vX.Y.Z available" next to the dashboard version when a newer release exists. To turn the check off, switch off **Check for updates** in Settings, This instance: the daily request stops and the notice is hidden.

## Platform logs

Cloudflare itself can log requests, separately from linkwarren. If Workers Logs (`observability`) is on in the instance config, Cloudflare keeps an invocation log for each request the Worker handles, with the request, the response and related metadata, including headers, for the Workers Logs retention period (3 days on the Workers Free plan, 7 days on Workers Paid). Those headers can include the visitor's user agent and IP address. The example config turns Workers Logs on, with `head_sampling_rate` (0 to 1, the share of requests logged) set to 1. To keep no such logs, set `"observability": { "enabled": false }`; to keep only linkwarren's own log lines and no per-request invocation logs, add `"logs": { "invocation_logs": false }`; or lower `head_sampling_rate`. Check what your account actually keeps in the dashboard (the Worker's Observability tab).

A search that matches several hundred links is read in parts; for the most recent days the visitor count is then added up per part, so a person who clicked links in two parts counts twice.
