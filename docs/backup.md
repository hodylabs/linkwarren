---
title: Backups and export
description: D1 Time Travel for restores, and the full JSON export for a copy you keep.
slug: docs/backup
---

# Backups and export

linkwarren keeps everything in one D1 database (plus the logo in KV). There are two ways to keep a copy: D1 Time Travel for restores, and the full JSON export for a portable copy you hold yourself.

## D1 Time Travel (restore)

Cloudflare D1 keeps point-in-time history for 7 days on the Workers Free plan and 30 days on Workers Paid (see Cloudflare's D1 limits). For anything older, keep a full JSON export. To restore the whole database to an earlier moment:

1. Find the time or bookmark: `npx wrangler d1 time-travel info linkwarren --timestamp=2026-01-31T12:00:00Z -c wrangler.instance.jsonc`.
2. Restore: `npx wrangler d1 time-travel restore linkwarren --timestamp=2026-01-31T12:00:00Z -c wrangler.instance.jsonc` (or `--bookmark=<bookmark>`).

A restore replaces the whole database, including links, people, sessions and the audit log, and it is itself undoable within the same window, 7 days on Free and 30 on Paid (the command prints the bookmark to go back to). Use your own database name if it is not `linkwarren`. Redirects served from the KV cache can show the old answer for up to their cache lifetime after a restore.

## Full JSON export

An owner, or anyone whose role has the `data` permission (export and import), downloads it in Settings, Backups and export, "Download full export". The browser asks the server for one table page at a time (up to 500 rows, and at most about 1 MB of JSON, per request, a few D1 queries each), so each request fits the Workers Free limits of 50 D1 queries and 10 ms CPU however large the instance is. The first request writes one `export.run` row to the audit log (the tables, whether analytics were included and the estimated reads) and returns a run id that the page requests must carry; it is valid for 6 hours and only for the person who started it. Each page request checks again that you still have the `data` permission. The export is always the whole instance (every person, link and domain), whatever the role's other permissions, with one exception: the `audit_log` table is in it only when you may read the audit log (owners, or a role with the `audit` permission); otherwise it is left out of `tables` and its page request answers `403`. The file is named `linkwarren-export-<YYYY-MM-DD>.json`.

**Read cost.** Each exported row is one D1 row read, and the Free plan allows 5,000,000 row reads per day for the whole account. A run that uses them up makes D1 refuse reads until 00:00 UTC, which stops redirects that are not cached and the dashboard. Before reading any page the dashboard shows the estimated reads and their share of the daily budget, and asks you to confirm above 1,000,000. The daily click totals (`clicks_daily`, `clicks_daily_dim`) are kept forever and are usually the largest tables, so they are left out unless you tick "Include analytics"; include them only when you need them, ideally soon after the UTC reset.

**Not a snapshot.** The export reads table by table while the instance keeps running. A row created, changed or deleted during the run can be missing or appear twice (for example the hourly job rewrites a day of click totals, or a new link shows up in the audit log but not in `links`). For a point-in-time copy use D1 Time Travel.

Shape:

```json
{
  "format": "linkwarren-export",
  "version": 1,
  "exportedAt": 1767225600,
  "includeAnalytics": false,
  "logo": { "type": "image/png", "data": "<base64>" },
  "tables": { "users": [ ... ], "links": [ ... ], ... },
  "complete": true
}
```

`complete` is the last key. A file without it was cut off and is not a valid export. Without analytics the two click tables are absent from `tables`. `logo` is `null` without a custom logo. Rows keep the database column names and values (timestamps in Unix seconds, JSON columns such as `links.routes` as their stored text).

### What it holds

`roles` (custom and built-in roles with their permissions), `users` (with `role_id`, the custom role of a member, or empty), `domains`, `domain_cf`, `domain_members`, `links` (with `routes`, `forward_to` and `kind`), `vcards` (the contact card of each `vcard` link: `data`, its fields as JSON, and `photo`, base64), `qr_codes` (name, kind, content, colors and `hasPassword`, never the Wi-Fi password), `slug_locks`, `audit_log` (only with the `audit` permission), `settings`, `clicks_daily` and `clicks_daily_dim` (only with "Include analytics"), `api_keys` (name, prefix, permissions, domains and dates only), `agent_connections`, `tool_calls`.

### What it leaves out

- Link passwords: a protected link has `"protected": true` and no password hash. After a restore from the export its password must be set again.
- Wi-Fi passwords of saved QR codes: a code with one has `"hasPassword": true`. After a restore enter the password again.
- API key secrets and hashes: keys in the file cannot be used. Create new keys after a restore.
- Secrets pasted in the dashboard (the `secret.*` settings rows, stored encrypted) and the Worker secrets.
- Sign-in data: sessions, sign-in links, passkeys, sign-in challenges and rate-limit counters.
- Internal state: locks and the analytics rollup mark.
- OAuth grants and tokens of agent connections (they live in KV, not D1).
- Raw clicks still in Analytics Engine that are not yet rolled into the daily totals.

### Restoring from an export

Not in this version. The export is a readable copy for safekeeping and for moving your data elsewhere; to undo a mistake on the same instance, use D1 Time Travel. A restore written by hand from the file must insert `roles` before `users`, since `users.role_id` refers to a role: then every person keeps their custom role. A migrated database already holds the two built-in rows (`builtin = 1`, ids `owner` and `member`), so upsert those (`INSERT ... ON CONFLICT(id) DO UPDATE SET name = excluded.name, perms = excluded.perms, updated_at = excluded.updated_at, updated_by = excluded.updated_by`) to keep the exported Member permissions, and insert the custom rows as written.
