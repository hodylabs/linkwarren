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
  - Write budget: a run writes at most 10,000 D1 rows and the rollup at most 40,000 per UTC day (kept in `analytics_state` as `rollup_writes`). A day costs 3 writes per row it inserts (the row and its two indexes), 3 per row it replaces, and 4 for the state rows, counted before it is sent. The run stops before a day that would go over and logs `analytics rollup paused day=<day> writes=<n>`; the next hour continues.
  - A day is written whole or not at all. If an Analytics Engine answer would be over 2,000 rows (`ae_truncated`) or the day alone needs more than 10,000 writes (about 3,300 rollup rows: one per link clicked that day, plus one per link and country, device or referrer), the rollup stops at that day and logs it every hour; reports still read that day live while Analytics Engine has it. Such an instance needs a bigger plan than this job assumes.
- **Audit purge (00:15 UTC run only).** Audit rows older than 3 years (1096 days) are deleted, at most 5000 per run, oldest first (the next day continues), and the deletion itself is written to the audit log as `audit.purge` by the actor `system`.

Logs show `analytics rollup: <days>` and `audit purge: <count>`; errors are logged by name (a failed rollup also logs the failing day and the safe `ae_<code>`, never the token or a response body). To run the job locally:

```sh
npx wrangler dev --test-scheduled -c wrangler.instance.jsonc
curl "http://localhost:8787/__scheduled?cron=15+*+*+*+*"
```

To re-roll days (for example after a fix), set the mark back, e.g. `UPDATE analytics_state SET v = '2026-11-17' WHERE k = 'rolled_through'`; the next runs rewrite the days after it that Analytics Engine still holds, 3 per hour. A re-roll costs D1 writes on the Free plan: about 6 per rollup row of each day (3 to delete the old row, 3 to insert the new one), inside the same write budgets, so moving the mark far back takes several hours or days to catch up.

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

## Password-protected links

A link with a password answers its short URL with a small form page instead of a redirect. The form posts back to the same URL (query included); a right password answers `303` to the destination (routes and query pass-through apply, the QR marker is stripped), with `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. A wrong one shows the form again with a generic message (`401`). There is no unlock cookie: every visit asks again, and short hosts never set cookies. The unlock POST must carry `Origin: https://<short host>` and a form body of at most 2048 bytes (enough for 128 characters of any script), else `403`, `415`, `411` or `413`. Showing the form records no click; a right unlock records one.

Limits (D1, the same table as sign-in, global across Cloudflare locations, no paid features), all checked before any hashing work:

- 5 unlock attempts per link per IP range (/24 or /48) every 15 minutes. Each attempt reserves a slot with one atomic upsert before the password is checked, so parallel guesses cannot slip past it; a right password gives its slot back, so people behind one office network can all open the link.
- 30 right unlocks per link per IP range every 15 minutes (key `unlockok:`). It is read before any write, so a script that loops one known password stops costing writes and hashing after 30. Parallel bursts can pass it by a few, because the count is written after the password check.
- 20 wrong passwords per IP range every 15 minutes, across all links.

Past a limit the form answers `429` with `Retry-After: 900`. If D1 cannot be reached the form answers `503` ("Password check is unavailable right now.") and no password is checked. A guesser with many IP ranges gets more tries, so use long passwords for sensitive links. Someone on the same IP range (a shared or carrier NAT) can lock that range out for 15 minutes with wrong tries; a visitor who gets "Too many tries" on the first try is usually seeing that.

D1 writes, counted the way the hourly rollup counts them (`src/cron.ts`) and measured with the local D1: a limiter key seen for the first time in its window writes 3 rows (the row, its primary-key index and the `window_start` index); an upsert of an existing key writes 2, and the refund 1.

- A right unlock writes about 5 rows (reserve, refund, right-unlock count), or 7 when the range is new to the link.
- A wrong one writes about 4 (reserve, failure count), or 6 when new.
- A POST from a range that is already limited writes none.
- Per range in 15 minutes: at most about 30 x 5 = 150 rows per link for right unlocks, and about 20 x 4 = 80 (up to 120 with new keys) for wrong ones across all links.

The Free plan allows 100,000 D1 rows written per day for the whole account. N unlocks a day spend about 5N to 7N of that, so about 15,000 to 20,000 right unlocks a day (a password printed on a flyer, from many ranges) use the whole quota. When it is gone, D1 refuses writes: every protected link answers `503`, and sign-in, link edits and the hourly rollup fail too. For any protected link with real traffic, add a Cloudflare WAF rate limiting rule for `POST` on your short hosts, per IP, with a low threshold (the Free plan includes one rate limiting rule; check which periods your plan offers). It stops floods at the edge, before they cost Worker CPU or D1 writes; the Origin check does not, because Origin is easy to forge outside a browser. Expired limiter rows are deleted by the hourly cron, up to 2000 rows per table per run, inside its write budget.

HTTPS: a protected link is only served over HTTPS. A plain-HTTP GET or HEAD answers `308` to the same URL on `https:`, a plain-HTTP POST is refused (`403`), and the form and unlock answers carry `Strict-Transport-Security: max-age=31536000`. Turn on **Always Use HTTPS** (SSL/TLS, Edge Certificates) on every short-link zone as well, so unprotected links are upgraded too.

Hashing: PBKDF2-SHA256 with the iteration count from the optional var `PASSWORD_HASH_ITERATIONS` (integer, clamped to 1000..100000; unset uses the built-in default of 10000). The count is stored in each hash, so changing the var only affects passwords set afterwards; existing links keep working. One unlock attempt costs one PBKDF2 run. Measured live on Workers Free, 25000 iterations took 10 to 18 ms of CPU per unlock, over the Free plan's 10 ms per request. At 10000 an unlock usually takes 3 to 9 ms; a cold start measured about 14 ms, which the Free plan's burst allowance absorbed in testing. On the Free plan keep 10000; on Workers Paid you may raise it up to 100000. 10000 iterations is far below current guidance against offline cracking: if the D1 or KV contents ever leak, short passwords fall quickly, so use long ones.

Caching: a browser that once got a `301` for a link keeps going straight to the old destination. A link that was `301` and now has a password can therefore still be skipped by those browsers (they already knew the destination), and a `301` link with routes sends returning visitors to the destination they got first, even after they travel or the routes change. Use `302` for links with routes.

## Behaviour to know

- Turning a domain case-sensitive changes which URLs match: `/Spring` and `/spring` become different links. Existing links keep their exact slug as the key. Turning it back off is refused while case twins conflict.
- Cache staleness: redirects are cached in KV for up to about 5 minutes. After an edit or delete the old destination can still be served for that long in rare races, and KV deletes take up to about 60 seconds to propagate across locations.
- Known limit: a redirect that read the database just before an edit can re-fill the cache with the old row; the old destination can then be served for up to 5 minutes. Cloudflare KV is eventually consistent (about 60 s), so a versioned-key scheme would narrow but not remove this window.
- Concurrent edits: a `PATCH` writes only the fields it sends, and only if the link has not changed since the request read it. A losing request gets `409 {"error":"conflict"}`; reload the link and retry.
- The API only accepts JSON bodies and only from the dashboard origin (CSRF guard). Scripts that call it should send `Content-Type: application/json`. Calls without a body that change something (for example `DELETE`) must also send `Origin: https://<dashboard host>`, or the CSRF guard refuses them with 403. A dashboard served from `http://localhost` during local development is refused the same way.
