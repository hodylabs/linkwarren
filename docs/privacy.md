# Privacy

This page describes what a linkwarren instance records when someone opens a short link. It applies to every instance that turns on click analytics (see [deploy.md](deploy.md), "Analytics"). Without analytics configured, nothing is recorded per click.

## What is recorded per click

Each redirect to a live link records one data point with:

- the domain and the link (its id and slug)
- the country code, as Cloudflare reports it
- the device class: mobile, tablet, desktop or other
- the referrer host only (for example `example.com`), never the full referring address
- whether the visit came from a QR code or was typed or clicked
- whether the visitor looks like a person, a bot, or a chat-app link preview
- a visitor code that changes every UTC day

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

Short links set no cookies and run no scripts: a visitor gets a plain redirect, or for a password-protected link a small password page (still no cookies and no scripts). A click on a protected link is recorded only after a right password.

One exception to "no IP addresses" in the database: a visitor who submits a link password has their IP range (the /24 for IPv4, the /48 for IPv6, never the full address) stored as a rate-limit counter, only to limit password guessing. It is kept for the limiter window (15 minutes) plus the cleanup delay: an hourly cleanup deletes counters whose window started over an hour ago, so a range is normally gone within about two hours of the last attempt.

## Agents and API keys

When people connect agents (MCP) or create API keys (see [agents.md](agents.md)), linkwarren also stores, in the instance's D1 database:

- **Tool calls:** one row per MCP tool call with the time, the person, the agent's name (as shown on the approval screen), the connection id, the tool name and the outcome (`ok`, `refused`, `error` or `rate_limited`). Never the arguments, the results or any token. Kept 90 days, then the hourly cleanup deletes it.
- **API keys:** the name, the access chosen, the domains it is limited to, created, expiry, last use and revoked times, a SHA-256 hash of the key and its first 10 characters for display. The key itself is shown once and never stored.
- **Agent connections:** the agent's name, the host it redirects back to (for example `claude.ai`), the access chosen, when it was connected or disconnected. Last use is read from the tool calls.
- **Audit log:** a change made by an agent or a key is recorded like any other change, with "via" naming the agent or the key (for example "Mia via Claude"). Kept 3 years like the rest of the audit log.
- **The agents switch:** whether agents may connect is a row in the D1 `settings` table (`mcp.enabled`). Each change by the owner is audited as `settings.update`.
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

The instance name is shown to signed-out visitors on the sign-in page and on the `/join` page an invite opens, so anyone who opens the dashboard address can see it.

## How long data is kept

- Raw click points live 90 days in Cloudflare Workers Analytics Engine, then the platform removes them.
- Daily totals stay in the instance's D1 database until the instance is deleted.
- The audit log of dashboard changes (including changes by agents and keys) is kept for 3 years.
- MCP tool calls are kept 90 days.

Everything linkwarren stores stays in the Cloudflare account that runs the instance. The one thing it sends elsewhere is email: sign-in links, invites and test mails go through Resend, which receives the recipient's address and the text of the mail (for an invite: the instance name, the inviter's name or email and the dashboard address; for a sign-in link: the link itself). See "People and email" below.

## Platform logs

Cloudflare itself can log requests, separately from linkwarren. If Workers Logs (`observability`) is on in the instance config, Cloudflare keeps an invocation log for each request the Worker handles, with the request, the response and related metadata, including headers, for the Workers Logs retention period (3 days on the Workers Free plan, 7 days on Workers Paid). Those headers can include the visitor's user agent and IP address. The example config turns Workers Logs on, with `head_sampling_rate` (0 to 1, the share of requests logged) set to 1. To keep no such logs, set `"observability": { "enabled": false }`; to keep only linkwarren's own log lines and no per-request invocation logs, add `"logs": { "invocation_logs": false }`; or lower `head_sampling_rate`. Check what your account actually keeps in the dashboard (the Worker's Observability tab).

A search that matches several hundred links is read in parts; for the most recent days the visitor count is then added up per part, so a person who clicked links in two parts counts twice.
