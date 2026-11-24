---
title: Updating
description: Moving an instance to a new linkwarren release, and how the in-app update notice works.
slug: docs/updating
---

# Updating

linkwarren never updates itself. New versions are tagged releases on GitHub, and you deploy one when you choose.

## The update notice

Once a day, in the 00:15 UTC run of the scheduled job, the instance asks GitHub for the latest release (`GET https://api.github.com/repos/hodylabs/linkwarren/releases/latest`). It sends no instance name, address, email or token; what GitHub can still see is in [privacy.md](privacy.md#update-check).

- When the latest release is newer than the running version, owners and people with the Settings permission see "vX.Y.Z available" next to the version in the sidebar, linking to the release notes. Nobody else sees it.
- Only plain `x.y.z` releases count. Drafts and pre-releases are ignored.
- A failed check keeps the last answer and logs a short code (for example `update_network` or `update_http_403`); it never affects anything else.
- To stop the check, switch off **Check for updates** in Settings, This instance. The daily request stops and the notice is hidden.

The check needs the Cron Trigger from the example config (`"triggers": { "crons": ["15 * * * *"] }`).

## Moving to a new release

Run these from your clone of the repository, with your `wrangler.instance.jsonc` in place. Use your own database name if it is not `linkwarren`.

### 1. Read the release notes

Open the release on the [releases page](https://github.com/hodylabs/linkwarren/releases). The notes say what changed, whether there are new migrations, and anything to do before or after the deploy (for example a new binding or variable). Releases that need extra steps also have a section in [deploy.md](deploy.md).

### 2. Fetch the tag

```sh
git fetch --tags
git checkout v0.8.0   # the release you are moving to
npm ci
```

Your `wrangler.instance.jsonc` is gitignored, so checking out a tag never touches it. Compare it with the new `wrangler.instance.example.jsonc` for new settings:

```sh
git diff <old tag> <new tag> -- wrangler.instance.example.jsonc
```

### 3. Apply the D1 migrations

Apply new migrations **before** deploying the Worker: the new Worker may read tables, columns or indexes they add. This is the safe order; the migration notes in [deploy.md](deploy.md) say when a release needs it.

```sh
npx wrangler d1 migrations list linkwarren --remote -c wrangler.instance.jsonc
npx wrangler d1 migrations apply linkwarren --remote -c wrangler.instance.jsonc
```

`list` shows which migrations are not applied yet; `apply` applies them in order and does nothing when there are none. Some migrations rewrite whole tables and use a share of the Free plan's 100,000 D1 rows written per day; the release notes and [deploy.md](deploy.md) say when, and to apply them early in the UTC day.

If something goes wrong, [D1 Time Travel](backup.md#d1-time-travel-restore) can put the database back to a moment before the migration.

### 4. Build and deploy

```sh
npm run build:web
npx wrangler deploy -c wrangler.instance.jsonc
```

### 5. Check it

```sh
curl -s https://dash.example.com/healthz        # {"ok":true}
curl -sI https://go.example.com/<a slug>        # 301 or 302 to its destination
```

With the dashboard at a path, the health check is `https://example.com/dashboard/healthz`. Then open the dashboard: the version in the sidebar shows the new release, and the update notice is gone.

## Going back

To go back to an earlier release, check out its tag and deploy it the same way. Migrations stay applied: D1 has no automatic down-migrations. If a release notes that its migration cannot run with older Workers, restore the database with [D1 Time Travel](backup.md#d1-time-travel-restore) to a moment before the migration (this also undoes every change made since).
