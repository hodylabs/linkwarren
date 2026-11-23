# Importing links

The setup wizard (step "Bring your links") and `POST /api/import` take the same body, so a file you can import in the wizard can also be sent by a script. The import never overwrites: a slug that already exists with a different destination is reported as a conflict and left alone, and running it twice changes nothing. The format and its checks live in `src/importFormat.ts`.

## JSON

```json
{
  "mainHost": "main.example",
  "domains": [
    { "host": "main.example", "customIndexUrl": "https://example.org/home", "customNotFoundUrl": null }
  ],
  "links": [
    { "host": null, "slug": "spring", "destination": "https://example.org/spring", "enabled": true,
      "startDate": null, "endDate": "2026-02-01 12:30:00", "protected": false }
  ]
}
```

- `host` null means the link belongs to `mainHost`. Hosts are lowercased, without port or trailing dot.
- `startDate` and `endDate` are `YYYY-MM-DD HH:MM:SS` in UTC, or null.
- `protected: true` marks a link that had a password where it came from. A password cannot be carried over, so such a link is imported locked (never live, whatever `enabled` says) and listed under `protected` in the report: create it again with its new password (open the New link sheet, type the slug, release the lock, set the password, then create).
- When any link has no `protected` field, the importer warns "This file does not say which links had a password. Confirm none did, or give every link a protected field." A dry run shows the warning; a real run is refused (`400 protected_unknown`) until the owner confirms (the confirmation box in the wizard, or `"confirmNoPasswords": true` in the body).

## CSV

The first row names the columns: `slug` and `destination` (or `url`) are required; `host`, `name` (the optional link name), `enabled` (`true`, `false`, `1`, `0`, `yes`, `no`), `start_date` and `end_date` are optional. A `name` cell that starts with an apostrophe followed by `=`, `+`, `-`, `@` or another apostrophe loses that one apostrophe (the Links CSV export adds it as a spreadsheet formula guard). A JSON link may carry `name` too; a name over 100 characters or with a line break is the conflict `bad_link_name`. An empty host is this instance's main domain. A CSV has no `protected` column, so it always needs the confirmation above. A row whose `kind` column is `vcard` (a contact card in a Links CSV export, which leaves its destination empty) is refused with a line error: bring contact cards back through a JSON import with their `vcard` fields. A destination on the contact card placeholder host (`vcard.invalid`) is a conflict (`invalid_destination`).

## API

`POST /api/import` (owners and the `data` permission) takes at most 1000 links per request; add `?dryRun=1` to run every check and get the same report without writing anything. Keep slugs that differ only by case in the same request: a new domain is created case sensitive when its request holds such twins. `importRequests` in `src/importFormat.ts` splits a large file that way, the same split the wizard uses.

A link may carry a `vcard` object (the contact card fields of `POST /api/v1/links`, see `docs/agents.md`): it is imported as a contact card link, its `destination` is ignored, and a card that fails the checks is a conflict with the reason `invalid_vcard`. This is how the `links` and `vcards` tables of a full export come back in: give each row of kind `vcard` the fields of its `vcards.data` plus `photo`.

A link `destination` may be `http(s)`, `tel:` or `mailto:`, with the same strict checks as a link created in the dashboard; one that fails them is a conflict. A domain `customIndexUrl` or `customNotFoundUrl` must be `http(s)`: anything else is ignored and reported.

The report lists `created`, `skipped` (already present with the same destination), `conflicts` with a reason per link, `protected`, the domains created, the case-sensitive domains and any ignored domain redirects. Missing domains are created private and active, owned by the person importing; existing domains are reused and never changed except for a domain redirect that is still empty. Disabled links become slug locks only. Imported links take the instance link defaults for redirect type and query pass-through.

Import keeps the built-in reserved words (an old link named `admin` still imports), with one exception: with the dashboard at a path, a link on the dashboard host whose slug is the path's segment, `mcp` or `api` (`example.com/dashboard` for `DASHBOARD_PATH=/dashboard`, `example.com/mcp`, `example.com/api`, in any case, live or disabled) is listed with the conflict `reserved_path` and nothing is written for it, since the dashboard, the MCP server or the machine API answers that address. In that setup the dashboard host is a valid domain to import into once it is the main domain; since import creates private domains, a link on it before that gets the conflict `dashboard_main_only` (add the main domain first). With the dashboard on its own host a link on that host gets the conflict `dashboard_host`, even when a domain row for that host already exists (for example one left from path mode).

**Who may import (roles).** Import needs the `data` permission (owners have it), checked before the file is read. Someone who is not an owner is refused with `403 forbidden` before anything is written, a dry run included, when the file would create a domain and they lack `domains.manage`, names an existing domain they cannot use (for example a shared domain they are not a member of, or a disabled one), or would fill in a redirect of a domain they cannot manage. Every write checks these again in the same database batch, so a role edited during the import writes nothing more and the import stops with `403 forbidden`. A domain that stops being usable during the import (its membership removed meanwhile) gets none of its remaining links; each one is listed as a conflict with the reason `forbidden`. Filling in a redirect is allowed on a domain the person owns or, with `domains.manage`, on any domain they can use.
