# Local development

The dashboard is a React app in `web/`, built by Vite into `web/dist`, which the Worker serves on the dashboard host. In development, Vite serves the app and proxies `/api` to a local Worker.

## Tests and checks

```sh
npm test           # Worker tests (Workers pool), then web tests (jsdom, web/vitest.config.ts)
npm run typecheck  # Worker, scripts and web/
npm run build:web  # writes web/dist
```

## Running the dashboard against a local Worker

There is no development-only sign-in path. The local Worker checks a real Cloudflare Access token, exactly as in production, so nothing in the Worker can be switched into an unauthenticated mode.

You need an instance config (`wrangler.instance.jsonc`, see `docs/deploy.md`) with your real `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and `cloudflared` installed.

1. Create the local database (local D1 and KV live in `.wrangler/`, nothing remote is touched):

   ```sh
   npx wrangler d1 migrations apply <your database name> --local -c wrangler.instance.jsonc
   ```

2. Start the Worker with the dashboard host set to `localhost`. Set `OWNER_EMAIL` to the email you sign in to Access with, so your first call creates you as the owner:

   ```sh
   npx wrangler dev -c wrangler.instance.jsonc --local-upstream localhost \
     --var DASHBOARD_HOST:localhost --var OWNER_EMAIL:<your Access email>
   ```

   `--local-upstream localhost` matters when the instance config has `routes`: without it, `wrangler dev` presents requests as coming to the first route's host, and the Worker then treats every request as a short link.

3. In another terminal, get an Access token for your dashboard and start Vite:

   ```sh
   CF_ACCESS_TOKEN=$(cloudflared access token -app=https://<your dashboard host>) npm run dev:web
   ```

   Vite proxies `/api` to `http://localhost:8787` and adds two headers: `Cf-Access-Jwt-Assertion` with the token, and `Origin: https://localhost`, which the Worker's CSRF check expects for `DASHBOARD_HOST=localhost`. The token stays in the Vite dev server; it is never a `VITE_` variable, so it is never bundled into the app.

4. Open the URL Vite prints.

The token expires with your Access session. When the app shows "You are signed out", run `cloudflared access login https://<your dashboard host>` if needed, then restart step 3 to pick up a fresh token.
