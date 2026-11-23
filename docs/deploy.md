# Deploying linkwarren

linkwarren runs as one Cloudflare Worker with a D1 database and a KV namespace. These steps are generic; use your own names and ids.

## Configuration

Copy `wrangler.instance.example.jsonc` to `wrangler.instance.jsonc` (gitignored) and fill it in. **Always deploy with `-c wrangler.instance.jsonc`**; the default `wrangler.jsonc` carries no instance values and must not be deployed.

Required vars:

- `DASHBOARD_HOST`: the hostname that serves the dashboard and API. If it is missing or blank, every request answers `500 {"error":"misconfigured"}`.
- `AUTH_MODE`: how people sign in, `app` (the default) or `access`. See [Sign-in](#sign-in).
- App mode: `EMAIL_FROM`, the sender address of sign-in emails, e.g. `links@example.com`.
- Access mode only: `ACCESS_TEAM_DOMAIN` (your Cloudflare Access team domain, e.g. `your-team.cloudflareaccess.com`) and `ACCESS_AUD` (the audience tag of the Access application that protects the dashboard host).

Required secrets:

- `OWNER_EMAIL`: the email that becomes the owner on first sign-in. Only that email can bootstrap, and only while the users table is empty.
- App mode: `RESEND_API_KEY`, the Resend API key that sends sign-in emails (`npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc`).

Set `OWNER_EMAIL` only with `npx wrangler secret put OWNER_EMAIL -c wrangler.instance.jsonc`. Do not add it (or `RESEND_API_KEY`) to `vars`: a var with the same name replaces the secret on the next deploy.

Optional vars (see [Dashboard at a path](#dashboard-at-a-path)):

- `DASHBOARD_PATH`: unset or blank (the default) is **host mode**. A value such as `/dashboard` is **path mode**.
- `LEGACY_DASHBOARD_HOST`: an old dashboard host that now only redirects to the dashboard.

`ACCESS_JWKS_JSON` is **test-only**. It replaces the real Access signing keys with a local key set. Never set it in production; the app logs a warning if it is set.

`workers_dev` is `false` in the example config so the Worker is reachable only through your routes.

## Dashboard at a path

**Host mode** (default, `DASHBOARD_PATH` unset): the dashboard owns `DASHBOARD_HOST` entirely, for example `https://dash.example.com`. Route that host to the Worker as well as every short domain.

**Path mode** (`DASHBOARD_PATH` set, for example `/dashboard`): `DASHBOARD_HOST` is your main short domain, for example `example.com`, and the dashboard, API and health check live at `https://example.com/dashboard`. Every other path on that host is a short link, exactly as on any other short domain. The rules:

- `DASHBOARD_PATH` is one lowercase segment: a slash, then 1 to 32 of `a-z`, `0-9` and `-`, not starting or ending with `-`, no trailing slash. Anything else answers every request with `500 {"error":"misconfigured"}` and logs `dashboard config invalid: DASHBOARD_PATH` (the name, never the value).
- Path mode needs `AUTH_MODE` `app` (or unset). `access` is refused as misconfigured: an Access application cannot cover the prefix while leaving the short links and the OAuth discovery documents open.
- Only the prefix and its subpaths belong to the dashboard (`/dashboard`, `/dashboard/...`), matched exactly and case-sensitively: `/dashboardx`, `/Dashboard` and `/%64ashboard` are short-link paths. Paths starting with `/.well-known/oauth-` or `/.well-known/openid-configuration` are never short links (they answer JSON).
- The health check is `https://<DASHBOARD_HOST><DASHBOARD_PATH>/healthz`; `/healthz` on the main domain is an ordinary short-link path.
- The session cookie is `__Secure-lw_session` with `Path=<DASHBOARD_PATH>` (host mode: `__Host-lw_session`, `Path=/`), host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, so browsers never send it with a short-link visit on the main domain. Each mode reads only its own cookie name: switching modes signs everyone out.
- Use path mode only on a domain whose subdomains you all control: unlike `__Host-`, a `__Secure-` cookie does not stop a sibling host under the same registrable domain from setting a cookie with the same name and `Domain=` (cookie tossing), which could sign a visitor in as someone else or out.
- Passkeys belong to the dashboard's host. Moving the dashboard to the main short domain means passkeys made on the old dashboard host stop working: people sign in with an email link and add a new passkey.

`LEGACY_DASHBOARD_HOST` (optional, either mode) is the dashboard host you used before. Keep it routed to the Worker: `GET` and `HEAD` there answer `301` to the same path and query under the dashboard (`https://old.example.com/links?x=1` to `https://example.com/dashboard/links?x=1`), so bookmarks and recent sign-in links keep working. Every other method, and every `/.well-known/` path, answers `410 {"error":"moved","to":"<dashboard>/"}`: API scripts and agent connections must be pointed at the new address. The old host never serves short links or the dashboard. It must be a valid host name and differ from `DASHBOARD_HOST`, or every request answers `500 misconfigured`.

## Local development

`npm run dev` runs `npx wrangler dev -c wrangler.instance.jsonc`, so it needs the instance config:

1. Copy `wrangler.instance.example.jsonc` to `wrangler.instance.jsonc` if you have not already.
2. Set `DASHBOARD_HOST` to the host you open locally, for example `localhost` (the port is ignored).
3. Put `OWNER_EMAIL=you@example.com` in `.dev.vars` (gitignored); local dev reads secrets from there.
4. Apply migrations to the local database: `npx wrangler d1 migrations apply linkwarren --local -c wrangler.instance.jsonc`.

Without the instance config `npm run dev` fails to start, and a Worker run without `DASHBOARD_HOST` answers every request with `500 {"error":"misconfigured"}`.

## Dashboard assets

The dashboard is a static web app served by the Worker from Workers static assets, on the dashboard host only.

1. Build it first: `npm run build:web` (output in `web/dist`).
2. Keep the `assets` block from `wrangler.instance.example.jsonc` in your instance config: `{ "directory": "./web/dist", "binding": "ASSETS", "run_worker_first": true }`.
3. `run_worker_first` must stay `true`. The Worker decides by host: short hosts never reach the asset layer, so they can never be answered with dashboard files. With it `false`, the platform would serve `/index.html` and `/assets/*` on every short domain.

Without the binding, dashboard paths answer `503 {"error":"no_assets"}`. Unknown paths without a file extension get the app shell (client-side routing); a missing file such as `/assets/x.js` stays 404.

## Steps

1. Create the D1 database and the KV namespace (`npx wrangler d1 create`, `npx wrangler kv namespace create`) and put their ids in `wrangler.instance.jsonc`.
2. Apply migrations to the remote database: `npx wrangler d1 migrations apply linkwarren --remote -c wrangler.instance.jsonc`.
3. Build the dashboard (`npm run build:web`), then deploy: `npx wrangler deploy -c wrangler.instance.jsonc`.
4. Add one route per short domain plus the dashboard host (custom domains in the config).

## Cloudflare domains (optional)

With these set, linkwarren attaches domains in Cloudflare itself: same-account domains get a proxied DNS record and a per-host Worker route, outside domains get a Cloudflare for SaaS custom hostname. Without them every domain stays manual (add DNS and routes yourself, as above).

Vars (in `wrangler.instance.jsonc`):

- `CF_ACCOUNT_ID`: the Cloudflare account that holds your zones.
- `CF_WORKER_NAME`: the deployed Worker script name (the `name` in your instance config).
- `CF_SAAS_ZONE_ID`: the zone that serves outside domains through Cloudflare for SaaS (only needed for outside domains).
- `CF_CNAME_TARGET`: a host inside that zone, for example `edge.example.com`. Outside domains add a CNAME to it.

Secret: `CF_API_TOKEN`, set only with `npx wrangler secret put CF_API_TOKEN -c wrangler.instance.jsonc` (never in `vars`). Cloudflare features are on only when the token, `CF_ACCOUNT_ID` and `CF_WORKER_NAME` are all set; outside domains also need `CF_SAAS_ZONE_ID` and `CF_CNAME_TARGET`. The token is never shown again and never written to logs or the audit log. Instead of the Worker secret, the owner can paste the token in Settings (see "Secrets pasted in the dashboard"); it is then stored encrypted in D1, never in plain text.

### API token

Create a custom API token (My Profile or Manage Account, API Tokens, Create Custom Token) with these permissions, limited to the zones linkwarren may use:

| Group | Permission | Why |
| --- | --- | --- |
| core | Zone, Zone, Read | See which domains are in this account |
| core | Zone, DNS, Edit | Point your domains at linkwarren |
| core | Zone, Workers Routes, Edit | Send each domain's traffic to the app |
| outside | Zone, SSL and Certificates, Edit | Add outside domains with a CNAME (Cloudflare for SaaS) |
| controls | Zone, Config Rules, Edit | Security level per domain |
| controls | Zone, Zone WAF, Edit | Rate limit per domain |

In the token UI the Config Rules permission is listed under the name "Config Settings". The controls group is only needed when the "Cloudflare controls" switch in Settings is on. Never grant Workers Scripts, Account settings, API Tokens or Access: linkwarren does not need them, and Workers Scripts would let a leaked token replace the app's own code.

Check the token from Settings, Cloudflare (`Check token`), or with `POST /api/settings/cloudflare/check`. The check never writes: it verifies the token, then sends requests Cloudflare must reject (empty name, pattern or hostname) and reads the answer. The two controls permissions show "unknown" until first use, because no safe test request exists for them. The check tests one zone only (the SaaS zone, or the first zone in the account), so a token limited to some zones can pass there and still miss another zone. If SSL and Certificates shows missing, also check that Cloudflare for SaaS is enabled on the zone.

### Outside domains (Cloudflare for SaaS)

Use a SaaS zone that only linkwarren uses: no other Worker routes and no custom hostnames from other tools. linkwarren refuses an outside domain when another Worker's route covers the host (`route_in_use`) or when a custom hostname for it already exists that linkwarren did not create (`hostname_in_use`), so a shared zone mostly means refusals, but a dedicated zone removes the question entirely.

Cloudflare for SaaS includes 100 custom hostnames and bills each one after that. linkwarren never creates the 101st: it counts the zone's hostnames before every create and refuses with `hostname_limit` from 95 on (headroom for concurrent creates), so it never adds a billed custom hostname. It also uses no paid Workers features. Any other Cloudflare charge depends on the account's own plan and settings. Settings, Cloudflare shows how many custom hostnames are used.

1. Enable Cloudflare for SaaS (custom hostnames) on the zone you chose for `CF_SAAS_ZONE_ID`.
2. Create the fallback origin, either with Settings, Cloudflare, `Set up outside domains` (`POST /api/settings/cloudflare/setup`), or by hand: add a proxied `AAAA` record `CF_CNAME_TARGET` to `100::`, then set `CF_CNAME_TARGET` as the fallback origin under SSL/TLS, Custom Hostnames. The setup endpoint never changes anything it did not create: it refuses with `fallback_in_use` when the zone already has a different fallback origin (changing it would repoint every custom hostname in that zone), and with `target_in_use` when an address record it did not create already exists at the target. linkwarren remembers the id of the record it creates (and marks the record's comment, so a retry recognises it even if that write was lost), so running setup again is safe. Settings shows the fallback origin as `in_use` when the zone already uses someone else's; outside domains are not ready then.
3. Wait until the fallback origin shows active. Outside domains can then be added: each one adds a CNAME from its host to `CF_CNAME_TARGET` at its own DNS provider.

A bare domain (for example `example.com` rather than `go.example.com`) cannot carry a plain CNAME. Its DNS provider must support CNAME flattening or an ALIAS/ANAME record pointing at `CF_CNAME_TARGET`.

### Resync

In our tests a Worker route created through the API survived `wrangler deploy` with the routes from the example config, so there is normally nothing to redo after a deploy. Wrangler manages the routes in your config; if a deploy (for example after a config change) ever removes a route linkwarren made, that domain stops serving: run `Resync domains` and it re-creates the route. `Resync domains` in Settings (`POST /api/settings/cloudflare/resync`) is a repair tool: run it after someone changed or removed linkwarren's records, routes or custom hostnames in the Cloudflare dashboard, or after a write was lost. It re-creates only what linkwarren created itself, never takes over a record or route someone else made, and lists the domains it could not repair.

Disabled domains are skipped. Each call repairs at most 3 domains (in domain id order) so it stays within the Workers Free limit of 50 subrequests per request. The answer is `{ ok, failed, next }`: while `next` is not null, call again with `{ "after": "<next>" }` until it is. Each failure carries one of the codes listed under Status in [domains.md](domains.md). When Cloudflare cannot be reached (`cloudflare_unreachable`) the call stops at that domain and `next` points at it, so the retry starts there; any other code is per domain and the run goes on. The dashboard repeats the calls for you.

## Analytics (optional)

linkwarren records one Workers Analytics Engine data point per redirect to a live link (GET only), after the redirect is sent, so analytics never slow or break a redirect. What is stored, and what never is, is in [privacy.md](privacy.md).

- Enable Workers Analytics Engine once on the account before adding the binding (dashboard: Workers & Pages, Analytics Engine; free). Until then a deploy with the binding fails with code 10089 ("You need to enable Analytics Engine"), so leave the binding commented out to deploy without analytics.
- Binding: `"analytics_engine_datasets": [{ "binding": "CLICKS", "dataset": "linkwarren_clicks" }]` in `wrangler.instance.jsonc`. There is no create step: the dataset appears after the first data point is written (the first redirect after the deploy). Without the binding nothing is recorded, and reports and the Links sparkline say live clicks are off even when the read token is set.
- Var `AE_DATASET`: the dataset name the reports read (default `linkwarren_clicks`, letters, digits and `_` only, at most 64). Reports also use `CF_ACCOUNT_ID` (the account that owns the dataset).
- Secret `VISITOR_SALT`: 32 random bytes as hex, for the daily visitor code. Create it with `openssl rand -hex 32` and set it with `npx wrangler secret put VISITOR_SALT -c wrangler.instance.jsonc`. Without it the visitor code is left empty and unique visitors are not counted.
- Secret `AE_READ_TOKEN`: an API token that reads the dataset. Create a custom token (My Profile or Manage Account, API Tokens, Create Custom Token) with only **Account, Account Analytics, Read**, limited to the one account, and set it with `npx wrangler secret put AE_READ_TOKEN -c wrangler.instance.jsonc`. linkwarren uses it with the Analytics SQL API (`POST https://api.cloudflare.com/client/v4/analytics/sql`), not the classic `/accounts/<id>/analytics_engine/sql` endpoint, which refuses an account-owned token. Without it reports show daily totals from D1 only.

Never put `VISITOR_SALT` or `AE_READ_TOKEN` in `vars`. Neither is ever logged, returned by the API or put in an error message. Workers Analytics Engine is available on the Workers Free plan.

### Scheduled job

A Cron Trigger runs every hour at :15: `"triggers": { "crons": ["15 * * * *"] }` in `wrangler.instance.jsonc`. Cron Triggers are free on the Workers Free plan. Each run does two independent things; one failing never stops the other.

- **Rollup (every run).** Analytics Engine keeps raw clicks for about 3 months, so the job copies each UTC day once it is at least 2 full days old (through today-2, so late Analytics Engine points for yesterday are not lost; reports read the days after the mark live from Analytics Engine) into the D1 tables `clicks_daily` and `clicks_daily_dim` and records the last day written in `analytics_state` (`rolled_through`). Reports read days up to that mark from D1 and later days live from Analytics Engine, so no day is lost or counted twice. Re-running a day replaces it, never adds to it. Without `CF_ACCOUNT_ID`, `AE_READ_TOKEN` or the `CLICKS` binding the rollup is skipped.
  - Limits, to stay inside the Free plan (10 ms CPU per run, 100,000 D1 rows written per day for the whole account): a run writes at most 3 days, oldest first, starting no earlier than 88 days ago, with 5 Analytics Engine queries per day, each summed by Analytics Engine to exactly the rows D1 stores. A normal day is one small run; a 90-day backlog clears in about 30 hours.
  - Write budget: a run writes at most 10,000 D1 rows and the rollup plus the expired-row cleanup at most 40,000 per UTC day together (kept in `analytics_state` as `rollup_writes`). A day costs 3 writes per row it inserts (the row and its two indexes), 3 per row it replaces, and 4 for the state rows, counted before it is sent. The run stops before a day that would go over and logs `analytics rollup paused day=<day> writes=<n>`; the next hour continues.
  - A day is written whole or not at all. If an Analytics Engine answer would be over 2,000 rows (`ae_truncated`) or the day alone needs more than 10,000 writes (about 3,300 rollup rows: one per link clicked that day, plus one per link and country, device or referrer), the rollup stops at that day and logs it every hour; reports still read that day live while Analytics Engine has it. Such an instance needs a bigger plan than this job assumes.
- **Audit purge (00:15 UTC run only).** Audit rows older than 3 years (1096 days) are deleted, at most 5000 per run, oldest first (the next day continues), and the deletion itself is written to the audit log as `audit.purge` by the actor `system`.

Logs show `analytics rollup: <days>` and `audit purge: <count>`; errors are logged by name (a failed rollup also logs the failing day and the safe `ae_<code>`, never the token or a response body). To run the job locally:

```sh
npx wrangler dev --test-scheduled -c wrangler.instance.jsonc
curl "http://localhost:8787/__scheduled?cron=15+*+*+*+*"
```

To re-roll days (for example after a fix), set the mark back, e.g. `UPDATE analytics_state SET v = '2026-11-17' WHERE k = 'rolled_through'`; the next runs rewrite the days after it that Analytics Engine still holds, 3 per hour. A re-roll costs D1 writes on the Free plan: about 6 per rollup row of each day (3 to delete the old row, 3 to insert the new one), inside the same write budgets, so moving the mark far back takes several hours or days to catch up.

## Secrets pasted in the dashboard (optional)

`CF_API_TOKEN` and `RESEND_API_KEY` can come from two places:

1. **Worker secret** (`npx wrangler secret put <NAME> -c wrangler.instance.jsonc`). When set (non-empty), it always wins, and the dashboard refuses a paste for that name (`409 set_by_secret`).
2. **Pasted by the owner** in Settings or the setup wizard. This needs the optional secret `SECRETS_KEY`: base64 of exactly 32 random bytes. Create it with `openssl rand -base64 32` and set it with `npx wrangler secret put SECRETS_KEY -c wrangler.instance.jsonc`. Without a valid `SECRETS_KEY` the paste field is hidden and the API answers `409 secrets_key_missing`.

A pasted value is encrypted with AES-GCM (256-bit key from `SECRETS_KEY`, a fresh random 96-bit IV on every save, the secret's name bound as additional data) and stored in the `settings` table under the key `secret.<NAME>`. Values are write-only: no screen or API returns them, only whether each is set by Worker secret, set in the dashboard, or missing. Saves and removals are audited as `secret.update` / `secret.delete` with the name only. The full export never includes these rows.

- **Losing or changing `SECRETS_KEY`** makes the stored values unreadable. They read as missing (Workers Logs shows `secrets_unreadable <NAME>`, never the value). Redirects never depend on them, but **a pasted Resend key that becomes unreadable stops email sign-in**: `POST /auth/email` answers `503 email_not_configured`, and an owner without a passkey cannot sign in to paste it again. Recovery needs no sign-in: set the key as a Worker secret with `npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc` (the Worker secret always wins), sign in, and optionally remove the stale pasted value in Settings. A lost Cloudflare token only stops the Cloudflare features until it is pasted or set again.
- **A pasted Cloudflare token** is checked against Cloudflare before it is saved (it must verify as active); `CF_ACCOUNT_ID` and `CF_WORKER_NAME` must already be set as vars. This works on a fresh instance.
- **A pasted Resend key cannot bootstrap a fresh app-mode instance**: the owner has to sign in first, and in app mode that needs a working email link (or a passkey), so the first key must be the Worker secret. Pasting is for replacing a key later.

## Sign-in

`AUTH_MODE` picks one of two sign-in modes. They never mix: app mode ignores Access tokens, and access mode ignores linkwarren session cookies. Unset or blank means `app`. The value is trimmed and must then be exactly `app` or `access` (lowercase); any other value fails closed: the dashboard API and `/auth/*` answer `500 {"error":"misconfigured"}`, while short links keep redirecting. In path mode an invalid `AUTH_MODE` is a dashboard config error, so the whole instance (short links on every domain included) answers `500 {"error":"misconfigured"}` until it is fixed.

### App mode (default)

linkwarren signs people in itself, with an email link or a passkey. No Access application is needed.

- Set the var `EMAIL_FROM` (e.g. `links@example.com`) and the secret `RESEND_API_KEY`. Without both, `POST /auth/email` answers `503 {"error":"email_not_configured"}`.
- `/healthz` is public on the dashboard host (in path mode `<DASHBOARD_PATH>/healthz`); no bypass is needed.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not used.

#### Email sign-in links (Resend)

Sign-in links are sent through [Resend](https://resend.com) only.

1. Add and verify your sending domain in Resend (the domain of `EMAIL_FROM`).
2. In the domain's settings, turn **click tracking and open tracking off**. Click tracking would route the sign-in link through a third-party redirect, and open tracking adds an image.
3. Create an API key with **sending access only**, restricted to that domain.
4. Give the key to linkwarren one of two ways: as a Worker secret (`npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc`, never in `vars`; it wins when set), or, after your first sign-in, pasted by the owner in the setup wizard or Settings, which stores it encrypted in the database (needs `SECRETS_KEY`). The first key of a fresh app-mode instance must be the Worker secret (see above).
5. Set the var `EMAIL_FROM` to an address on that verified domain, e.g. `links@example.com`. Mail is sent as `<instance name> <EMAIL_FROM>`.
6. In Settings, use **Send test email**: it mails the signed-in person who sends it (an owner, or a role with the `settings` permission) only, at most once a minute, and counts against the hourly instance cap.

All mail shares one Resend budget: the Resend free tier sends 100 emails a day for the account (sign-in links, invites and test mails together). linkwarren splits it with its own caps: at most 50 sign-in emails per hour, and invites at most 1 per address per minute, 20 per hour and 40 per UTC day for the instance, so at least 60 of the 100 stay for sign-in links. The sign-in hourly cap alone does not stop a busy day from reaching 100: once Resend refuses, every mail fails (the Worker logs `resend_rejected` with the status) until Resend's daily reset, and people without a passkey cannot sign in until then. Onboarding a large team on the free tier, invite at most 40 people a day, or use a paid Resend plan. At an invite cap the person is still created and the dashboard says the email was not sent (`too_many`); resend it later. Invites and sign-in links use the instance name in the subject and sender. The invite says who invited the person, links only to `https://<dashboard host>/join` (no address, id or token in the URL), and adds an owner line for owners.

How the link works: a person enters their email, and if it can sign in here (an active or invited person, or `OWNER_EMAIL` while there are no users yet) they get a link to `https://<dashboard host>/sign-in#token=...`. The token is in the URL fragment, so it never reaches server logs or a `Referer`. It works once and expires after 15 minutes. The answer is always the same `202`, whether or not a mail goes out, so the form never tells which addresses have accounts.

Limits (all in D1, no paid features): 5 requests per address and 20 per IP range (/24 or /48) every 15 minutes, 20 failed link checks per IP range every 15 minutes, and at most 50 sign-in emails per hour for the whole instance. The hourly cap keeps a flood of requests for known addresses from spending the day's Resend budget in one go (see the shared budget above). At the cap the request still gets the normal answer, no mail is sent, and the Worker logs `email_cap`. Resend errors are logged as `resend_rejected <status>` or `resend_network`, never with the message.

### Access mode

Set `AUTH_MODE` to `access`. Cloudflare Access signs people in, exactly as before this mode switch; `/auth/*` and `/api/account/*` answer 404.

Create a Cloudflare Access application on the dashboard host only. Short domains must stay public. Take its audience tag for `ACCESS_AUD`, and set `ACCESS_TEAM_DOMAIN`.

Invite links open `/join`, a page that shows who the browser is signed in as and offers Sign out or Continue, so an invite opened in someone else's signed-in browser never silently continues as them.

Inviting people in access mode: the invite creates the person and emails them the dashboard address, but Access decides who gets past the login. Add each invitee to the Access application's policy too, or they cannot open the link. They become active on their first visit.

Health checks: `/healthz` sits behind Access on the dashboard host. Add an Access bypass policy for the path `/healthz`, or give the monitor a service token, otherwise the check gets a login redirect.

### Updating to a new release

linkwarren never updates itself. Once a day it checks GitHub for the latest release (see [privacy.md](privacy.md#update-check)), and owners and people with the Settings permission see "vX.Y.Z available" next to the dashboard version, linking to the release notes. To update, read the notes, pull the release, apply any new migrations and deploy it by hand as in Steps above. The check can be turned off in Settings, This instance (**Check for updates**).

### Upgrading an existing instance

Instances deployed before the sign-in modes used Access. The default is now app mode, so an upgrade without a setting switches the dashboard to app mode and ignores the Access token.

1. **Keep Access:** set `AUTH_MODE` to `access` before deploying this version. Nothing else changes.
2. **Move to app mode later**, as its own step: set `EMAIL_FROM` and `RESEND_API_KEY`, apply the migrations, then set `AUTH_MODE` to `app` (or remove the `access` value; unset also means `app`) and deploy. Check that you can sign in, and only then remove the Access application.

### Upgrading to bulk edit and forwarders (migration 0008)

This version adds migration `0008_forwarders.sql`. **Apply it before you deploy the Worker.** It adds the column `links.forward_to`, the partial index `links_forward_to` and the index `slug_locks_lower` (case-insensitive lock lookups):

1. `npx wrangler d1 migrations apply <db> --remote -c wrangler.instance.jsonc`
2. Deploy: `npx wrangler deploy -c wrangler.instance.jsonc`

Order matters. The new Worker reads `forward_to` on every link query and uses `slug_locks_lower` for every lock check. Without the migration, moves fail (the loop check errors and is swallowed, so every move is refused) and lock checks run without their index. The old Worker keeps working against the migrated database, so applying the migration first is always safe.

### Upgrading to people and setup (migration 0009)

This version adds migration `0009_links_created_by.sql`, one index (`links_created_by`) that removing a person uses to count and move their links. Apply it before or after deploying; without it removal still works but reads every link. Same commands as above.

Owners of an instance deployed before this version see the setup wizard once, on their next visit. The name and the main domain are required (an existing main domain is offered as the choice); the other steps, including the import, can be skipped.

Write costs: the index adds one D1 row written per link created and per change of a link's creator. Removing a person moves all their links to the person you choose in one batch, about 3 rows written per link, so removing someone who created tens of thousands of links can use a large share of the Free plan's 100,000 rows written per day (or fail when the day's budget is gone, leaving nothing changed). Remove such a person early in the UTC day.

### Upgrading to per-domain daily totals (migration 0010)

This version adds migration `0010_clicks_per_domain.sql`. It rebuilds `clicks_daily` and `clicks_daily_dim` so a link moved to another domain during a day keeps that day's clicks under each domain they happened on, instead of all under its newest domain. **Apply it before you deploy the Worker** (same commands as above). Until it is applied, the new rollup fails for a day on which a link was clicked on two domains and retries that day on every run, so nothing is lost as long as the migration lands within Analytics Engine's 90-day retention.

Write costs: the rebuild copies every existing row of both tables once, so an instance with years of totals can use a large share of the Free plan's 100,000 rows written per day. Apply it early in the UTC day. Days already rolled up before the upgrade keep their old totals (all under the newest domain of that day).

## Password-protected links

A link with a password answers its short URL with a small form page instead of a redirect. The form posts back to the same URL (query included); a right password answers `303` to the destination (routes and query pass-through apply, the QR marker is stripped), with `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. A wrong one shows the form again with a generic message (`401`). There is no unlock cookie: every visit asks again, and short hosts never set cookies. The unlock POST must carry `Origin: https://<short host>` and a form body of at most 2048 bytes (enough for 128 characters of any script), else `403`, `415`, `411` or `413`. Showing the form records no click; a right unlock records one.

Limits (D1, the same table as sign-in, global across Cloudflare locations, no paid features), all checked before any hashing work:

- 5 unlock attempts per link per IP range (/24 or /48) every 15 minutes. Each attempt reserves a slot in one atomic statement (which also checks the two limits below) before the password is checked, so parallel guesses cannot slip past it; a right password gives its slot back, so people behind one office network can all open the link.
- 30 right unlocks per link per IP range every 15 minutes (key `unlockok:`). It is read before any write, so a script that loops one known password stops costing writes and hashing after 30. Parallel bursts can pass it by a few, because the count is written after the password check.
- 20 wrong passwords per IP range every 15 minutes, across all links.

Past a limit the form answers `429` with `Retry-After: 900`. If D1 cannot be reached the form answers `503` ("Password check is unavailable right now.") and no password is checked. A guesser with many IP ranges gets more tries, so use long passwords for sensitive links. Someone on the same IP range (a shared or carrier NAT) can lock that range out for 15 minutes with wrong tries; a visitor who gets "Too many tries" on the first try is usually seeing that.

D1 writes, counted the way the hourly rollup counts them (`src/cron.ts`) and measured with the local D1: a limiter key seen for the first time in its window writes 3 rows (the row, its primary-key index and the `window_start` index); an upsert of an existing key writes 2, and the refund 1.

- A right unlock writes about 5 rows (reserve, refund, right-unlock count), or 7 when the range is new to the link.
- A wrong one writes about 4 (reserve, failure count), or 6 when new.
- A POST from a range that is already limited writes none.
- Per range in 15 minutes: at most about 30 x 5 = 150 rows per link for right unlocks, and about 20 x 4 = 80 (up to 120 with new keys) for wrong ones across all links.

The Free plan allows 100,000 D1 rows written per day for the whole account. N unlocks a day spend about 5N to 7N of that, so about 15,000 to 20,000 right unlocks a day (a password printed on a flyer, from many ranges) use the whole quota. When it is gone, D1 refuses writes: every protected link answers `503`, and sign-in, link edits and the hourly rollup fail too. For any protected link with real traffic, add a Cloudflare WAF rate limiting rule for `POST` on your short hosts, per IP, with a low threshold (the Free plan includes one rate limiting rule; check which periods your plan offers). It stops floods at the edge, before they cost Worker CPU or D1 writes; the Origin check does not, because Origin is easy to forge outside a browser. Expired limiter rows are deleted by the hourly cron, up to 2000 rows per table per run, inside the same run and daily write budgets as the rollup.

HTTPS: a protected link is only served over HTTPS. A plain-HTTP GET or HEAD answers `308` to the same URL on `https:`, a plain-HTTP POST is refused (`403`), and the form and unlock answers carry `Strict-Transport-Security: max-age=31536000`. Turn on **Always Use HTTPS** (SSL/TLS, Edge Certificates) on every short-link zone as well, so unprotected links are upgraded too.

Hashing: PBKDF2-SHA256 with the iteration count from the optional var `PASSWORD_HASH_ITERATIONS` (integer, clamped to 1000..100000; unset uses the built-in default of 10000). The count is stored in each hash, so changing the var only affects passwords set afterwards; existing links keep working. One unlock attempt costs one PBKDF2 run. Measured live on Workers Free, 25000 iterations took 10 to 18 ms of CPU per unlock, over the Free plan's 10 ms per request. At 10000 an unlock usually takes 3 to 9 ms; a cold start measured about 14 ms, which the Free plan's burst allowance absorbed in testing. On the Free plan keep 10000; on Workers Paid you may raise it up to 100000. 10000 iterations is far below current guidance against offline cracking: if the D1 or KV contents ever leak, short passwords fall quickly, so use long ones.

Bulk set: setting one password on many links hashes one link per request (a PBKDF2 run already fills the Free plan's 10 ms of CPU). The first link in the request gets the password; the others come back in `pending` and the caller sends the same request again with them (the dashboard does this by itself, an API client or agent loops on `pending`). Each link gets its own salt. Copying a protected link to another domain reuses the stored hash, so the copy has the same password and the same salt. Removing a password (`null`) needs no hashing and applies to all links at once.

Caching: a browser that once got a `301` for a link keeps going straight to the old destination. A link that was `301` and now has a password can therefore still be skipped by those browsers (they already knew the destination), and a `301` link with routes sends returning visitors to the destination they got first, even after they travel or the routes change. Use `302` for links with routes.

## Agents and API

Agents (Claude, ChatGPT, Claude Code, Codex, Gemini and other MCP clients) connect to `https://<dashboard host>/mcp` with OAuth; scripts use personal API keys on `/api/v1`. How people connect and use them is in [agents.md](agents.md). This section is what the operator sets up, and what it costs on the Workers Free plan.

### Setup

1. Create a second KV namespace for the OAuth state: `npx wrangler kv namespace create linkwarren-oauth`. Put its id in `wrangler.instance.jsonc` under the binding **`OAUTH_KV`** (the name is fixed by the OAuth library; see `wrangler.instance.example.jsonc`). Keep the binding on every deploy, also with MCP off: requests to the dashboard host pass through the OAuth library.
2. Apply the migrations, which include `0007_agents.sql` (tables `api_keys`, `agent_connections`, `tool_calls`): `npx wrangler d1 migrations apply linkwarren --remote -c wrangler.instance.jsonc`.
3. Leave `MCP_ENABLED` unset and deploy, then sign in as the owner and turn agents on with the switch on the API & agents screen (see [MCP_ENABLED](#mcp_enabled)). Check it: `curl -si -X POST https://<dashboard host>/mcp` answers `401` with a `WWW-Authenticate` header that contains `resource_metadata="https://<dashboard host>/.well-known/oauth-protected-resource/mcp"`, and `curl -s https://<dashboard host>/.well-known/oauth-authorization-server` answers JSON. With the dashboard at a path (`DASHBOARD_PATH`), the address is `https://<main short domain>/dashboard/mcp`, the `resource_metadata` URL is `https://<main short domain>/.well-known/oauth-protected-resource/dashboard/mcp`, the authorization server metadata stays at the root `/.well-known/oauth-authorization-server` (issuer: the origin), and the switch closes the same paths under the prefix; the full table is in [agents.md](agents.md#dashboard-at-a-path).

### MCP_ENABLED

Whether agents can connect is a switch on the API & agents screen. It is stored in the D1 table `settings` (key `mcp.enabled`), changed only by people with the Settings permission (owners always), and each change is written to the audit log as `settings.update`. Every signed-in person sees the state; only people with Settings can change it. The Worker caches the value for 10 seconds per isolate: the isolate that saved it applies it at once, others within 10 seconds.

The var `MCP_ENABLED` is the instance-wide lock:

- **Unset or `"1"`:** the switch decides. With no saved choice, agents are on only when the var is `"1"`, otherwise off. So a fresh instance has agents off until the owner turns them on.
- **Exactly `"0"`:** agents are locked off and the switch is disabled (a save answers `409 mcp_locked`). Any other value, for example `"false"`, does not lock: once a choice is saved, the switch decides.

Off, `/mcp`, `/authorize`, `/token`, `/register`, `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (with or without `/mcp`) answer `404 {"error":"not_found"}` (`/authorize` in any URL encoding): no agent can register, connect, refresh or call a tool. It revokes nothing: grants and connections stay, and turning agents back on makes them work again. If D1 cannot be read to decide, the same paths answer `503 {"error":"unavailable"}` (agents are treated as off). API keys on `/api/v1` are not affected either way.

The kill switch after an incident is therefore the dashboard switch (instant in the saving isolate, within 10 seconds elsewhere), or `MCP_ENABLED="0"` plus a deploy. The API & agents screen tells people that agent connections are off. A token request already in flight when the switch is turned off can still complete (seen in the live check); the next call is refused.

### Access mode

In app mode (`AUTH_MODE=app`, the default) nothing more is needed. With `AUTH_MODE=access`, Cloudflare Access sits in front of the dashboard host and would answer agents and scripts with a login page. Add an Access application with a **Bypass** policy for exactly these paths on the dashboard host, and nothing else:

- `/mcp`
- `/token`
- `/register`
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`)
- `/api/v1/*`

`/authorize` must stay behind Access: it is where the person signs in and approves. The bypassed paths are protected by OAuth tokens or API keys and the limits below.

### Allowed redirect URIs

`/register` (Dynamic Client Registration) accepts only these redirect URIs; any other is refused with `invalid_redirect_uri` and nothing is written to KV.

Exact addresses:

- `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback` (claude.ai and Claude Desktop)
- `https://chatgpt.com/connector_platform_oauth_redirect` (ChatGPT)
- `https://vertexaisearch.cloud.google.com/oauth-redirect` (Gemini Enterprise)
- `https://antigravity.google/oauth-callback` (Google Antigravity)

Loopback addresses for local clients: `http://localhost:<port>` or `http://127.0.0.1:<port>` (any port 1 to 65535) with the path exactly `/callback` (Claude Code), `/callback/<id>` where `<id>` is 1 to 64 letters, digits, `_` or `-` (Codex), or `/oauth/callback` (Gemini CLI). Nothing else is accepted on loopback: no `https`, no `[::1]`, no query, fragment, user info, trailing slash or extra path segments.

A refused registration logs one line, `redirect refused origin=<scheme://host[:port]> path=<path>` (at most 200 characters, never the query, the client name or any secret), so an unlisted client's callback shows up in Workers Logs and can be added to `src/oauth.ts`. Addresses the OAuth library rejects on its own (a fragment, user info, control characters or a bad port) are refused before that check and are not logged.

RFC 9207: the metadata `issuer` is `https://<dashboard host>` with `authorization_response_iss_parameter_supported: true`, and every authorization redirect (a code, `access_denied`, or an error such as a missing PKCE `S256` challenge) carries `iss=<issuer>` (the OAuth library's own RFC 9207 support, used as is). ChatGPT and Gemini CLI require it. Once the client and its redirect are known, errors go back to the client as a redirect; an unknown client or an unregistered redirect gets a local `400` page. PKCE with `S256` is required for every client. Client registrations are kept 30 days (`clientRegistrationTTL`).

### Tokens

- Access tokens last 24 hours. Every tool call still re-reads the connection and the person in D1, so a Disconnect, a lowered access or a disabled person applies on the next call, even with a valid token.
- Refresh tokens last 30 days and rotate on every use: the old one stops working as soon as the new one is issued.
- Every token exchange (code and refresh) re-reads the connection and the person in D1. A refresh for a disconnected connection or a disabled person is refused with `invalid_grant`, and the grant is then removed from KV.
- Disconnect writes D1 first, so the next tool call is refused at once, then removes the grant from KV. If that KV delete fails (for example at the daily cap), the next refresh is refused as above and the grant is removed then.

### KV budget

Workers KV Free allows 1,000 writes, 1,000 deletes and 1,000 lists per day for the whole account, shared with the redirect cache (`CACHE`, one write per cache miss). A separate namespace does not add any. Measured in the OAuth library:

| Event | KV writes | Deletes | Lists |
| --- | --- | --- | --- |
| Register a client (`/register`) | 1 | 0 | 0 |
| Connect: approval page, approve, code exchange | about 4 | 1 | 1 |
| Refresh (about once a day per agent in use, with 24 h tokens) | 2 | 0 | 0 |
| Disconnect | 0 | the grant and its tokens | 1 |
| Tool call | 0 (one read) | 0 | 0 |

A refused refresh also deletes the grant (deletes column). So 100 agents in daily use cost about 200 writes a day for refreshes.

**Bulk edits** spend KV deletes too (each changed link purges its cached redirect, and each forwarder a delete removes does too). They have their own counter, `bulk:kv`: **500 deletes per UTC day** for every bulk edit of the instance together (dashboard, API keys and MCP). That is half of the account's 1,000, so the rest stays for single edits and OAuth. Cost per link: schedule, redirect and password 1 each; delete 1 plus 1 for each forwarder it removes; a forward move 2, plus 1 for each older forwarder it repoints; a copy 1. So about 500 single-link changes, or about 250 forward moves, a day. A request that does not fit in what is left is refused whole with `429 kv_budget` and writes nothing. Single edits are not counted against it. On Workers Paid raise `LIMITS.bulkKvDay` in `src/limits.ts`.

D1 costs of the OAuth steps, on top of the limits below: each `/authorize` request (the approval page, then the approve or deny) reads 1 limiter row and writes 1; each token exchange (code or refresh) reads the connection and the person (1 read); approving the same client again writes 1 extra `UPDATE` to close the older connection. Domain lookups (`/api/v1/domains` and every MCP tool that resolves a domain) read only the person's domain memberships and the domains, never the links table. When the daily cap is reached, registering, connecting and refreshing fail with `503 {"error":"unavailable"}` until 00:00 UTC (agents drop off as their tokens expire), and redirect cache writes are skipped (redirects fall back to D1 reads). The limits below keep anonymous callers and loops from spending it.

### Limits

MCP tool calls (`/mcp`) and machine API requests (`/api/v1`) share the D1 limiter (table `auth_limits`, no paid features). Each request checks and charges all of its keys in one atomic D1 statement: either every key has room and all are charged, or nothing is written. Concurrent requests cannot overshoot a limit. Limits:

- 120 calls per minute per person (`api:u:`), 60 per minute per MCP connection (`api:c:`) or API key (`api:k:`).
- 1000 calls per UTC day per person (`api:ud:`).
- 3000 calls per UTC day for the whole instance, every person and agent together (`api:day`).
- `POST /register`: 5 per hour per IP range, /24 or /48 (`reg:`), and 50 per UTC day for the instance (`reg:day`); over it `429` with `Retry-After: 3600`. Someone who rotates IP ranges can use up the 50 and block new connections for the rest of the UTC day; existing connections keep working. This is the accepted trade for keeping anonymous registration from spending the KV budget.
- `/authorize`: 10 consent requests per hour per signed-in person (`authz:u:`), counting the approval page and the approve or deny, so a normal connect uses 2; over it the page answers `429`. If the limiter cannot be reached it answers `503`.

Bulk edits (`POST /api/v1/links/bulk`, the MCP tool `bulk_links` and the dashboard) change up to **50 distinct links per request** (`400 too_many` above that; a list of up to 100 ids is accepted before duplicates are dropped):

Why 50: every changed link needs one KV delete and KV has no multi-key delete, so CPU grows with the links changed; a live measurement on Workers Free put a 60-link bulk at 8 and 15 ms CPU against the 10 ms limit.

- The per-minute keys count a bulk request **once**.
- The daily caps (`api:ud:`, `api:day`) count **one unit per link processed**, for keys and MCP: refused links and ids that do not exist count, links returned in `pending` do not. The middleware already charged one unit, the route charges the rest. So 50 links use a twentieth of a person's daily cap. Over the cap the answer is `429 rate_limited`, and the middleware's unit is not refunded.
- `bulk:kv` (see [KV budget](#kv-budget)): 500 KV deletes per UTC day for every caller, `429 kv_budget` when a request does not fit.
- The daily units and `bulk:kv` are checked and charged in one atomic statement, so a request refused with `429 kv_budget` or `rate_limited` spends nothing beyond the one unit the middleware already charged, and concurrent requests cannot overshoot a cap. When both would refuse, `rate_limited` wins. Nothing is refunded afterwards: a later `409 conflict` keeps its charge.
- Over MCP the route's `429` reaches the agent as the tool error `rate_limited`, not as the "Daily limit reached" text.
- A request in which every link is refused reads rows but charges nothing on `bulk:kv`.

Over a limit the API answers `429 {"error":"rate_limited"}`; an MCP tool answers "Rate limited, try again in a minute." or, for the two daily caps, "Daily limit reached, try again tomorrow (UTC).".

D1 rows written, counted as under [Password-protected links](#password-protected-links) (a limiter key writes 2 rows per upsert, 3 when it is new in its window):

- An MCP tool call that runs: 4 limiter upserts (8 rows, up to 12) plus one `tool_calls` row (3 rows: the row and its two indexes), so about 11, up to 15. The hourly cron deletes each `tool_calls` row after 90 days, 3 more rows then. A tool that changes a link also writes the link row, its indexes and the audit row.
- A bulk edit writes about 3 to 8 rows per changed link (the link, its indexes, the audit row; a forward move adds the forwarder). Rows read per 100 links (a request now carries at most 50, so halve these per request): about 1,200 for a delete (about 3,000 when each link has one forwarder, within the 35 per link bound) and about 1,450 for a forward move, up to 35 per link with address reclaim and repoint (counted on the batched statements; the final re-read of the changed links and the limiter reads add roughly 100 to 200 more).
- An `/api/v1` request that runs: the same 4 limiter upserts (8, up to 12), plus 1 for `last_used_at` at most once a minute per key, plus the link and audit writes of a change.
- A refused call writes nothing: a disconnected agent, a disabled person, or a call over a limit. Only the first refused MCP call in a window is counted and logged once (about 5 rows), so a client that keeps retrying costs no writes.

Against the Free plan's 100,000 rows written per day for the whole account: one person at the 1000-call cap spends about 14,000 rows a day (counting the later prune), and the instance cap of 3000 calls about 42,000. That leaves room for sign-in, link edits, password unlocks and the rollup, but not much: a busy instance with several active agents reaches the instance cap first, and then agents and scripts stop until 00:00 UTC while the dashboard keeps working. The caps are constants in `src/limits.ts` (`apiDay`, `apiInstanceDay`); lower them if the account runs other Workers that write to D1.

### Deviations from the MCP standard

- **Refresh replay does not revoke the grant.** A replayed old refresh token is refused, but the connection stays valid (OAuth library behaviour). Disconnect it in the dashboard if a refresh token may have leaked.
- **`/mcp` accepts only OAuth access tokens, not API keys.** Keys work only on `/api/v1`.
- **Rights come from the connection, not the token scopes.** Every call reads the connection's access from D1 (which the dashboard can change at any time); the scopes in the token are not used to cap it further.
- **No IP allowlist.** Claude Code, Codex, Gemini CLI and scripts call from people's own machines, so a WAF rule limited to one vendor's IP ranges would break them. Protection is OAuth with sign-in on `/authorize`, hashed API keys, and the limits above.

## Behaviour to know

- **Forwarders.** Moving a link to another domain with "forward" leaves its old address as a forwarder: a `302` to the new short link, one hop only (the query string is passed through unchanged, `POST` answers `405`, no click is recorded). A forwarder is never edited, only deleted. A QR scan of the old address is counted once, on the new link, under the link's current domain. Deleting the moved link (one at a time, in bulk, over the API or MCP) also deletes its forwarders in the same batch, clears their cache entries and locks their old slugs, with one `link.delete` audit row per forwarder (`forwarderOf` names the link); each forwarder removed by a bulk delete costs 1 KV delete, so an old printed QR code ends on the not-found page and never lands on an unrelated link. Moving a link back to a domain where its own forwarder sits reclaims that address. A forward move costs 2 KV deletes plus 1 per older forwarder (see [KV budget](#kv-budget)).
- **Move.** The target domain must be active (`400 target_not_active`); the person (or key) must be allowed to use it. A move needs an explicit choice for the old address, `forward` or `copy`; a copy makes an independent link on the target and leaves the original. Clicks recorded before a move stay under the old domain in domain-filtered analytics; the per-link chart follows the link.
- **Who can delete a forwarder.** A forwarder is created by whoever moved the link, so when a manager or the owner moves a member's link, only they (and the owner) can delete the old address, not the member.
- **A very busy link.** A link with about 498 or more forwarders cannot be forward-moved again, because one move would need more KV deletes than the daily budget; copy it instead.
- **Bulk delete is stricter than a single delete.** A link edited by someone else between loading and deleting comes back as `conflict` for that link and is not deleted.
- **Double submit.** Two identical forward moves of the same link in the same second: the second request is rolled back whole with `409 conflict` and writes nothing.

- Turning a domain case-sensitive changes which URLs match: `/Spring` and `/spring` become different links. Existing links keep their exact slug as the key. Turning it back off is refused while case twins conflict.
- Cache staleness: redirects are cached in KV for up to about 5 minutes. After an edit or delete the old destination can still be served for that long in rare races, and KV deletes take up to about 60 seconds to propagate across locations.
- Known limit: a redirect that read the database just before an edit can re-fill the cache with the old row; the old destination can then be served for up to 5 minutes. Cloudflare KV is eventually consistent (about 60 s), so a versioned-key scheme would narrow but not remove this window.
- Instance logo: PNG, WebP or JPEG only, square, at most 1024 px and 64 KiB; the file's bytes decide its type, whatever the browser calls it. SVG is refused (`400 logo_type`): its script and external-load surface cannot be filtered safely. The logo is served from the dashboard host only, shown through `<img>`, with a `sandbox` CSP and `nosniff`, and cached privately for up to 5 minutes (`max-age=300`). After an upload or removal the old image can show for up to about 5 minutes, longer on a browser that already cached it. Each upload or removal spends one KV write from the daily budget.
- Concurrent edits: a `PATCH` writes only the fields it sends, and only if the link has not changed since the request read it. A losing request gets `409 {"error":"conflict"}`; reload the link and retry.
- The API only accepts JSON bodies and only from the dashboard origin (CSRF guard). Scripts that call it should send `Content-Type: application/json`. Calls without a body that change something (for example `DELETE`) must also send `Origin: https://<dashboard host>`, or the CSRF guard refuses them with 403. A dashboard served from `http://localhost` during local development is refused the same way. Scripts should use `/api/v1` with a personal API key instead, which needs no `Origin` (see [agents.md](agents.md)).
