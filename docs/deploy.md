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

`ACCESS_JWKS_JSON` is **test-only**. It replaces the real Access signing keys with a local key set. Never set it in production; the app logs a warning if it is set.

`workers_dev` is `false` in the example config so the Worker is reachable only through your routes.

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

Secret: `CF_API_TOKEN`, set only with `npx wrangler secret put CF_API_TOKEN -c wrangler.instance.jsonc` (never in `vars`). Cloudflare features are on only when the token, `CF_ACCOUNT_ID` and `CF_WORKER_NAME` are all set; outside domains also need `CF_SAAS_ZONE_ID` and `CF_CNAME_TARGET`. The token is never shown again, never stored in D1 or KV and never written to logs or the audit log.

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

## Sign-in

`AUTH_MODE` picks one of two sign-in modes. They never mix: app mode ignores Access tokens, and access mode ignores linkwarren session cookies. Unset or blank means `app`. The value is trimmed and must then be exactly `app` or `access` (lowercase); any other value fails closed: the dashboard API and `/auth/*` answer `500 {"error":"misconfigured"}`, while short links keep redirecting.

### App mode (default)

linkwarren signs people in itself, with an email link or a passkey. No Access application is needed.

- Set the var `EMAIL_FROM` (e.g. `links@example.com`) and the secret `RESEND_API_KEY`. Without both, `POST /auth/email` answers `503 {"error":"email_not_configured"}`.
- `/healthz` is public on the dashboard host; no bypass is needed.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not used.

#### Email sign-in links (Resend)

Sign-in links are sent through [Resend](https://resend.com) only.

1. Add and verify your sending domain in Resend (the domain of `EMAIL_FROM`).
2. In the domain's settings, turn **click tracking and open tracking off**. Click tracking would route the sign-in link through a third-party redirect, and open tracking adds an image.
3. Create an API key with **sending access only**, restricted to that domain.
4. Store it as a secret: `npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc`. Never put it in `vars`.
5. Set the var `EMAIL_FROM`, e.g. `links@example.com`.

How the link works: a person enters their email, and if it can sign in here (an active or invited person, or `OWNER_EMAIL` while there are no users yet) they get a link to `https://<dashboard host>/sign-in#token=...`. The token is in the URL fragment, so it never reaches server logs or a `Referer`. It works once and expires after 15 minutes. The answer is always the same `202`, whether or not a mail goes out, so the form never tells which addresses have accounts.

Limits (all in D1, no paid features): 5 requests per address and 20 per IP range (/24 or /48) every 15 minutes, 20 failed link checks per IP range every 15 minutes, and at most 50 sign-in emails per hour for the whole instance. The Resend free tier sends 100 emails a day; the hourly cap keeps a flood of requests for known addresses from spending it. At the cap the request still gets the normal answer, no mail is sent, and the Worker logs `email_cap`. Resend errors are logged as `resend_rejected <status>` or `resend_network`, never with the message.

### Access mode

Set `AUTH_MODE` to `access`. Cloudflare Access signs people in, exactly as before this mode switch; `/auth/*` and `/api/account/*` answer 404.

Create a Cloudflare Access application on the dashboard host only. Short domains must stay public. Take its audience tag for `ACCESS_AUD`, and set `ACCESS_TEAM_DOMAIN`.

Health checks: `/healthz` sits behind Access on the dashboard host. Add an Access bypass policy for the path `/healthz`, or give the monitor a service token, otherwise the check gets a login redirect.

### Upgrading an existing instance

Instances deployed before the sign-in modes used Access. The default is now app mode, so an upgrade without a setting switches the dashboard to app mode and ignores the Access token.

1. **Keep Access:** set `AUTH_MODE` to `access` before deploying this version. Nothing else changes.
2. **Move to app mode later**, as its own step: set `EMAIL_FROM` and `RESEND_API_KEY`, apply the migrations, then set `AUTH_MODE` to `app` (or remove the `access` value; unset also means `app`) and deploy. Check that you can sign in, and only then remove the Access application.

## Behaviour to know

- Turning a domain case-sensitive changes which URLs match: `/Spring` and `/spring` become different links. Existing links keep their exact slug as the key. Turning it back off is refused while case twins conflict.
- Cache staleness: redirects are cached in KV for up to about 5 minutes. After an edit or delete the old destination can still be served for that long in rare races, and KV deletes take up to about 60 seconds to propagate across locations.
- Known limit: a redirect that read the database just before an edit can re-fill the cache with the old row; the old destination can then be served for up to 5 minutes. Cloudflare KV is eventually consistent (about 60 s), so a versioned-key scheme would narrow but not remove this window.
- Concurrent edits: a `PATCH` writes only the fields it sends, and only if the link has not changed since the request read it. A losing request gets `409 {"error":"conflict"}`; reload the link and retry.
- The API only accepts JSON bodies and only from the dashboard origin (CSRF guard). Scripts that call it should send `Content-Type: application/json`. Calls without a body that change something (for example `DELETE`) must also send `Origin: https://<dashboard host>`, or the CSRF guard refuses them with 403. A dashboard served from `http://localhost` during local development is refused the same way.
