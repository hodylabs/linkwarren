# Domains

A domain is a hostname that serves short links, for example `go.example.com`. The owner adds any type (main, shared, private) and it is active at once. A member adds private domains only; theirs start `pending` until the owner approves them, and a member has at most 3 pending domains at a time.

## How a domain connects

When Cloudflare is configured (see [deploy.md](deploy.md)), linkwarren looks the host up in your Cloudflare account before it writes anything and gives the domain one of three kinds:

- **account**: the host is inside a zone in your Cloudflare account. linkwarren attaches it directly: a proxied placeholder record (`AAAA <host> 100::`, comment `linkwarren`) when the host has no record yet, plus a Worker route `<host>/*`. The owner's create attaches at once. A member's create makes no Cloudflare change at all; the owner attaches it when approving (`attachOnApproval: true`).
- **outside**: the host is not in your account. linkwarren creates a Cloudflare for SaaS custom hostname and a route `<host>/*` on the SaaS zone. The person who manages the host's DNS adds one record, shown in `cloudflare.instructions`: `CNAME <name> -> <target>`, where `name` is the host without its registrable domain (`@` for the bare domain) and `target` is `CF_CNAME_TARGET`.
- **manual**: Cloudflare is not configured. linkwarren calls no Cloudflare API and you connect the host yourself, as before.

### Existing records (account domains)

Adding an account host that already has DNS records would send its traffic to linkwarren, so the owner's create is refused with `409 dns_record_exists` until it is resent with `"confirmTakeover": true`. Then only the route is added and the existing record stays as it is. These are refused even with the confirmation, and nothing is written:

- `409 dns_not_proxied`: a record at the host (or the wildcard that covers it) is not proxied, or the name is delegated to other nameservers. Traffic would never reach the Worker.
- `409 route_in_use`: a route that matches the host is bound to another Worker.

Records include a wildcard at any parent name inside the zone (`*.example.com` covers `a.b.example.com`).

### Other create errors

- `400 outside_not_configured`: the host is outside your account and the SaaS zone or CNAME target is not set.
- `502 cloudflare_unreachable`: Cloudflare did not answer before anything was written. Nothing was added; try again.
- A Cloudflare failure after the domain was saved keeps the domain and answers `201` with `cloudflare.lastError` set (for example `cloudflare_500`). The next status check retries.

## Status

Every domain in `GET /api/domains` carries a `cloudflare` object from the last stored check. `GET /api/domains/:id/cloudflare` (owner, or the member who added the domain) is the live check: it answers the stored state when the last attempt (failed ones included) was under 10 seconds ago, otherwise it asks Cloudflare again and re-creates any missing piece linkwarren made before. It never attaches a new account domain and never takes over a record. A disabled domain is never rechecked. A Cloudflare failure during the check answers `200` with the stored state and `lastError`.

| Field | Values |
| --- | --- |
| `dns` | `found` (the record points at linkwarren), `missing` (no record yet), `wrong_target` (a record points somewhere else), `unknown` (not checked, or the DNS lookup failed) |
| `ownership` | `verified`, `pending` (Cloudflare is still checking, or an account domain is not attached yet), `failed`, `unknown` |
| `certificate` | `issued`, `pending`, `failed`, `not_covered` (account host two or more labels below the zone: the free certificate covers the zone and one label below it; add an advanced certificate in Cloudflare), `unknown` |
| `errors` | Cloudflare's own verification messages, at most 3 |
| `lastError` | the error code of the last failed check, `null` after a good one |

An outside domain works once `dns`, `ownership` and `certificate` are all green.

## Bare domains (apex)

A bare domain such as `example.com` (or `example.co.uk`) has `instructions.apex: true` and `name: "@"`. Plain DNS does not allow a CNAME at the bare domain, so its DNS provider must support CNAME flattening or an ALIAS (ANAME) record pointing at the target. A flattened record shows up as A/AAAA addresses; linkwarren counts it as `found` when they match the target's addresses.

## Cloudflare for SaaS limits

The first 100 custom hostnames on the SaaS zone are free; Cloudflare bills each one after that. Every outside domain uses one, including pending ones, until the domain is rejected or removed.

## Case-sensitive slugs

Turning case-sensitivity on for a domain changes which public URLs match: `/Spring` stops reaching the link `spring`, and `/Spring` and `/spring` can become different links. Existing links keep their exact slug. Turning it back off is refused while two slugs differ only by case.
