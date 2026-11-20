# Deploying linkwarren

linkwarren runs as one Cloudflare Worker with a D1 database and a KV namespace. These steps are generic; use your own names and ids.

## Configuration

Copy `wrangler.instance.example.jsonc` to `wrangler.instance.jsonc` (gitignored) and fill it in. **Always deploy with `-c wrangler.instance.jsonc`**; the default `wrangler.jsonc` carries no instance values and must not be deployed.

Required vars:

- `DASHBOARD_HOST`: the hostname that serves the dashboard and API. If it is missing or blank, every request answers `500 {"error":"misconfigured"}`.
- `ACCESS_TEAM_DOMAIN`: your Cloudflare Access team domain, e.g. `your-team.cloudflareaccess.com`.
- `ACCESS_AUD`: the audience tag of the Access application that protects the dashboard host.

Required secret (set it with `wrangler secret put OWNER_EMAIL -c wrangler.instance.jsonc`, not in a committed file):

- `OWNER_EMAIL`: the email that becomes the owner on first sign-in. Only that email can bootstrap, and only while the users table is empty.

`ACCESS_JWKS_JSON` is **test-only**. It replaces the real Access signing keys with a local key set. Never set it in production; the app logs a warning if it is set.

`workers_dev` is `false` in the example config so the Worker is reachable only through your routes.

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
- The API only accepts JSON bodies and only from the dashboard origin (CSRF guard). Scripts that call it should send `Content-Type: application/json`.
