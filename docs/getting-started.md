---
title: Getting started
description: A fresh linkwarren install, end to end, from an empty Cloudflare account to a working short link.
slug: docs/getting-started
---

# Getting started

This page takes you from nothing to a working short link. It uses the default setup: the dashboard on its own host (`dash.example.com`), short links on another (`go.example.com`), and sign-in by email link. [deploy.md](deploy.md) is the deeper reference for everything here, including the dashboard at a path, Cloudflare Access sign-in and Cloudflare domain onboarding. Every variable is listed in [configuration.md](configuration.md).

Use your own names and hosts wherever this page says `example.com`.

## What you need

- A Cloudflare account. The [Workers free plan](self-hosting-costs.md) is enough.
- A domain whose DNS is on that Cloudflare account, for the dashboard host and your first short domain. Domains elsewhere can be added later (see [domains.md](domains.md)).
- A [Resend](https://resend.com) account with a verified sending domain, for sign-in emails. The free tier works.
- Node.js 23.6 or newer, npm and git on the machine you deploy from.

## 1. Get the code

Clone the repository and check out the newest release tag (listed on the [releases page](https://github.com/hodylabs/linkwarren/releases)):

```sh
git clone https://github.com/hodylabs/linkwarren
cd linkwarren
git checkout v0.8.0   # use the newest tag
npm ci
```

Sign wrangler in to your Cloudflare account:

```sh
npx wrangler login
```

## 2. Create the database and the KV namespaces

linkwarren needs one D1 database and two KV namespaces: `CACHE` for the redirect cache, and `OAUTH_KV` for the OAuth state of AI agents. Both bindings are required, even if you never connect an agent.

```sh
npx wrangler d1 create linkwarren
npx wrangler kv namespace create linkwarren-cache
npx wrangler kv namespace create linkwarren-oauth
```

Each command prints an id. Keep them for the next step.

## 3. Write the instance config

Copy the example config. Your copy is gitignored, so your ids and hosts never end up in the repository.

```sh
cp wrangler.instance.example.jsonc wrangler.instance.jsonc
```

Edit `wrangler.instance.jsonc`:

- `d1_databases`: put the D1 id in `database_id`. Keep `database_name` as `linkwarren` (the commands on this page use that name).
- `kv_namespaces`: put the cache namespace id on `CACHE` and the OAuth namespace id on `OAUTH_KV`.
- `vars`:
  - `DASHBOARD_HOST`: the dashboard host, for example `dash.example.com`.
  - `AUTH_MODE`: keep `app`.
  - `EMAIL_FROM`: the sender of sign-in emails, an address on your verified Resend domain, for example `links@example.com`.
  - Delete `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (they are for Cloudflare Access sign-in only).
  - Keep `CF_ACCOUNT_ID` (your Cloudflare account id) if you want click analytics: live reports and the hourly rollup need it. Delete the other `CF_*` lines for now, or fill them in if you want linkwarren to attach domains in Cloudflare for you (see [deploy.md](deploy.md#cloudflare-domains-optional)).
- `analytics_engine_datasets`: click analytics need Workers Analytics Engine turned on once for the account (dashboard: Workers & Pages, Analytics Engine; free). Turn it on now, or remove this line; a deploy with the line but without Analytics Engine fails with code 10089.
- `routes`: one entry per host the Worker serves. Keep one for the dashboard host and one for your first short domain:

  ```jsonc
  "routes": [
    { "pattern": "dash.example.com", "custom_domain": true },
    { "pattern": "go.example.com", "custom_domain": true }
  ]
  ```

  With `custom_domain`, Cloudflare creates the DNS record and the certificate for each host. The host must not already have a DNS record.

Always pass `-c wrangler.instance.jsonc`. The plain `wrangler.jsonc` in the repository has no instance values and is only for the tests.

## 4. Apply the database migrations

```sh
npx wrangler d1 migrations apply linkwarren --remote -c wrangler.instance.jsonc
```

## 5. Build and deploy

```sh
npm run build:web
npx wrangler deploy -c wrangler.instance.jsonc
```

`build:web` builds the dashboard into `web/dist`, which the Worker serves on the dashboard host.

## 6. Set the secrets

Secrets go in with `wrangler secret put`, which asks for the value. Never put them in `vars`: a var with the same name replaces the secret on the next deploy.

```sh
npx wrangler secret put OWNER_EMAIL -c wrangler.instance.jsonc
npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc
```

- `OWNER_EMAIL` is the email that becomes the owner the first time it signs in. Only that address can create the first account, and only while there are no people yet.
- `RESEND_API_KEY` is a Resend API key with sending access only, limited to your sending domain. In Resend, turn click tracking and open tracking off for that domain: click tracking would send the sign-in link through a third-party redirect.

Optional secrets, which you can add now or later:

- `SECRETS_KEY` (`openssl rand -base64 32`): lets the owner paste the Resend key and a Cloudflare token in the dashboard, stored encrypted.
- `VISITOR_SALT` (`openssl rand -hex 32`) and `AE_READ_TOKEN`: unique visitor counts and live click reports. `AE_READ_TOKEN` also runs the hourly rollup that saves daily click totals to D1, so history outlives Analytics Engine's three months; without it the rollup is skipped and no history is kept. Analytics also needs the `CF_ACCOUNT_ID` var from step 3; if you deleted it, add it back to `vars` and deploy again. See [deploy.md](deploy.md#analytics-optional).

Each `secret put` takes effect at once; no new deploy is needed.

## 7. Check that it answers

```sh
curl -s https://dash.example.com/healthz
# {"ok":true}
```

If every request answers `500 {"error":"misconfigured"}`, a variable is missing or wrong; see [troubleshooting.md](troubleshooting.md#setup).

## 8. Sign in and run the setup wizard

Open `https://dash.example.com` and enter the `OWNER_EMAIL` address. A sign-in link arrives by email; it works once, for 15 minutes. The first sign-in creates you as the owner, and the setup wizard opens:

1. **Name it**: the name shows in the dashboard, the browser tab and the emails linkwarren sends. This is the only required step.
2. **Sign-in**: add a passkey, so you can sign in on this device without waiting for an email.
3. **Connect Cloudflare**: optional. A Cloudflare API token lets linkwarren attach domains for you; the wizard checks each permission. Needs `CF_ACCOUNT_ID` and `CF_WORKER_NAME` in the config, and either the `CF_API_TOKEN` secret or `SECRETS_KEY` to paste it.
4. **Main domain**: the domain new links go on by default. Add `go.example.com` here.
5. **Email**: shows the sender and lets you send yourself a test email.
6. **Bring your links**: optional import from a CSV or JSON file (see [import.md](import.md)).

Every step except the name can be skipped and done later in Settings.

## 9. Add a domain

The main domain from the wizard is your first short domain. To add more, open Domains and add the host. Without a Cloudflare token, a domain is connected by hand: add a route for it to `routes` in `wrangler.instance.jsonc` and deploy again. With a token, linkwarren attaches domains in your account itself, and connects domains outside your account through Cloudflare for SaaS with one CNAME record. Domain types, statuses and every error are in [domains.md](domains.md).

## 10. Make a short link and test it

In the dashboard press `N` (or New link), pick `go.example.com`, type the slug `hello` and a destination, and create it. Then:

```sh
curl -sI https://go.example.com/hello
# HTTP/2 302
# location: https://example.org/...
```

A `302` with your destination means the install works end to end. A `404` "Not found" page means the slug does not exist on that domain; "Not active yet" means the domain is still pending.

## Next steps

- [links.md](links.md): link rules, moving links, bulk edit and slug locks.
- [people-and-roles.md](people-and-roles.md): invite people and decide what they can do.
- [agents.md](agents.md): connect an AI agent, or create an API key for scripts.
- [updating.md](updating.md): moving to a new release.
- [backup.md](backup.md): restores and the full export.
