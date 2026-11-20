# Importing links from 66biolinks

This brings legacy short links over without changing a single slug, so printed QR codes keep working. The import never overwrites: a slug that already exists with a different destination is reported as a conflict and left alone, and running it twice changes nothing.

Requirements: Node 23.6 or newer (the scripts are TypeScript run directly by Node; on Node 22.6 to 23.5 add `--experimental-strip-types`), `cloudflared`, and an instance owner account.

## 1. Export

> Verify column names against the live database (`DESCRIBE links; DESCRIBE domains;`) before running. Read-only queries only: never run anything but `SELECT` against the legacy database.

The query below is written from the known 66biolinks schema (table `links` with `url` as the slug, `location_url` as the destination, `domain_id` `0` for the main domain; table `domains` with `host`, `custom_index_url`, `custom_not_found_url`). Only rows with `type = 'link'` are short links. Replace `main.example` with the legacy main host. Dates are assumed to be stored in UTC; check the application timezone before trusting that.

```sql
SELECT JSON_OBJECT(
  'mainHost', 'main.example',
  'domains', (
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'host', d.host,
      'customIndexUrl', NULLIF(d.custom_index_url, ''),
      'customNotFoundUrl', NULLIF(d.custom_not_found_url, ''))), JSON_ARRAY())
    FROM domains d),
  'links', (
    SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'host', CASE WHEN l.domain_id = 0 THEN NULL ELSE d.host END,
      'slug', l.url,
      'destination', l.location_url,
      'enabled', IF(l.is_enabled = 1, CAST('true' AS JSON), CAST('false' AS JSON)),
      'startDate', DATE_FORMAT(l.start_date, '%Y-%m-%d %H:%i:%s'),
      'endDate', DATE_FORMAT(l.end_date, '%Y-%m-%d %H:%i:%s'))), JSON_ARRAY())
    FROM links l LEFT JOIN domains d ON d.domain_id = l.domain_id
    WHERE l.type = 'link' AND (l.domain_id = 0 OR d.host IS NOT NULL))
) AS export;
```

Run it and keep the output as a file (`--raw` stops the client from escaping the JSON):

```
mysql --batch --raw --skip-column-names -e "<the query>" <database> > export.json
```

`host` is null only for main-domain links (`domain_id = 0`); the scripts treat them as belonging to `mainHost`. Links whose custom domain no longer exists (`l.domain_id <> 0 AND d.host IS NULL`) are excluded from the export, because their host is unknown. List them separately for review: `SELECT l.url, l.location_url FROM links l LEFT JOIN domains d ON d.domain_id = l.domain_id WHERE l.type = 'link' AND l.domain_id <> 0 AND d.host IS NULL;`. The export contains your destinations: keep it out of the repository.

## 2. Audit what will not be imported

Decide which hosts to bring over (the `--hosts` list). The audit writes every link outside that list to a local CSV so you can decide to keep or drop each one. It reads the export file and writes one local file; nothing is sent anywhere.

```
npm run audit:66biolinks -- export.json --exclude host-one.example --out audit.csv
```

Cells that start with `=`, `+`, `-` or `@` are prefixed with a single quote so a spreadsheet does not evaluate them.

## 3. Sign in and dry run

The import calls the dashboard as the instance owner, through Cloudflare Access, with a user token:

```
cloudflared access login https://<dashboard-host>
export CF_ACCESS_TOKEN="$(cloudflared access token -app=https://<dashboard-host>)"
```

`--hosts` is required and has no default, so nothing is imported by accident. Start with a dry run: it performs every check and prints the same report but writes nothing.

```
npm run import:66biolinks -- export.json --api https://<dashboard-host> --hosts host-one.example --dry-run
```

## 4. Import

```
npm run import:66biolinks -- export.json --api https://<dashboard-host> --hosts host-one.example
```

The script sends the links in requests of 500 (the server accepts at most 1000), keeping slugs that differ only by case in the same request. The report lists:

- `created`, `skipped` (already present with the same destination), and `conflicts` with a reason per link: `exists` (same slug, different destination), `locked` (the slug is reserved by a deleted or disabled link), `invalid_slug`, `invalid_destination`, `bad_date`, `case_twin`, `dashboard_host`, `invalid_host`.
- Domains created. Missing domains are created private and active, owned by the importing owner, with the legacy index and not-found redirects when those are valid URLs (invalid ones are ignored and listed). Existing domains are reused: their type and status are never changed and redirects are only filled when empty.
- Case-sensitive domains: a new domain whose export has two slugs differing only by case is created case sensitive so both keep working. On an existing case-insensitive domain such twins are conflicts and the domain is never flipped.
- Disabled legacy links become slug locks only: they keep returning not found and nobody can claim the slug.

Every real request (up to 500 links) writes one `import.run` audit row, so a large import leaves several. `created` counts rows actually inserted. If a chunk fails, the script prints the running totals of the chunks already completed and exits 1; fixing the cause and re-running is safe because the import is idempotent. Running the same command again must report `created 0`.

## 5. Verify

Compare every exported link on the old server and on the new Worker, sending the original `Host` header to both and never following redirects:

```
npm run verify:redirects -- export.json --old <old-origin-ip-or-host> --new https://<worker-url> --hosts host-one.example
```

It prints each link whose status or `Location` differs and exits 1 if there is any difference. Expect differences only for links you decided not to import; resolve everything else before moving DNS.
