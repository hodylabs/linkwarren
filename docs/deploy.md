# Deploying linkwarren

linkwarren runs as one Cloudflare Worker with a D1 database and a KV namespace. These steps are generic; use your own names and ids.

## Configuration

Copy `wrangler.instance.example.jsonc` to `wrangler.instance.jsonc` (gitignored) and fill it in. **Always deploy with `-c wrangler.instance.jsonc`**; the default `wrangler.jsonc` carries no instance values and must not be deployed.

Required vars:

- `DASHBOARD_HOST`: the hostname that serves the dashboard and API. If it is missing or blank, every request answers `500 {"error":"misconfigured"}`.
- `ACCESS_TEAM_DOMAIN`: your Cloudflare Access team domain, e.g. `your-team.cloudflareaccess.com`.
- `ACCESS_AUD`: the audience tag of the Access application that protects the dashboard host.

Required secret:

- `OWNER_EMAIL`: the email that becomes the owner on first sign-in. Only that email can bootstrap, and only while the users table is empty.

Set `OWNER_EMAIL` only with `wrangler secret put OWNER_EMAIL -c wrangler.instance.jsonc`. Do not add it to `vars`: a var with the same name replaces the secret on the next deploy.

`ACCESS_JWKS_JSON` is **test-only**. It replaces the real Access signing keys with a local key set. Never set it in production; the app logs a warning if it is set.

`workers_dev` is `false` in the example config so the Worker is reachable only through your routes.

## Local development

`npm run dev` runs `wrangler dev -c wrangler.instance.jsonc`, so it needs the instance config:

1. Copy `wrangler.instance.example.jsonc` to `wrangler.instance.jsonc` if you have not already.
2. Set `DASHBOARD_HOST` to the host you open locally, for example `localhost` (the port is ignored).
3. Put `OWNER_EMAIL=you@example.com` in `.dev.vars` (gitignored); local dev reads secrets from there.
4. Apply migrations to the local database: `wrangler d1 migrations apply linkwarren --local -c wrangler.instance.jsonc`.

Without the instance config `npm run dev` fails to start, and a Worker run without `DASHBOARD_HOST` answers every request with `500 {"error":"misconfigured"}`.

## Steps

1. Create the D1 database and the KV namespace (`wrangler d1 create`, `wrangler kv namespace create`) and put their ids in `wrangler.instance.jsonc`.
2. Apply migrations to the remote database: `wrangler d1 migrations apply linkwarren --remote -c wrangler.instance.jsonc`.
3. Deploy: `wrangler deploy -c wrangler.instance.jsonc`.
4. Add one route per short domain plus the dashboard host (custom domains in the config).

## Access

Create a Cloudflare Access application on the dashboard host only. Short domains must stay public. Take its audience tag for `ACCESS_AUD`.

Health checks: `/healthz` sits behind Access on the dashboard host. Add an Access bypass policy for the path `/healthz`, or give the monitor a service token, otherwise the check gets a login redirect.

## Behaviour to know

- Turning a domain case-sensitive changes which URLs match: `/Spring` and `/spring` become different links. Existing links keep their exact slug as the key. Turning it back off is refused while case twins conflict.
- Cache staleness: redirects are cached in KV for up to about 5 minutes. After an edit or delete the old destination can still be served for that long in rare races, and KV deletes take up to about 60 seconds to propagate across locations.
- Known limit: a redirect that read the database just before an edit can re-fill the cache with the old row; the old destination can then be served for up to 5 minutes. Cloudflare KV is eventually consistent (about 60 s), so a versioned-key scheme would narrow but not remove this window.
- Concurrent edits: a `PATCH` writes only the fields it sends, and only if the link has not changed since the request read it. A losing request gets `409 {"error":"conflict"}`; reload the link and retry.
- The API only accepts JSON bodies and only from the dashboard origin (CSRF guard). Scripts that call it should send `Content-Type: application/json`. Calls without a body that change something (for example `DELETE`) must also send `Origin: https://<dashboard host>`, or the CSRF guard refuses them with 403. A dashboard served from `http://localhost` during local development is refused the same way.
