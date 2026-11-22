# Backups and export

linkwarren keeps everything in one D1 database (plus the logo in KV). There are two ways to keep a copy: D1 Time Travel for restores, and the full JSON export for a portable copy you hold yourself.

## D1 Time Travel (restore)

Cloudflare D1 keeps 30 days of point-in-time history on every plan, including Free. To restore the whole database to an earlier moment:

1. Find the time or bookmark: `npx wrangler d1 time-travel info linkwarren --timestamp=2026-01-31T12:00:00Z -c wrangler.instance.jsonc`.
2. Restore: `npx wrangler d1 time-travel restore linkwarren --timestamp=2026-01-31T12:00:00Z -c wrangler.instance.jsonc` (or `--bookmark=<bookmark>`).

A restore replaces the whole database, including links, people, sessions and the audit log, and it is itself undoable for 30 days (the command prints the bookmark to go back to). Use your own database name if it is not `linkwarren`. Redirects served from the KV cache can show the old answer for up to their cache lifetime after a restore.

## Full JSON export

The owner downloads it in Settings, Backups and export, "Download full export". The browser asks the server for one table page at a time (500 rows per request, a few D1 queries each), so the export fits the Workers Free limit of 50 D1 queries per request however large the instance is. The first request writes one `export.run` row to the audit log. Each page request checks again that you are signed in as an owner. The file is named `linkwarren-export-<YYYY-MM-DD>.json`.

Shape:

```json
{
  "format": "linkwarren-export",
  "version": 1,
  "exportedAt": 1767225600,
  "logo": { "type": "image/png", "data": "<base64>" },
  "tables": { "users": [ ... ], "links": [ ... ], ... },
  "complete": true
}
```

`complete` is the last key. A file without it was cut off and is not a valid export. `logo` is `null` without a custom logo. Rows keep the database column names and values (timestamps in Unix seconds, JSON columns such as `links.routes` as their stored text).

### What it holds

`users`, `domains`, `domain_cf`, `domain_members`, `links` (with `routes` and `forward_to`), `slug_locks`, `audit_log`, `settings`, `clicks_daily`, `clicks_daily_dim`, `api_keys` (name, prefix, permissions, domains and dates only), `agent_connections`, `tool_calls`.

### What it leaves out

- Link passwords: a protected link has `"protected": true` and no password hash. After a restore from the export its password must be set again.
- API key secrets and hashes: keys in the file cannot be used. Create new keys after a restore.
- Secrets pasted in the dashboard (the `secret.*` settings rows, stored encrypted) and the Worker secrets.
- Sign-in data: sessions, sign-in links, passkeys, sign-in challenges and rate-limit counters.
- Internal state: locks and the analytics rollup mark.
- OAuth grants and tokens of agent connections (they live in KV, not D1).
- Raw clicks still in Analytics Engine that are not yet rolled into the daily totals.

### Restoring from an export

Not in this version. The export is a readable copy for safekeeping and for moving your data elsewhere; to undo a mistake on the same instance, use D1 Time Travel.
