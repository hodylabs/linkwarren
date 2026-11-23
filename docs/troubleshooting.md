---
title: Troubleshooting
description: Answers to the errors and refusals you are most likely to meet, during setup, with domains, at sign-in and on redirects.
slug: docs/troubleshooting
---

# Troubleshooting

Each answer below starts from what you see: an error code from the API or the dashboard, a page, or a line in Workers Logs. linkwarren logs codes and names, never secrets or request contents, so a log line tells you which setting to look at but not its value.

## Setup

### Every request answers `500 {"error":"misconfigured"}`

The Worker refuses to run with a configuration it cannot trust. Check, in `wrangler.instance.jsonc`:

- `DASHBOARD_HOST` is set and not blank.
- `DASHBOARD_PATH`, if set, is one lowercase segment such as `/dashboard` (no trailing slash, 1 to 32 of `a-z`, `0-9` and `-`). Workers Logs shows `dashboard config invalid: DASHBOARD_PATH`.
- `LEGACY_DASHBOARD_HOST`, if set, is a valid host name and differs from `DASHBOARD_HOST`.
- `AUTH_MODE` is `app`, `access` or unset. With an invalid value, only the dashboard API and sign-in answer `500` in host mode (short links keep working); in path mode the whole instance does. Path mode also refuses `access`.

Did you deploy with `-c wrangler.instance.jsonc`? The plain `wrangler.jsonc` has no `DASHBOARD_HOST` on purpose.

### The dashboard answers `503 {"error":"no_assets"}`

The dashboard was not built, or the `assets` block is missing from the instance config. Run `npm run build:web`, keep `"assets": { "directory": "./web/dist", "binding": "ASSETS", "run_worker_first": true }` in `wrangler.instance.jsonc`, and deploy again.

### The deploy fails with code 10089

"You need to enable Analytics Engine." Turn on Workers Analytics Engine for the account (dashboard: Workers & Pages, Analytics Engine; free), or remove the `analytics_engine_datasets` line to deploy without click analytics.

### `npm run dev` does not start, or every local request is a short link

`npm run dev` needs `wrangler.instance.jsonc`. With `routes` in it, run `wrangler dev` with `--local-upstream localhost` and `--var DASHBOARD_HOST:localhost`; otherwise wrangler presents every request as coming to the first route's host, and the Worker treats it as a short link. See [development.md](development.md).

### A secret I set in `vars` stopped working

Secrets (`OWNER_EMAIL`, `RESEND_API_KEY`, `CF_API_TOKEN`, `SECRETS_KEY`, `AE_READ_TOKEN`, `VISITOR_SALT`) must be set with `npx wrangler secret put <NAME> -c wrangler.instance.jsonc`. A var with the same name replaces the secret on the next deploy. Remove it from `vars`, put the secret again, and deploy.

### The setup wizard says "incomplete"

Only the name is required (`400 incomplete` with `missing: ["name"]`). Every other step can be skipped and set later in Settings. `409 already_configured` means setup was already finished.

## Sign-in

### No sign-in email arrives

The sign-in form always answers the same way, whether or not a mail goes out, so it never tells which addresses have accounts. Check, in this order:

1. The address can sign in: an active or invited person, or `OWNER_EMAIL` while nobody has signed in yet. A disabled person gets no mail.
2. Sign-in email is configured. `503 email_not_configured` (in the dashboard: "Sign-in email is not set up on this instance") means `EMAIL_FROM` or the Resend key is missing.
3. Workers Logs. `email_cap`: the instance sent 50 sign-in emails in the last hour. `resend_rejected <status>`: Resend refused the mail, often because its free tier's 100 emails a day are used up (shared with invites), or the `EMAIL_FROM` domain is not verified. `resend_network`: Resend could not be reached.
4. Resend's own logs, and the recipient's spam folder.

Send yourself a test email from Settings (at most once a minute).

### "This email is not invited to this linkwarren" (`403 not_invited`)

The email is not in the people list. Ask an owner or a people manager to invite it. For the very first sign-in, the address must match the `OWNER_EMAIL` secret (case does not matter) and there must be no people yet.

### "Your access has been turned off" (`403 disabled`)

An owner or people manager disabled this person. They can enable them again on the People screen.

### "This sign-in link has expired or was already used" (`400 link_invalid`)

A link works once, for 15 minutes. Ask for a new one.

### "Too many tries" (`429 too_many_attempts`)

5 sign-in emails per address or 20 per network every 15 minutes, or 20 failed link or passkey checks per network every 15 minutes. Wait 15 minutes.

### "That passkey did not work here" (`400 passkey_failed`)

Passkeys belong to the dashboard host they were made on. After a move to another host (or to path mode), sign in with an email link and add a new passkey. linkwarren gives the same answer for every passkey failure on purpose.

### The owner is locked out after changing `SECRETS_KEY`

A pasted Resend key that can no longer be decrypted reads as missing (Workers Logs: `secrets_unreadable RESEND_API_KEY`), so email sign-in answers `503`. Set the key as a Worker secret, which always wins: `npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc`. Then sign in and remove the stale pasted value in Settings.

### Access mode: the health check gets a login page

`/healthz` sits behind Access on the dashboard host. Add an Access bypass policy for the path `/healthz`, or give the monitor a service token. See [deploy.md](deploy.md#access-mode).

## Domains

Every code is explained in [domains.md](domains.md); these are the common ones.

| Code | What it means | What to do |
| --- | --- | --- |
| `400 dashboard_host` | The host is the dashboard host (host mode). | Use another host for short links. |
| `400 dashboard_main_only` | In path mode the dashboard host can only be added as a main domain. | Add it as a main domain. |
| `400 reserved_host` | The host is `CF_CNAME_TARGET`. | Use another host. |
| `400 invalid_host` | Not a valid host name. | Check for typos, ports or paths. |
| `409 host_taken` | The domain is already in linkwarren. | Look for it on the Domains screen. |
| `409 pending_limit` | You already have 3 domains waiting for approval. | Ask a domain manager to approve or reject one. |
| `409 dns_record_exists` | The host already has DNS records in your Cloudflare account. | Resend with `"confirmTakeover": true` if the host should now serve short links. |
| `409 dns_not_proxied` | A record at the host is not proxied, or the name is delegated elsewhere. | Make the record proxied, or use another host. |
| `409 route_in_use` | Another Worker's route covers the host. | Remove that route, or use another host. |
| `409 hostname_in_use` | A Cloudflare for SaaS custom hostname for the host already exists, made by something else. | Remove it, or use another host. |
| `409 hostname_limit` | The SaaS zone has 95 custom hostnames. | linkwarren stops there so it never creates a billed one. |
| `400 outside_not_configured` | The host is outside your account, and `CF_SAAS_ZONE_ID` or `CF_CNAME_TARGET` is not set. | Set both, or add the host to your account. |
| `502 cloudflare_unreachable` | Cloudflare did not answer; nothing was written. | Try again. |
| `cloudflare_forbidden` | The API token lacks a permission. | Check the token in Settings, Cloudflare. |

### An outside domain stays pending

Its DNS record must be a CNAME from the host to `CF_CNAME_TARGET` (DNS only, grey cloud, when that DNS is on Cloudflare), and `dns`, `ownership` and `certificate` must all turn green. A bare domain (`example.com`) needs CNAME flattening or an ALIAS record at its DNS provider. Then a domain manager approves it.

### `certificate: not_covered`

The host is two or more labels below its zone (for example `a.b.example.com`). Cloudflare's free certificate covers the zone and one label below it. Add an advanced certificate in Cloudflare, or use a host one level down.

## Redirects

### A short link shows "Not found"

There is no live link for that slug on that domain: it never existed, was deleted (its slug is then locked), has not started yet, or has ended. The domain's not-found redirect, when set, is used instead of the page. A disabled domain, or a host linkwarren does not know, also shows it.

### A short link shows "Not active yet"

The domain is still pending. A domain manager approves it on the Domains screen.

### I changed a link, but visitors still reach the old destination

Redirects are cached in KV for up to about 5 minutes, and KV changes take up to about 60 seconds to reach every Cloudflare location. A browser that got a `301` keeps going to the old destination on its own; use `302` for anything that may change.

### `405 Method not allowed`

Short links answer `GET` and `HEAD` only (and `POST` on a password-protected link, for its form).

### The password form says "Too many tries" or "Password check is unavailable"

"Too many tries": 5 tries for that link, or 20 wrong passwords across all links, from that network in 15 minutes. People on a shared network can lock each other out for 15 minutes. "Unavailable" (`503`): the database could not be reached, often because the account's 100,000 D1 rows written per day are used up. See [deploy.md](deploy.md#password-protected-links).

### Creating a link fails with `loop`

The destination points at one of your own short domains or the dashboard host, which would redirect to itself.

### Creating a link fails with `password_301`

A password-protected link always uses `302`.

### Creating a link fails with `locked`

A link with that slug was deleted, so the slug is locked. Someone whose role has **Edit anyone's links** can release the lock in the New link sheet (see [links.md](links.md#slug-locks)).

### A contact card is refused with `bad_vcard`, `vcard_rule` or `vcard_url`

`bad_vcard` names the field that failed (for example `name` when there is no first name, last name or organization, or `photo` for a photo that is not a JPEG or PNG under 64 KB). A card takes no password or routing (`vcard_rule`) and no destination (`vcard_url`). See [vcards.md](vcards.md).

## QR codes and the weekly email

### A Wi-Fi QR code cannot be saved: `secrets_key_missing`

Wi-Fi passwords are stored encrypted with the `SECRETS_KEY` secret. Set it (`openssl rand -base64 32`, then `npx wrangler secret put SECRETS_KEY -c wrangler.instance.jsonc`). Open networks need no password and save without it. If a saved code asks for its password again, `SECRETS_KEY` changed or was lost; enter the password again.

### A QR code is refused with `low_contrast` or `inverted_colors`

The code color must be darker than the background, with a contrast ratio of at least 4.5, or many scanners cannot read it.

### `409 too_many_qr_codes`

Each person can keep at most 500 saved QR codes. Delete some first.

### The weekly email switch is off and disabled

Email is not set up on the instance (`EMAIL_FROM` and a Resend key). It is also only offered in app mode. For a failed send, Workers Logs shows `weekly email not sent <code>`, and the D1 table `digest_prefs` keeps the last code in `last_error` (`gave_up` means 6 tries failed that week). See [analytics.md](analytics.md#weekly-email).

## Agents and API keys

### `/mcp` answers `404`

Agents are off. Turn them on with the switch on the API & agents screen (owners and people with Settings). If the switch is disabled, `MCP_ENABLED` is `"0"` in the config. `503 {"error":"unavailable"}` means the setting could not be read from D1.

### An agent cannot connect: `invalid_redirect_uri`

The client's OAuth callback is not on the allowed list in [deploy.md](deploy.md#allowed-redirect-uris). The refused address is logged as `redirect refused origin=... path=...`.

### An agent answers "Your role no longer allows AI agents"

The person's role lost **Connect AI agents**. Turning it back on restores the same connections.

### `401 invalid_key`, `403 keys_not_allowed`, `429 rate_limited`, `429 kv_budget`

See the error table in [api.md](api.md#errors). Daily caps reset at 00:00 UTC.
