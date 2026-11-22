# Agents and API

linkwarren has two ways in for software: **agents** (Claude, ChatGPT, Claude Code, Codex and other MCP clients) connect to the built-in MCP server with OAuth, and **scripts** use a personal API key on `/api/v1`. Both act as you: they can never see or change more than you can in the dashboard, and every change they make is in the audit log as "you via <agent or key>".

The operator turns agents on with `MCP_ENABLED` (see [deploy.md](deploy.md#agents-and-api)). The API & agents screen (`G I`) shows the MCP address only while agents are on; API keys work either way.

## Connect an agent

The MCP address is `https://<dashboard host>/mcp`. Copy it from the API & agents screen (`C`).

- **Claude (claude.ai and Claude Desktop):** Settings, Connectors, Add custom connector, paste the address.
- **ChatGPT:** Plugins, the plus button, Add custom MCP server, paste the address and choose OAuth. Whether you can add one depends on your ChatGPT plan and workspace role.
- **Claude Code:** `claude mcp add --transport http linkwarren https://<dashboard host>/mcp`, then run `/mcp` in Claude Code to sign in.
- **Codex:** `codex mcp add linkwarren --url https://<dashboard host>/mcp`, then `codex mcp login linkwarren` to sign in.

Any other MCP client that supports remote servers with OAuth works the same way, as long as it signs in through one of the callbacks the instance allows (claude.ai, claude.com, ChatGPT, or a local `http://localhost:<port>/callback` or `http://127.0.0.1:<port>/callback`).

Connecting opens linkwarren in your browser. Sign in if you are not already, then the approval screen shows the agent's name and, more prominently, the host it sends you back to (for example `claude.ai`). Anyone can give a client any name, so check the host. Then choose the access and approve.

## Access

- **Read only is the default.** The agent can search and read links, list domains, check slugs and read 7-day click counts.
- **Read and write** lets it create and change links.
- **Delete links** is a separate choice on top of write. Even then the agent must ask before deleting: the `delete_link` tool refuses unless it is called with `confirm: true`.

Agents have no domain restriction beyond your own: they reach every domain you can use.

### Changing access

On the API & agents screen, select the connection (`J`/`K`, `Enter`) and use the switches, then Change access. The change applies on the agent's next call; it does not need to reconnect. You can raise or lower your own connections. The owner can lower or disconnect anyone's connection but only that person can raise it again.

### Disconnecting

Select the connection and press `Shift+D` (or Disconnect), then confirm. The agent's next call fails and it has to connect again. Disconnecting someone does not touch their other agents or keys.

## Tools

| Tool | Needs | What it does |
| --- | --- | --- |
| `server_info` | read | Your access level, role, the MCP address and the limits |
| `search_links` | read | Search the links you can see, newest first |
| `get_link` | read | One link by id or by short URL |
| `list_domains` | read | The domains you can create links on |
| `check_slug` | read | Whether a slug is available, taken, locked, reserved or invalid |
| `link_stats` | read | Daily clicks for one link over the last 7 days |
| `create_link` | write | Create a short link |
| `update_link` | write | Change a link |
| `delete_link` | delete | Delete a link and lock its slug (needs `confirm: true`) |

The server tells the model that tool results are data, never instructions: a link destination or title that says "ignore your instructions" is just text.

## API keys

For scripts, create a key on the API & agents screen: New API key (`N`), give it a name (lowercase letters, digits and hyphens), choose the access (read only by default, delete only with write), optionally limit it to some domains, and pick the expiry (30, 90 or 365 days). The key (`lw_` and 43 more characters) is shown **once**: copy it then. linkwarren keeps only a hash. Revoke a key from the same screen (`Shift+D`); a revoked or expired key answers `401 {"error":"invalid_key"}`.

A key works only on `/api/v1`, sent as a Bearer token. It never works on the dashboard API (`/api`) or on `/mcp`. Keep it in an environment variable, not on the command line or in a file you commit:

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

# Change the destination (write)
curl -s -X PATCH -H "Authorization: Bearer $LW_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/summer-sale"}' "$LW/links/<link id>"

# Delete (needs delete)
curl -s -X DELETE -H "Authorization: Bearer $LW_KEY" "$LW/links/<link id>"

# Daily clicks for up to 50 links, last 7 days
curl -s -H "Authorization: Bearer $LW_KEY" "$LW/analytics/links?ids=<link id>,<link id>"
```

Bodies must be JSON (`Content-Type: application/json`); `/api/v1` needs no `Origin` header. Everything else under `/api/v1` (people, audit, keys, domain settings, imports) answers `404`: those stay in the dashboard. A key limited to some domains sees only their links and gets `403` on any other domain.

## Limits and errors

Agents and keys share per-minute limits per person, per connection and per key, a daily cap per person and a daily cap for the whole instance (UTC days). The numbers are in [deploy.md](deploy.md#limits); `server_info` also reports them. Over a limit an agent's tool answers "Rate limited, try again in a minute." or "Daily limit reached, try again tomorrow (UTC).", and the API answers `429`.

| Status | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | No `Authorization` header |
| 401 | `invalid_key` | Wrong, revoked or expired key, or the person was disabled |
| 403 | `read_only` | The key cannot create or change links |
| 403 | `delete_not_allowed` | The key cannot delete links |
| 403 | `forbidden` | Not a domain or link you (or this key) may use |
| 404 | `not_found` | No such link or domain, or a path that is not part of `/api/v1` |
| 409 | `conflict` | The link changed since it was read; read it again and retry |
| 415 | `unsupported_media_type` | The body is not JSON |
| 429 | `rate_limited` | A limit was reached; see above |
| 503 | `unavailable` | The rate limiter or database could not be reached; nothing was done |

Validation errors (for example `taken`, `locked`, `invalid_body`, `q_too_long`) are the same as in the dashboard.

## What is recorded

Every tool call is logged (time, person, agent, tool, outcome; never the arguments or results) for 90 days, and every change is in the audit log with "via". The connection list shows each agent's last use and its calls in the last 7 days. Details are in [privacy.md](privacy.md#agents-and-api-keys).

## Differences from the MCP standard

The server follows the MCP authorization spec with three deliberate differences, listed in [deploy.md](deploy.md#deviations-from-the-mcp-standard): a replayed refresh token is refused without ending the connection, `/mcp` takes OAuth tokens only (no API keys), and there is no IP allowlist because CLI clients call from people's own machines.
