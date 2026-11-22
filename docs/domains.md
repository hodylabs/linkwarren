# Domains

A domain is a hostname that serves short links, for example `go.example.com`. Who can do what with domains follows the person's role:

- **Manage domains** (`domains.manage`; owners have it) adds any type (main, shared, private), active at once and with no pending limit, and administers every domain: approve, disable, reject, domain members and the Cloudflare controls, plus the settings and live check of any domain. It does not make a domain usable: creating links on a shared domain still needs membership, and a domain manager may add themselves as a member (audited). A main or shared domain added by someone who is not an owner is owned by the earliest active owner; a private one by the person who added it.
- **Add own domains** (`domains.own`; on for Member) adds private domains only; they start `pending` until a domain manager approves them, at most 3 pending at a time.
- Without either, adding a domain is `403 forbidden`, answered before the body is read. Anyone keeps the settings and live check of a domain they own.

In the dashboard list (`GET /api/domains`) a domain manager who is not an owner sees every domain, each with `canUse` (whether they can create links on it); owners can use every domain and everyone else sees only the domains they can use, both without that field (read a missing `canUse` as `true`). A key or agent limited to some domains still lists only those. The API list (`GET /api/v1/domains`) always has only usable domains.

Each permission is checked again in the same database step as the write, and before every Cloudflare change, so a role edited at the same moment changes nothing and answers `403 forbidden`. A Cloudflare change that already landed is always stored and audited: a controls change that loses the permission between its two steps answers `409 conflict` with the stored controls (see below), and a create whose permission is gone right after the domain was saved keeps the domain but connects nothing in Cloudflare (a domain manager connects it later with Finish connecting or the status check).

## How a domain connects

When Cloudflare is configured (see [deploy.md](deploy.md)), linkwarren looks the host up in your Cloudflare account before it writes anything and gives the domain one of three kinds:

- **account**: the host is inside a zone in your Cloudflare account. linkwarren attaches it directly: a proxied placeholder record (`AAAA <host> 100::`, comment `linkwarren`) when the host has no record yet, plus a Worker route `<host>/*`. A domain manager's create attaches at once. A create with `domains.own` makes no Cloudflare change at all; a domain manager attaches it when approving (`attachOnApproval: true`).
- **outside**: the host is not in your account. linkwarren creates a Cloudflare for SaaS custom hostname and a route `<host>/*` on the SaaS zone. The person who manages the host's DNS adds one record, shown in `cloudflare.instructions`: `CNAME <name> -> <target>`, where `name` is the host without its registrable domain (`@` for the bare domain) and `target` is `CF_CNAME_TARGET`. When that DNS is itself on Cloudflare, make the record DNS only (grey cloud). The `<host>/*` route on the SaaS zone is set up for DNS-only records; a proxied record also hides the CNAME, so the DNS check shows `wrong_target` until Cloudflare has activated the hostname and issued its certificate.
- **manual**: Cloudflare is not configured. linkwarren calls no Cloudflare API and you connect the host yourself, as before.

### Existing records (account domains)

Adding an account host that already has DNS records would send its traffic to linkwarren, so a domain manager's create is refused with `409 dns_record_exists` until it is resent with `"confirmTakeover": true`. Then only the route is added and the existing record stays as it is. These are refused even with the confirmation, and nothing is written:

- `409 dns_not_proxied`: a record at the host (or the wildcard that covers it) is not proxied, or the name is delegated to other nameservers. Traffic would never reach the Worker.
- `409 route_in_use`: a route that matches the host is bound to another Worker.

Records include a wildcard at any parent name inside the zone (`*.example.com` covers `a.b.example.com`).

### Outside domains on the SaaS zone

The SaaS zone may serve other things, so before anything is written an outside create (by anyone) is refused, with no domain added:

- `409 route_in_use`: a route on the SaaS zone that covers the host (for example `*/*` or `*.example.com/*`) is bound to another Worker or to none. Once linkwarren's own `<host>/*` route exists, a broader foreign route is fine, but another pattern for the same host (such as `<host>/private/*`) still refuses, because it takes those paths away.
- `409 hostname_in_use`: a custom hostname for the host already exists and linkwarren did not create it, and no route to linkwarren serves it.
- `409 hostname_limit`: the zone already has 95 custom hostnames. Cloudflare bills each one past the free 100; linkwarren stops at 95 so concurrent creates cannot reach a billed one.

The same checks run again before every later write (approve, status check, resync), so a conflict that appears later is stored as `lastError` and nothing is written.

### Other create errors

- `400 outside_not_configured`: the host is outside your account and the SaaS zone or CNAME target is not set.
- `502 cloudflare_unreachable`: Cloudflare did not answer before anything was written. Nothing was added; try again.
- A Cloudflare failure after the domain was saved keeps the domain and answers `201` with `cloudflare.lastError` set (for example `cloudflare_error`). For an outside domain the next status check retries. For a domain manager's account domain it does not: the domain stays active but not connected (`attached: false`) until a domain manager uses Finish connecting (below).

## Status

Every domain in `GET /api/domains` carries a `cloudflare` object from the last stored check. `GET /api/domains/:id/cloudflare` (a domain manager, or the person who owns the domain) is the live check: it answers the stored state when the last attempt (failed ones included) was under 10 seconds ago, otherwise it asks Cloudflare again and re-creates any missing piece linkwarren made before. It never attaches a new account domain and never takes over a record. A disabled domain is never rechecked. A Cloudflare failure during the check answers `200` with the stored state and `lastError`.

| Field | Values |
| --- | --- |
| `dns` | `found` (the record points at linkwarren; for an outside host with no visible CNAME, also once Cloudflare has activated its hostname and certificate, which covers a proxied record), `missing` (no record yet), `wrong_target` (a record points somewhere else), `unknown` (not checked, or the DNS lookup failed) |
| `ownership` | `verified`, `pending` (Cloudflare is still checking, or an account domain is not attached yet), `failed`, `unknown` |
| `certificate` | `issued`, `pending`, `failed`, `not_covered` (account host two or more labels below the zone: the free certificate covers the zone and one label below it; add an advanced certificate in Cloudflare), `unknown` |
| `errors` | Cloudflare's own verification messages, at most 3 |
| `lastError` | the code of the last failed check (list below), `null` after a good one |
| `attached` | linkwarren holds a route for the host. An account domain is connected only when this is true |
| `attachOnApproval` | a pending account domain: a domain manager's approval attaches it |

An outside domain works once `dns`, `ownership` and `certificate` are all green.

`lastError` (and each resync failure) is one of a small stable set:

| Code | Meaning | Does the next check retry? |
| --- | --- | --- |
| `cloudflare_unreachable` | Cloudflare did not answer (or the request ran out of subrequests) | yes |
| `cloudflare_error` | Cloudflare answered with an error | yes |
| `cloudflare_forbidden` | the token lacks a permission (401 or 403) | no, fix the token |
| `outside_not_configured` | the SaaS variables are not set | no |
| `route_in_use`, `hostname_in_use`, `hostname_limit` | the refusals above | no |
| `dns_record_exists`, `dns_not_proxied` | account refusals (see Existing records) | no |
| `internal_error` | a bug in linkwarren (logged without the token) | no |

A status check never clears an error it did not resolve: on an active account domain that is not attached, the error from the failed attach stays until Finish connecting succeeds. The dashboard stops polling on any code a retry cannot fix.

People without `domains.manage` see the `cloudflare` object only for what they need on domains they do not own (`kind`, `dns`, `ownership`, `certificate`, `attached`): `errors`, `lastError`, `instructions`, `securityLevel` and `rateLimit` are `null` or empty there.

## Approve, reject and finish connecting

Needs `domains.manage` (a `403 forbidden` comes before the body is read). Disable (`POST /api/domains/:id/disable`) too.

- **Approve** (`POST /api/domains/:id/approve`, optional `{ "confirmTakeover": true }`) runs a fresh check first and activates only when it is green: an outside domain needs `dns`, `ownership` and `certificate` all green; an account domain is attached here (the same takeover rules as a domain manager's create apply, so `409 dns_record_exists` asks for `confirmTakeover`); a manual domain is approved as before. Otherwise `409 not_verified` with the current `cloudflare` view, and the domain stays pending. A Cloudflare failure is `502 cloudflare_error`; retry. Approve also enables a disabled domain.
- **Finish connecting** is the same call on an active account domain that is not attached. It attaches the host and records a `domain.attach` audit entry. It is the only way to finish an attach that failed; status checks never attach.
- **Reject** (`DELETE /api/domains/:id`) works on pending domains only (`409 not_pending` otherwise). It first removes what linkwarren created in Cloudflare (a 404 counts as already gone). If Cloudflare fails, nothing is deleted and the answer is `502 cloudflare_error`: retry. Then the domain, its links, slug locks and members are deleted in one step and a `domain.reject` audit entry is written.

Approve, reject and the Cloudflare controls below take a short per-domain lock, because each writes Cloudflare first and the database after. While one runs, another on the same domain answers `409 conflict` and changes nothing; retry in a moment. A lock left by a crashed request expires after 2 minutes.

Audit entries for create, approve and attach carry `confirmTakeover: true` when a takeover was confirmed.

## Cloudflare controls

`PATCH /api/domains/:id/cloudflare` with `{ "securityLevel": "essentially_off" | "low" | "medium" | "high" | "under_attack" | null, "rateLimit": 10-1000 | null }` (`rateLimit` is requests per 10 seconds; `null` removes the rule or the setting). Needs `domains.manage`, for attached account domains, and only while "Cloudflare controls" is on in Settings. linkwarren adds or edits only its own rules, matched by their reference, and never touches other rules in the zone. Errors:

- `409 controls_off`: the Settings switch is off.
- `409 not_same_account`: an outside domain, or an account domain that is not attached.
- `409 cloudflare_plan_limit`: the plan allows no more rate limit rules in the zone (Free allows one).
- `409 cloudflare_forbidden`: the token lacks the controls permissions.

When one of two changes failed, the error answer carries the stored `securityLevel` and `rateLimit`, so the client knows which one landed.

## Bare domains (apex)

A bare domain such as `example.com` (or `example.co.uk`) has `instructions.apex: true` and `name: "@"`. Plain DNS does not allow a CNAME at the bare domain, so its DNS provider must support CNAME flattening or an ALIAS (ANAME) record pointing at the target. A flattened record shows up as A/AAAA addresses; linkwarren counts it as `found` when they match the target's addresses.

## Cloudflare for SaaS limits

The first 100 custom hostnames on the SaaS zone are free; Cloudflare bills each one after that. Every outside domain uses one, including pending ones, until the domain is rejected. linkwarren refuses with `hostname_limit` from the 95th on, so it never adds a billed custom hostname; other Cloudflare charges depend on the account's own plan and settings.

## Moving links between domains

A link can be moved (or copied) only to an **active** domain, one the person may use; pending, rejected and disabled domains refuse it with `target_not_active`. Moving with "forward" keeps the old address working as a forwarder, and deleting the moved link later also deletes its forwarders and locks their old slugs, so an old printed QR code never lands on a link someone else creates there. A lock on a target slug (case-insensitive) blocks a move to it. Details are in [deploy.md](deploy.md#behaviour-to-know).

## Case-sensitive slugs

Turning case-sensitivity on for a domain changes which public URLs match: `/Spring` stops reaching the link `spring`, and `/Spring` and `/spring` can become different links. Existing links keep their exact slug. Turning it back off is refused while two slugs differ only by case.
