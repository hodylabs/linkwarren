---
title: Agents and API keys
description: Connect AI agents over MCP with OAuth, and use personal API keys for scripts.
slug: docs/agents
---

# Agents and API

linkwarren has two ways in for software: **agents** (Claude, ChatGPT, Claude Code, Codex, Gemini and other MCP clients) connect to the built-in MCP server with OAuth, and **scripts** use a personal API key on `/api/v1`. Both act as you: they can never see or change more than you can in the dashboard, and every change they make is in the audit log as "you via <agent or key>".

People with the Settings permission (owners always) turn agents on and off with a switch on the API & agents screen (`G I`); only they see it enabled. The operator can lock agents off for the whole instance with `MCP_ENABLED="0"` (see [deploy.md](deploy.md#mcp_enabled)), and then the switch is disabled. The screen shows the MCP address only while agents are on; API keys work either way. Turning agents off disconnects nobody and revokes nothing: agents just get a `404` until it is turned back on.

## Connect an agent

The MCP address is always `https://<dashboard host>/mcp`, at the root of the host. Copy it from the API & agents screen (`C`). With the dashboard on its own host that is for example `https://dash.example.com/mcp`; with the dashboard at a path on the main short domain (`https://example.com/dashboard`) it is still the root of the domain, `https://example.com/mcp`, never `https://example.com/dashboard/mcp`; see [Dashboard at a path](#dashboard-at-a-path).

- **Claude (claude.ai and Claude Desktop):** Settings, Connectors, Add custom connector, paste the address.
- **ChatGPT:** Plugins, the plus button, Add custom MCP server, paste the address and choose OAuth. Whether you can add one depends on your ChatGPT plan and workspace role.
- **Claude Code:** `claude mcp add --transport http linkwarren <MCP address>`, then run `/mcp` in Claude Code to sign in.
- **Codex:** `codex mcp add linkwarren --url <MCP address>`, then `codex mcp login linkwarren` to sign in.
- **Gemini CLI:** `gemini mcp add --transport http linkwarren <MCP address>`, then sign in when Gemini CLI prompts you.
- **Gemini Enterprise:** an admin adds a custom MCP server data store with OAuth and the StreamableHTTP URL `<MCP address>`.
- **Google Antigravity:** add a custom MCP server with the address in Antigravity's MCP settings, then sign in when prompted.
- **Gemini app:** the callback address of its custom connectors is not documented, so it may be refused. If it is, tell the instance owner: the refused address is logged and can be added to the allowlist.

Any other MCP client that supports remote servers with OAuth works the same way, as long as it signs in through one of the callbacks the instance allows (claude.ai, claude.com, ChatGPT, Gemini Enterprise, Antigravity, or a local `http://localhost:<port>` or `http://127.0.0.1:<port>` address ending `/callback`, `/callback/<id>` or `/oauth/callback`; the full list is in [deploy.md](deploy.md#allowed-redirect-uris)). A client with any other callback is refused when it registers.

Connecting opens linkwarren in your browser. Sign in if you are not already, then the approval screen shows the agent's name and, more prominently, the host it sends you back to (for example `claude.ai`). Anyone can give a client any name, so check the host. Then choose the access and approve.

## Access

- **Read only is the default.** The agent can search and read links, list domains, check slugs and read 7-day click counts.
- **Read and write** lets it create and change links.
- **Delete links** is a separate choice on top of write. Even then the agent must ask before deleting: the `delete_link` tool refuses unless it is called with `confirm: true`.

A bulk change asks for more care than a single one. `bulk_links` refuses unless it is called with `confirm: true` when it would delete links, move or copy them to another domain, take links offline (`endNow`, an expiry in the past, or a start in the future) or remove a password. A move also needs `oldAddress`, which the person chooses: `forward` keeps each old address working as a forwarder to the new short link, `copy` makes an independent copy on the new domain and leaves the original. Without it the tool refuses and tells the agent to ask.

Agents have no domain restriction beyond your own: they reach every domain you can use.

### Changing access

On the API & agents screen, select the connection (`J`/`K`, `Enter`) and use the switches, then Change access. The change applies on the agent's next call; it does not need to reconnect. You can raise or lower your own connections. An owner can lower or disconnect anyone's connection, and a person whose role can invite and manage people can do the same for people whose role has no permission theirs lacks (never an owner's: `403 role_above_you`). Only the person can raise a connection again (`403 owner_cannot_raise`). If the person changed it in the meantime, the change is refused (`409 changed`) and nothing is written: reload and try again.

### Disconnecting

Select the connection and press `Shift+D` (or Disconnect), then confirm. The agent's next call fails, its refresh token stops working, and it has to connect again. The same happens to every agent of a person who is disabled. Disconnecting someone does not touch their other agents or keys.

### When a role loses AI agents

Agents follow the person's current role. When an owner turns off **Connect AI agents** for a role, every agent of its people is refused from its next call: each tool answers "Your role no longer allows AI agents. Ask an owner." (no tool call is logged), and the approval page answers "Your role does not allow connecting AI agents." (Deny still returns to the agent as usual.) Tokens keep refreshing, but every tool call is refused. Nothing is disconnected or revoked: turning the permission back on restores the same connections. Listing, lowering and disconnecting your own connections still work without it; raising one to write or delete needs it (`403 forbidden`). Turning off **Personal API keys** does not affect agents, and the other way round.

## Tools

| Tool | Needs | What it does |
| --- | --- | --- |
| `server_info` | read | Your access level, role (its name and permission keys), the MCP address and the limits |
| `search_links` | read | Search the links you can see, newest first |
| `get_link` | read | One link by id or by short URL |
| `list_domains` | read | The domains you can create links on (host, type and status) |
| `check_slug` | read | Whether a slug is available, taken, locked, reserved or invalid |
| `link_stats` | read | Daily clicks for one link over the last 7 days |
| `create_link` | write | Create a short link |
| `update_link` | write | Change a link |
| `delete_link` | delete | Delete a link, remove its forwarders and lock their slugs (needs `confirm: true`) |
| `bulk_links` | write (delete also needs delete) | Change up to 50 links in one call: `delete`, `schedule`, `move`, `redirect` or `password` |

`bulk_links` takes `action`, `ids` (1 to 50), `confirm`, and the fields of the action (`startsAt`, `expiresAt`, `endNow` (only `true`; leave it out otherwise), `redirectCode`, `passQuery`, `password`, or `domain` and `oldAddress` for a move). It answers `{ results, pending }`: one entry per link, `{ id, ok: true, link: { id, shortUrl, url, kind, hasPassword, forwardTo } }` or `{ id, ok: false, error }`, and `pending`, the ids still waiting for a password (see below). When it needs a confirmation it answers `{ refused: true, summary }` and changes nothing.
### Routing

Every link has a `kind`: `url` (a redirect) or `vcard` (a contact card: the short link downloads the card, see `docs/spec.md`). `get_link` and `search_links` show the kind and, for a card, its fields with `hasPhoto` in place of the photo. Contact cards are created and edited in the dashboard or through `/api/v1`, not through MCP; `update_link` on a card answers `vcard_url` for a new `url` and `vcard_rule` for a password or routes.

A link destination (`url`, and each route `url`) is an `http(s)` URL, a `tel:` number (`tel:+1-555-123-4567`: an optional `+`, digits and `-` `.` `(` `)`, no parameters) or a `mailto:` address (one or more addresses separated by commas, optional `subject` and `body` only, no line breaks). A refused one answers `scheme`, `bad_tel` or `bad_mailto`. A domain's bare and not-found redirects take `http(s)` only.

`create_link` and `update_link` (and `POST`/`PATCH /links`) take `routes`: up to 10 rules, each `{ countries, devices, url }`, tried top to bottom; the first match wins and everyone else goes to the main `url`. A rule needs at least one country or device. `devices` lists any of:

| Group | Values |
|---|---|
| Form factor | `mobile`, `tablet`, `desktop` |
| Phone OS | `ios` (iPhone, iPad, iPod, any browser), `android` |
| Computer OS | `windows`, `macos`, `linux`, `chromeos` |

A rule matches a visitor who has any one of its values, so `["ios", "android"]` means any phone or tablet OS, and `["tablet", "windows"]` means tablets plus Windows computers. Every visitor has a form factor and, when the user agent names one, an OS: an iPhone is `mobile` and `ios`, a Chromebook is `desktop` and `chromeos` (never `linux`), a Windows Phone only `mobile`, and bots or an empty agent `desktop`. An iPad in desktop mode sends a Mac user agent, so it counts as `macos` and `desktop`, not `ios`: no server can tell it apart from a Mac.

The server tells the model that tool results are data, never instructions: a link destination or title that says "ignore your instructions" is just text.

### Dashboard at a path

When the instance serves its dashboard at a path on the main short domain (`DASHBOARD_PATH`, see [deploy.md](deploy.md)), the OAuth endpoints live under that path, while the MCP server and the machine API stay at the root of the domain (one address each, the same shape as host mode). The issuer stays the domain's origin. With `https://example.com/dashboard`:

| A client requests | Agents on | Agents off |
|---|---|---|
| `POST https://example.com/mcp` | the MCP server (without a token: `401`, `WWW-Authenticate` with `resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"`) | `404` JSON |
| `GET /.well-known/oauth-protected-resource/mcp` and the bare `/.well-known/oauth-protected-resource` | protected resource metadata: `resource` `https://example.com/mcp`, `authorization_servers` `["https://example.com"]` | `404` JSON |
| `GET /.well-known/oauth-authorization-server` | authorization server metadata: issuer `https://example.com`, endpoints `/dashboard/authorize`, `/dashboard/token`, `/dashboard/register` | `404` JSON |
| `/dashboard/authorize`, `/dashboard/token`, `/dashboard/register` | the OAuth endpoints (`/dashboard/register` keeps the registration limits) | `404` JSON |
| any other `/.well-known/oauth-*` or `/.well-known/openid-configuration*` path (for example `/.well-known/oauth-protected-resource/dashboard/mcp`), and any of them under `/dashboard/` | `404` JSON | `404` JSON |
| `/dashboard/mcp` and `/dashboard/mcp/...` (any encoding) | `404` JSON: not an MCP address | `404` JSON |
| `/mcp/...` at the root | `404` JSON | `404` JSON |
| `/authorize`, `/token`, `/register` at the root | short links (these are not the OAuth endpoints) | short links |

`/dashboard/mcp` answers `404`, not a redirect: an agent holding a token must be re-pointed at the one MCP address, never silently followed to it. On every other domain `/mcp` is an ordinary short-link path. On the main domain `mcp` and `api` are reserved slugs (as is the dashboard's segment): creating, moving or copying a link there with one of them is refused, and import reports `reserved_path`.

A client that ignores the metadata and calls `/authorize`, `/token` or `/register` at the root of the domain reaches short links and fails; current clients read the metadata.

**After a switch** to another dashboard host (for example from `dash.example.com` to `example.com/dashboard`) every agent must be connected again at the new MCP address: tokens are bound to the old address and are refused (`401`), and old refresh tokens no longer work. Remove the old connection in the agent and add the new address. Tokens issued for `<dashboard>/mcp` by an earlier build that served MCP under the path are refused the same way. When only the mode changes and the host stays the same, the MCP address (`https://<host>/mcp`) stays the same and connections keep working. API keys keep working; scripts use `https://<dashboard host>/api/v1` in both modes.

## API keys

For scripts, create a key on the API & agents screen: New API key (`N`), give it a name (lowercase letters, digits and hyphens), choose the access (read only by default, delete only with write), optionally limit it to some domains, and pick the expiry (30, 90 or 365 days). The key (`lw_` and 43 more characters) is shown **once**: copy it then. linkwarren keeps only a hash. Revoke a key from the same screen (`Shift+D`); a revoked or expired key answers `401 {"error":"invalid_key"}`.

Keys follow the person's current role. Creating a key needs **Personal API keys** in the role (`403 forbidden` otherwise). When an owner turns it off, every key of the role's people answers `403 {"error":"keys_not_allowed"}` from the next request, without counting on any limit or updating its last use; nothing is revoked, so turning it back on restores the same keys (until they expire). Listing and revoking your own keys still works without it. A key never does more than the role allows: with write access it still gets `403 forbidden` for what the role cannot do.

A key works only on `/api/v1` at the root of the dashboard host (`https://dash.example.com/api/v1`, or `https://example.com/api/v1` with the dashboard at `https://example.com/dashboard`; never under the dashboard path, where `/dashboard/api/v1` answers `404`), sent as a Bearer token (`Authorization: Bearer <key>`, the word `Bearer` in any case). It never works on the dashboard's own API (`<dashboard URL>/api`) or on `/mcp`. Keep it in an environment variable, not on the command line or in a file you commit:

```sh
export LW_KEY='<your key>'
export LW=https://<dashboard host>/api/v1

# The domains you can use (ids for the calls below)
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/domains"

# Search links (q matches slug or destination; pass next back as cursor for more)
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links?q=spring&domain=<domain id>"

# Is a slug free?
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/check?domain=<domain id>&slug=spring"

# One link by id, or by slug
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/<link id>"
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/links/by-slug?domain=<domain id>&slug=spring"

# Create (needs a write key)
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"domainId":"<domain id>","slug":"spring","url":"https://example.com/spring-sale"}' "$LW/links"

# Send iPhone and Android visitors to app store pages (write)
curl -s -X PATCH -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"routes":[{"devices":["ios"],"url":"https://apps.example.com/ios"},{"devices":["android"],"url":"https://apps.example.com/android"}]}' "$LW/links/<link id>"

# A contact card: the short link downloads it (write). Leave out url; every card field is optional but a name or organization.
# phones[].type is cell, work, home or other; photo is base64 JPEG or PNG, at most 64 KB. PATCH with "vcard" replaces the whole card.
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"domainId":"<domain id>","slug":"ada","kind":"vcard","vcard":{"firstName":"Ada","lastName":"Lovelace","org":"Example Ltd","phones":[{"type":"work","number":"+1 555 0100"}],"emails":["ada@example.com"],"websites":["https://example.com"]}}' "$LW/links"

# Change the destination (write)
curl -s -X PATCH -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/summer-sale"}' "$LW/links/<link id>"

# Delete (needs delete)
curl -s -X DELETE -H "Authorization: Bearer $LW_KEY" "$LW/links/<link id>"

# Daily clicks for up to 50 links, last 7 days
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/analytics/links?ids=<link id>,<link id>"
```

Reading one link (`GET /links/<id>` or `/links/by-slug`) returns the card with its `photo`. Lists and searches (`GET /links`, which match a card by its name or organization) and bulk results return each card with `hasPhoto` (true or false) instead of the photo, to keep pages small. A card that fails its checks answers `400 {"error":"bad_vcard","field":"<field>"}` (`name`, `photo`, `phones.0`, `emails.1`, `websites.2`, `address.city`, `note`, ...). A contact card refuses `url` (`vcard_url`), a password or routes (`vcard_rule`) and a type change (`kind_change`); a plain link refuses `vcard` (`not_vcard`).

### Bulk changes

`POST /api/v1/links/bulk` changes up to 50 distinct links in one request (a list of up to 100 ids is accepted, duplicates are dropped first). It needs a write key; `delete` needs a key that may delete. The person's role must allow bulk edits (`403 forbidden` otherwise), a `copy` move also needs the right to create links, and each link follows the single-edit rights of their role. The body has an `action` and the `ids`, plus the fields of that action:

| `action` | Other fields |
| --- | --- |
| `delete` | none |
| `schedule` | `startsAt` and/or `expiresAt` (a time or `null`), or `endNow: true` (end now; not together with `expiresAt`) |
| `redirect` | `redirectCode` (301 or 302) and/or `passQuery` |
| `password` | `password`: a string to set, `null` to remove |
| `move` | `domainId` (the target, must be active) and `oldAddress`: `"forward"` or `"copy"` (required, no default) |

The answer is `{ "results": [...], "pending": [...] }`, results in the order of the ids. Each result is `{ "id", "ok": true, "link" }` (the changed link, or for a copy the new one; none for a delete) or `{ "id", "ok": false, "error" }` with a per-link code (below). Other links in the request are not affected by a refused one.

```sh
# Take links offline now (the website asks first; scripts are on their own)
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"schedule","ids":["<link id>","<link id>"],"endNow":true}' "$LW/links/bulk"

# Move to another domain, old addresses forward to the new ones (or "copy")
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"move","ids":["<link id>"],"domainId":"<target domain id>","oldAddress":"forward"}' "$LW/links/bulk"
```

Setting a password hashes one link per request, so the rest come back in `pending`. Send the same request again with just those ids until `pending` is empty:

```sh
curl -s -X POST -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"action":"password","ids":["<id>","<id>","<id>"],"password":"a long passphrase"}' "$LW/links/bulk"
# {"results":[{"id":"<id>","ok":true,...}],"pending":["<id>","<id>"]}  -> repeat with the pending ids
```

Every link response now carries `forwardTo`: `null` for a normal link, the id of the link a forwarder leads to.

Bodies must be JSON (`Content-Type: application/json`); `/api/v1` needs no `Origin` header. Everything else under `/api/v1` (people, audit, keys, domain settings, imports) answers `404`: those stay in the dashboard. A key limited to some domains sees only their links and gets `403` on any other domain; if its stored domain list ever cannot be read, the key works on no domain at all. `GET /api/v1/domains` returns the domains you can use with the same fields as the dashboard, but without link counts or Cloudflare details.

## Limits and errors

Agents and keys share per-minute limits per person, per connection and per key, a daily cap per person and a daily cap for the whole instance (UTC days). The numbers are in [deploy.md](deploy.md#limits); `server_info` also reports them. Over a limit an agent's tool answers "Rate limited, try again in a minute." or "Daily limit reached, try again tomorrow (UTC).", and the API answers `429`. A bulk request counts once per minute but one unit per link on the daily caps, and bulk edits share a KV budget (`kv_budget`); both are in the same section.

| Status | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | No `Authorization` header |
| 401 | `invalid_key` | Wrong, revoked or expired key, or the person was disabled |
| 403 | `keys_not_allowed` | The person's role does not allow personal API keys (the key is kept) |
| 403 | `read_only` | The key cannot create or change links |
| 403 | `delete_not_allowed` | The key cannot delete links |
| 403 | `forbidden` | Not a domain or link you (or this key) may use, or your role does not allow it (creating links, editing someone else's link, bulk changes) |
| 404 | `not_found` | No such link or domain, or a path that is not part of `/api/v1` |
| 400 | `too_many` | More than 50 distinct ids in a bulk request |
| 400 | `target_not_active` | A move to a domain that is not active yet |
| 409 | `conflict` | The link changed since it was read; read it again and retry. For a bulk request: the whole request was rolled back (a double submit) |
| 429 | `kv_budget` | The instance's daily budget for bulk edits is used up; try after 00:00 UTC |
| 415 | `unsupported_media_type` | The body is not JSON |
| 429 | `rate_limited` | A limit was reached; see above |
| 503 | `unavailable` | The rate limiter or database could not be reached; nothing was done |

Per-link codes in a bulk result: `not_found`, `forbidden`, `conflict` (the link changed in between, nothing written for it), `bad_window` (the dates would end before they start), `password_301` (a protected link cannot use a permanent redirect), `forwarder` (an old address is only deleted, never changed or moved), `same_domain`, `taken` (the target has that slug, as a link or a forwarder), `locked` (the target slug is locked), `reserved`, `duplicate_slug` (two selected links would get the same slug), and the slug shape codes of a single create (for example `slug_too_long`), and `loop` (a move or copy would make a link point at its own domain: its destination or a route is on the target host). A move to a domain id that does not exist or you cannot use answers `403 forbidden`.

Validation errors (for example `taken`, `locked`, `invalid_body`, `q_too_long`) are the same as in the dashboard.

## What is recorded

Every tool call is logged (time, person, agent, tool, outcome; never the arguments or results) for 90 days, except calls refused because the person's role no longer allows AI agents ([see above](#when-a-role-loses-ai-agents)), and every change is in the audit log with "via". The connection list shows each agent's last use and its calls in the last 7 days. Details are in [privacy.md](privacy.md#agents-and-api-keys).

## Differences from the MCP standard

The server follows the MCP authorization spec with three deliberate differences, listed in [deploy.md](deploy.md#deviations-from-the-mcp-standard): a replayed refresh token is refused without ending the connection, `/mcp` takes OAuth tokens only (no API keys), and there is no IP allowlist because CLI clients call from people's own machines.
