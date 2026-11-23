---
title: Local development
description: Tests, the dashboard build, running the dashboard against a local Worker, and the docs site.
slug: docs/development
---

# Local development

The dashboard is a React app in `web/`, built by Vite into `web/dist`, which the Worker serves on the dashboard host. In development, Vite serves the app and proxies `/api` to a local Worker.

One build serves both dashboard modes. Vite builds with a relative base (`base: "./"`), and the Worker rewrites the app shell when it serves it: every `./` URL becomes rooted at the dashboard path (`/` in host mode, for example `/dashboard/` in path mode) and a `<meta name="lw-base">` tells the app its path (`web/src/base.ts`). In app code, build dashboard URLs with `withBase`, `navigate`, `NavLink` or `api()`, never as a bare `"/..."` string; `web/src/no-absolute-paths.test.ts` fails on one. Local development stays in host mode: the Vite dev server serves the app at `/` with no base meta, so leave `DASHBOARD_PATH` unset for the local Worker.

## Tests and checks

```sh
npm test           # Worker tests (Workers pool), then web tests (jsdom, web/vitest.config.ts)
npm run typecheck  # Worker, scripts and web/
npm run build:web  # writes web/dist, then runs check:web
```

`check:web` fails the build if anything in `web/dist` contains `data:font`. The dashboard CSP allows fonts and images only from the same origin, so an inlined font would be blocked; `web/vite.config.ts` sets `assetsInlineLimit: 0` so Vite never inlines assets.

## The docs site

linkwarren.dev is an Astro Starlight site in `site/`, with its own `package.json`. It reads the docs straight from `docs/*.md` (one source, edited in the same pull request as the code), so a doc needs frontmatter with `title`, `description` and `slug: docs/<file name>`, and links between docs stay relative (`[domains.md](domains.md)`), which works on GitHub and on the site. To run it locally:

```sh
cd site && npm ci && npm run dev
```

`npm run build` writes the static site to `site/dist` and fails on a broken internal link. A GitHub Actions workflow (`.github/workflows/pages.yml`) builds and publishes it to GitHub Pages on every push to `main` that changes `site/` or `docs/`.

## Running the dashboard against a local Worker

There is no development-only sign-in path. The local Worker checks a real Cloudflare Access token, exactly as in production, so nothing in the Worker can be switched into an unauthenticated mode.

You need an instance config (`wrangler.instance.jsonc`, see `docs/deploy.md`) with your real `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and `cloudflared` installed.

1. Create the local database (local D1 and KV live in `.wrangler/`, nothing remote is touched):

   ```sh
   npx wrangler d1 migrations apply <your database name> --local -c wrangler.instance.jsonc
   ```

2. Build the dashboard once. The instance config's `assets` block points at `web/dist`, and `wrangler dev` will not start while that directory is missing (Vite serves the app you work on; the Worker only needs the folder to exist):

   ```sh
   npm run build:web
   ```

3. Start the Worker with the dashboard host set to `localhost`. Set `OWNER_EMAIL` to the email you sign in to Access with, so your first call creates you as the owner:

   ```sh
   npx wrangler dev -c wrangler.instance.jsonc --local-upstream localhost \
     --var DASHBOARD_HOST:localhost --var OWNER_EMAIL:<your Access email> --var AUTH_MODE:access
   ```

   This flow signs in with Access, so it runs the Worker in access mode (`AUTH_MODE=access`); the default app mode ignores the Access token.

   `--local-upstream localhost` matters when the instance config has `routes`: without it, `wrangler dev` presents requests as coming to the first route's host, and the Worker then treats every request as a short link.

4. In another terminal, get an Access token for your dashboard and start Vite:

   ```sh
   CF_ACCESS_TOKEN=$(cloudflared access token -app=https://<your dashboard host>) npm run dev:web
   ```

   Vite proxies `/api` to `http://localhost:8787` and adds `Cf-Access-Jwt-Assertion` with the token. It also rewrites `Origin` to `https://localhost`, which the Worker's CSRF check expects for `DASHBOARD_HOST=localhost`, but only when the request's `Origin` is the Vite dev page itself (`http://<the host Vite serves on>`). A request from any other site keeps its own `Origin`, so the CSRF check still refuses cross-site writes while you develop. The token stays in the Vite dev server; it is never a `VITE_` variable, so it is never bundled into the app.

5. Open the URL Vite prints.

The token expires with your Access session. When the app shows "You are signed out", run `cloudflared access login https://<your dashboard host>` if needed, then restart step 4 to pick up a fresh token.
