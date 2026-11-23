---
title: Configuration
description: Every variable, secret and binding linkwarren reads, with what it does, whether it is required and its default.
slug: docs/configuration
---

# Configuration

linkwarren is configured in your instance config, `wrangler.instance.jsonc` (copied from `wrangler.instance.example.jsonc`, gitignored), plus Worker secrets. Always deploy with `-c wrangler.instance.jsonc`. The types are in `src/env.ts`; [deploy.md](deploy.md) explains each feature in depth.

- **Vars** go in `vars` in the config. They are plain text and visible in the Cloudflare dashboard.
- **Secrets** are set with `npx wrangler secret put <NAME> -c wrangler.instance.jsonc` and never go in `vars`: a var with the same name replaces the secret on the next deploy. For local development, put them in `.dev.vars` (gitignored).
- **Bindings** connect the Worker to D1, KV, static assets and Analytics Engine.

## Bindings

| Binding | Kind | Required | What it is for |
| --- | --- | --- | --- |
| `DB` | D1 database | Yes | Everything linkwarren stores: people, domains, links, slug locks, the audit log, daily click totals and settings. Migrations live in `migrations/`. |
| `CACHE` | KV namespace | Yes | The redirect cache (host to domain, and domain and slug to link) and the instance logo. Invalidated on every write. |
| `OAUTH_KV` | KV namespace | Yes | OAuth clients, grants and tokens for AI agents. The name is fixed by the OAuth library. Keep it on every deploy, even with agents off: requests to the dashboard host pass through the OAuth library. |
| `ASSETS` | Workers static assets | Yes, for the dashboard | The built dashboard (`npm run build:web` writes `web/dist`). Keep `"run_worker_first": true`. Without it dashboard paths answer `503 {"error":"no_assets"}`. |
| `CLICKS` | Analytics Engine dataset | No | One data point per redirect, for analytics. Without it nothing is recorded. Turn on Analytics Engine for the account first, or the deploy fails with code 10089. |

The example config also sets `"triggers": { "crons": ["15 * * * *"] }`: the hourly job that rolls clicks into D1, purges old audit rows and expired limiter rows, and (at 00:15 UTC) runs the update check. Keep it. `"workers_dev": false` keeps the Worker off its `workers.dev` address, so it is reachable only through your routes.

## Required

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `DASHBOARD_HOST` | var | none | The host that serves the dashboard, its API, `/mcp` and `/api/v1`, for example `dash.example.com`. In path mode it is your main short domain. Missing or blank: every request answers `500 {"error":"misconfigured"}`. |
| `OWNER_EMAIL` | secret | none | The email that becomes the owner on its first sign-in. Only that address can create the first account, and only while there are no people yet. |
| `EMAIL_FROM` | var | none | App mode: the sender of sign-in and invite emails, an address on a domain verified in Resend. Without it, `POST /auth/email` answers `503 email_not_configured`. |
| `RESEND_API_KEY` | secret | none | App mode: the Resend key that sends email. The first key of a fresh instance must be this Worker secret; later the owner can paste a replacement in Settings (needs `SECRETS_KEY`). A Worker secret, when set, always wins over a pasted one. |

`EMAIL_FROM` and `RESEND_API_KEY` are required in app mode (the default) unless every person signs in with a passkey, which the first owner cannot do before the first email sign-in.

## Dashboard and sign-in

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `AUTH_MODE` | var | `app` | `app`: linkwarren signs people in with an email link or a passkey. `access`: Cloudflare Access signs people in. Trimmed, then exactly `app` or `access`; any other value fails closed with `500 misconfigured` on the dashboard API (on the whole instance in path mode). |
| `DASHBOARD_PATH` | var | unset (host mode) | Path mode: one lowercase segment such as `/dashboard` (a slash, then 1 to 32 of `a-z`, `0-9` and `-`, not starting or ending with `-`). The dashboard then lives at `https://<DASHBOARD_HOST>/dashboard` and every other path on that host is a short link. Needs `AUTH_MODE` `app`. See [deploy.md](deploy.md#dashboard-at-a-path). |
| `LEGACY_DASHBOARD_HOST` | var | unset | The dashboard host you used before a move. `GET` and `HEAD` there answer `301` to the same path under the dashboard; everything else answers `410` with the new address. Must be a valid host that differs from `DASHBOARD_HOST`. Never set it to a host that serves short links. |
| `ACCESS_TEAM_DOMAIN` | var | none | Access mode only: your Cloudflare Access team domain, for example `your-team.cloudflareaccess.com`. |
| `ACCESS_AUD` | var | none | Access mode only: the audience tag of the Access application that protects the dashboard host. |
| `ACCESS_JWKS_JSON` | var | unset | Test only. Replaces the real Access signing keys with a local key set. Never set it in production; the Worker logs a warning when it is set. |

## Optional secrets

| Name | Default | What it does |
| --- | --- | --- |
| `SECRETS_KEY` | unset | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Lets the owner paste `RESEND_API_KEY` and `CF_API_TOKEN` in Settings or the setup wizard; they are stored AES-GCM encrypted in D1. Without a valid key the paste field is hidden. Losing or changing it makes pasted values unreadable (see [deploy.md](deploy.md#secrets-pasted-in-the-dashboard-optional)). |
| `CF_API_TOKEN` | unset | A Cloudflare API token that lets linkwarren attach domains (DNS records, Worker routes, Cloudflare for SaaS custom hostnames) and set per-domain controls. Its permissions are listed in [deploy.md](deploy.md#api-token). Can also be pasted by the owner (needs `SECRETS_KEY`). |
| `AE_READ_TOKEN` | unset | An API token with only Account, Account Analytics, Read, for reading click data from Analytics Engine. Without it reports show daily totals from D1 only, and the hourly rollup is skipped. |
| `VISITOR_SALT` | unset | 32 random bytes as hex (`openssl rand -hex 32`), for the daily visitor code that counts unique visitors. Without it, unique visitors are not counted. |

## Cloudflare domains

All optional. Cloudflare features are on only when `CF_API_TOKEN` (or a pasted token), `CF_ACCOUNT_ID` and `CF_WORKER_NAME` are all set. Without them every domain is connected by hand.

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | var | unset | The Cloudflare account that holds your zones. Also used by analytics reports (the account that owns the dataset). |
| `CF_WORKER_NAME` | var | unset | The deployed Worker's name (the `name` in your instance config). Routes linkwarren creates point at it. |
| `CF_SAAS_ZONE_ID` | var | unset | Outside domains only: the zone that serves them through Cloudflare for SaaS. Use a zone only linkwarren uses. |
| `CF_CNAME_TARGET` | var | unset | Outside domains only: a host inside the SaaS zone, for example `edge.example.com`. Outside domains add a CNAME to it. It can never be added as a short domain. |

## Analytics

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `AE_DATASET` | var | `linkwarren_clicks` | The Analytics Engine dataset that reports read. Must match the `dataset` of the `CLICKS` binding. Letters, digits and `_` only, at most 64; any other value turns live reports off. |

Reports also need `CF_ACCOUNT_ID`, `AE_READ_TOKEN` and the `CLICKS` binding. See [deploy.md](deploy.md#analytics-optional).

## Agents

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `MCP_ENABLED` | var | unset | The instance-wide lock for AI agents. Unset or `"1"`: the switch on the API & agents screen decides (with no saved choice, agents are on only with `"1"`, so a fresh instance starts with them off). Exactly `"0"`: agents are locked off and the switch is disabled. API keys on `/api/v1` work either way. See [deploy.md](deploy.md#mcp_enabled). |

## Link passwords

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `PASSWORD_HASH_ITERATIONS` | var | `10000` | PBKDF2-SHA256 iterations for new link passwords. An integer, clamped to 1000 to 100000; anything else uses the default. The count is stored in each hash, so changing it only affects passwords set afterwards. Keep the default on the Workers Free plan (10 ms of CPU per request). |

## Settings in the dashboard

Some settings live in D1, not in the config, and are changed in Settings by owners and people with the Settings permission: the instance name and logo, the main domain, the default redirect type (`302` unless changed) and query pass-through (on unless changed) for new links, the Cloudflare controls switch, the agents switch, and **Check for updates** (on by default; see [updating.md](updating.md)).

## Limits in the code

Rate limits and budgets are constants in `src/limits.ts` (for example 120 API calls per minute per person, 1000 per person and 3000 per instance per UTC day, and 500 KV deletes per UTC day for bulk edits). They are sized for the Workers Free plan; change them there if you run on Workers Paid. The numbers and their reasons are in [deploy.md](deploy.md#limits).
