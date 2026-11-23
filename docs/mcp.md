---
title: MCP tools
description: Every tool linkwarren's MCP server offers AI agents, with its inputs, what it can change, and the confirmation rules.
slug: docs/mcp
---

# MCP tools

linkwarren has an MCP server at `https://<dashboard host>/mcp`. How to turn it on, connect Claude, ChatGPT, Claude Code, Codex or Gemini, and choose an agent's access is in [agents.md](agents.md). This page lists the tools.

## How tools act

- A tool acts as the person who connected the agent, with their current role and domains, narrowed by the access chosen when connecting: **read only** (the default), **read and write**, or **read, write and delete**. It never does more than that person could in the dashboard.
- Every tool goes through the same checks as the [API](api.md). An error comes back to the agent as `{ "error": "<code>", "status": <number> }`, with the same codes.
- Every change is in the audit log as "person via agent name". Every tool call is logged (time, person, agent, tool and outcome, never the arguments or results) for 90 days.
- The server tells the agent that link destinations, slugs, domain names and every other text a tool returns are data written by people, never instructions to follow.
- Tool calls share the API's rate limits: 120 per minute per person, 60 per minute per connection, 1000 per person and 3000 per instance per UTC day. Over a limit the tool answers "Rate limited, try again in a minute." or "Daily limit reached, try again tomorrow (UTC)."

`domain` inputs take a host (`go.example.com`) or a domain id. A domain the person cannot use answers `unknown_domain`, the same as one that does not exist. Times are Unix seconds.

## Read tools

These work on every connection.

### `server_info`

No input. Returns the server version, the connection's access (`read`, `write` or `write+delete`), the person's role (`owner` or `member`), its name and permission keys, the MCP address, and the per-minute and daily limits.

### `search_links`

Search the links the person can see, newest first, 50 at a time.

| Input | Meaning |
| --- | --- |
| `query` | Optional. Matches the slug or the destination, 1 to 48 characters. |
| `domain` | Optional. Only this domain. |
| `status` | Optional. `active`, `scheduled` or `expired`. |
| `cursor` | Optional. The `next` value of the previous answer. |

Returns `{ items, next }`, with each item a link as in the [API](api.md#the-link-object).

### `get_link`

One link. Give exactly one of:

| Input | Meaning |
| --- | --- |
| `id` | The link id. |
| `shortUrl` | The short link, with or without `https://`, for example `go.example.com/spring`. |

### `list_domains`

No input. Returns `{ items }`, the domains the person can create links on, each with `host`, `type` and `status`.

### `check_slug`

Whether a slug is free.

| Input | Meaning |
| --- | --- |
| `domain` | The domain. |
| `slug` | 1 to 64 characters. |

Returns `{ status }`: `available`, `taken`, `locked`, `reserved`, or `invalid` with a `reason`.

### `link_stats`

Daily clicks for one link over the last 7 days. Input: `id`. Returns the same shape as [`GET /analytics/links`](api.md#get-analyticslinks).

## Write tools

These need a connection with write access. The server asks agents to confirm with the person before creating or changing a link.

### `create_link`

Create a short link.

| Input | Meaning |
| --- | --- |
| `domain` | The domain. |
| `slug` | 1 to 64 characters. |
| `url` | The destination: `http(s)`, `tel:` or `mailto:`. |
| `redirectCode` | Optional. `301` or `302`. |
| `startsAt`, `expiresAt` | Optional. Unix seconds or `null`. |
| `passQuery` | Optional. Pass the visitor's query string through. |
| `password` | Optional. Sets a password (8 to 128 characters). Never returned. |
| `routes` | Optional. Up to 10 rules `{ countries, devices, url }`, first match wins (see [links.md](links.md#routing-r)). |

Returns the new link.

### `update_link`

Change a link. Input: `id`, plus any of `url`, `redirectCode`, `startsAt`, `expiresAt`, `passQuery`, `password` (a string sets it, `null` removes it) and `routes` (replaces the whole list; `[]` clears it). Returns the changed link. Changing a link changes a live redirect that printed QR codes may use, so the tool tells the agent to confirm with the person first.

### `bulk_links`

Change up to 50 links in one call, with the same rules as one at a time.

| Input | Meaning |
| --- | --- |
| `action` | `delete`, `schedule`, `move`, `redirect` or `password`. |
| `ids` | 1 to 50 link ids. |
| `confirm` | `true` once the person has agreed (see below). |
| `domain` | Move only, required: the target domain. |
| `oldAddress` | Move only, required: `forward` (each old address keeps working and forwards to the new short link) or `copy` (an independent copy on the target; the original stays). |
| `startsAt`, `expiresAt`, `endNow` | Schedule only. `endNow: true` ends the links now. |
| `redirectCode`, `passQuery` | Redirect only. |
| `password` | Password only: a string sets it, `null` removes it. |

`delete` also needs delete access. Returns `{ results, pending }`: one entry per link, `{ id, ok: true, link: { id, shortUrl, url, hasPassword, forwardTo } }` or `{ id, ok: false, error }` with the per-link codes listed in the [API reference](api.md#post-linksbulk). A password is set on one link per call; the rest come back in `pending` for the agent to send again.

## Delete tool

### `delete_link`

Delete a link and lock its slug; any old addresses that forward to it are deleted and locked too. Needs a connection with delete access.

| Input | Meaning |
| --- | --- |
| `id` | The link id. |
| `confirm` | Must be `true` to delete. |

Returns `{ deleted: true, id }`.

## Confirmation rules

Some changes cannot be undone from a printed QR code, so the tools refuse them until the person agrees. A refused call changes nothing and answers `{ "refused": true, "summary": "..." }`; the agent is told to show the person the summary and ask before calling again with `confirm: true`.

| Tool | Refuses without `confirm: true` when |
| --- | --- |
| `delete_link` | always |
| `bulk_links` | `delete`; any `move` (forward or copy); a `schedule` that takes links offline (`endNow`, an expiry in the past, or a start in the future); a `password` set to `null` (removing a password) |

A `bulk_links` move without `oldAddress` is also refused, with a summary that asks the agent to let the person choose between forward and copy; the agent must never choose for them.

`bulk_links` refuses what the connection can never do before asking for a confirmation: a read-only connection gets `read_only`, and a delete without delete access gets `delete_not_allowed`. The other write tools get the same errors from the API when they run.

Deleted slugs stay locked. Agents cannot release a lock; people whose role has **Edit anyone's links** release it in the dashboard (see [links.md](links.md#slug-locks)).
