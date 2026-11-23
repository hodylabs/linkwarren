---
title: linkwarren - Design Spec
project: linkwarren
type: design-spec
status: in-development
tags: [linkwarren, link-shortener, cloudflare-workers, d1, mcp, open-source]
created: 2026-11-20
---

> [!abstract] What this is
> **linkwarren** is a self-hosted, multi-domain link shortener that runs entirely in your own Cloudflare account (Workers, D1, KV, Analytics Engine). One owner, many users, many domains, each domain with its own set of slugs. Open source under AGPL-3.0.
> Status: in development.

## 1. Why build it

Every Workers-native shortener checked on 2026-11-20 keys slugs globally, so `a.com/promo` and `b.com/promo` cannot point to different places: Sink (`slug` primary key), WR.DO (Postgres, `url @unique`, redirect ignores the host), Rushomon (`idx_links_shortcode_active` global), shrtnr (`slug UNIQUE`). The one with the right `(domain, slug)` model, `botnick/shortlink`, has no license (asked in botnick/shortlink#21). linkwarren is written from scratch: ideas only, no code copied.

## 2. Requirements (decided)

**Domains**
- Three types: **main** (every user can create links), **shared** (only users the owner grants), **private** (its owner plus people they invite).
- Slugs are unique per domain: the key is `(domain_id, slug_key)`.
- Per-domain settings: where the **bare domain** goes, where a **missing or deleted link** goes, case-sensitive slugs (default off), hide from search engines (default on), extra reserved slugs.
- A deleted link falls back to the domain's not-found redirect, and its slug is **locked** so nobody else can take over printed QR codes. Releasing a lock needs the `links.editAny` permission (owners have it) and a domain the person can use.
- People with `domains.own` (on for Member) can add their own private domains and create slugs on them at once; links answer with a "not active yet" page until an **owner or domain manager approves** the domain.
- Domains in the owner's Cloudflare account attach directly by API. Outside domains connect with a **CNAME through Cloudflare for SaaS**. A CNAME on a bare domain needs CNAME flattening or ALIAS at the outside DNS provider; subdomains always work.
- For same-account domains, domain settings expose a few Cloudflare controls (security level, rate limits).

**Links**
- Destination `http` or `https` only. Redirect **302 by default** (301 is opt-in per link), so a printed QR code can change destination.
- **Bulk edit:** select rows on the Links page (keyboard, mouse or long-press) and delete, schedule, move, set the redirect type and options, set or remove a password, copy short URLs or export CSV; at most 50 links per request. Moving to another domain needs a choice: **forward** (the old address becomes a forwarder, one hop to the new short link) or **copy**. Deleting a link also deletes its forwarders and locks their slugs. Same rules as single edits; same actions from the API (`POST /api/v1/links/bulk`) and MCP (`bulk_links`).
- Rules: schedule (starts at), expiry, password, country and device routing (form factor, phone OS iOS/Android, computer OS Windows/macOS/Linux/ChromeOS; an iPad in desktop mode counts as macOS and desktop), campaign (UTM) builder, pass query string through.
- QR codes always encode the short link, never the destination.

**People and access**
- Sign-in by **email link or passkey** (app mode, the default) or through **Cloudflare Access** (`AUTH_MODE=access`). Sign-in proves the email; the app's own `users` table decides who gets in. People are invited from the dashboard.
- The **owner** sees and manages every user, domain and link.
- **Roles** decide what a person can do; which domains they can use stays per person. Owner is built in with every permission; **Member** is built in and editable, its defaults equal a member's rights before roles existed; owners add custom roles from twelve permission toggles (create links, edit anyone's links, bulk edit, all analytics, own domains, manage domains, people, API keys, AI agents, settings, export and import, audit log). The permissions load with the person on every request (one join, no extra query).
- **Link rights by role:** editing or deleting a link needs a domain the person can use and one of: they created it and have `links.create`, they own the domain, they are an owner, or they have `links.editAny`. So a role without `links.create` or `links.editAny` only reads links, except on a domain the person owns. `domains.manage` alone does not edit other people's links. Creating needs `links.create` (a bulk copy to another domain too), bulk changes `links.bulk` as well as the per-link right, and releasing a slug lock `links.editAny` (an unknown domain and one the person cannot use both answer `403`); a refusal is `403 forbidden`, before the body is read. Each right is checked again in the same database batch as the write, so a role edited at the same moment writes nothing (a bulk link refused that way reports `forbidden`).
- **Domain rights by role** (S8 R8): `domains.manage` (owners have it) adds main, shared and private domains (active at once, no pending limit) and administers every domain: approve, disable, reject, domain members (themselves included, audited), Cloudflare controls, settings and the live check. It never makes a domain usable: link work on a shared domain still needs membership. Their dashboard domain list has every domain, each with `canUse`. A main or shared domain added by a non-owner is owned by the earliest active owner. `domains.own` only adds private domains that wait for approval. Anyone keeps the settings and live check of a domain they own. A refusal is `403 forbidden`, before the body is read; the permission is checked again in the same database batch as the write and before every Cloudflare change, so a role edited at the same moment changes nothing.
- **Managing people** (`people.manage`): owners and people managers invite, change the role of, disable, sign out and remove people, and see and revoke their API keys and agent connections; `GET /api/users` is also open to domain managers (the domain members editor). A non-owner never acts on an owner or on themselves (`409 self`), acts only on people whose current role has no permission theirs lacks, assigns or invites only such a role and never Owner (`403 role_above_you`), and grants shared domains on invite only with `domains.manage` as well. `PATCH /api/users/:id` takes `{ roleId?, status? }` and `POST /api/users/invite` takes `roleId` (default `member`); an unknown role is `400 bad_role`. Every rule is checked again in the same database batch as the write, so a role edited or a manager demoted at the same moment writes nothing. At least one active owner always remains. Managers on the same role (or roles with the same permissions) can disable or remove each other, and a manager can assign any role within their own permissions to others, their own role included. When a non-owner removes a person, that person's links and domains go to an owner: the first active owner by default, or another active owner they name (themselves or any non-owner is `400 bad_transfer`).
- **Settings, data and audit by role** (S8 R5, R12): `settings` opens Settings (name, logo, main domain, link defaults, test email, the Cloudflare connection page, controls, Cloudflare setup and resync, and the secret status, never a value; domain managers also read the Cloudflare connection page). Pasting or removing a secret, the Cloudflare token check and the first-run setup stay owner only. `data` exports the whole instance (the audit log only with `audit` as well) and imports; a non-owner's import is refused before any write if it creates a domain without `domains.manage` or touches a domain they cannot use. `audit` reads the audit log. A refusal is `403 forbidden`, before the body is read, and each write checks the permission again in its own database batch.
- **Roles API** (dashboard session only): `GET /api/roles` (owners and people managers) lists Owner, Member, then custom roles by name, each with its permissions and how many people hold it. Only owners create (`POST`), rename or edit (`PATCH /api/roles/:id`) and delete (`DELETE /api/roles/:id`) roles. Names are cleaned of control, bidi and zero-width characters, 1 to 40 characters, unique ignoring case (Owner and the current Member name included); at most 20 custom roles; unknown permission keys are refused. Owner cannot be edited, built-in roles cannot be deleted. Deleting a role people still hold needs `moveTo` (any other role except Owner): one batch moves them and deletes the role, and a person assigned meanwhile, or either role renamed, makes it fail with nothing changed (`409 changed`). Moved people keep their sessions; their rights change on their next request. Each change is audited (`role.create`, `role.update` with the permissions added and removed, `role.delete` with where its people went).
- **Full audit log** of every change by every person and agent, kept **3 years**. Agent changes are recorded as "person via tool".

**Analytics**
- Clicks per link, split QR scan vs typed or clicked, countries, devices, referrers, bots and link previews left out.
- Filters: domain (multi-select), date range (presets and custom From/To), link search.
- Scope: the domains a person can use; with `analytics.all` (owners have it) every domain. An API key's or agent's domain restriction still narrows it.
- Raw click detail kept 90 days (Analytics Engine), then daily totals in D1.

**Agents and API**
- MCP built into the app at `https://<dashboard host>/mcp` (the owner turns it on or off on the API & agents screen; `MCP_ENABLED=0` locks it off for the instance), OAuth per the MCP standard Kind A: remote, read-only by default, read+write chosen on the approval screen, acts as the approving person, every tool call audited by tool name, revocable. Works from Claude, ChatGPT, Claude Code and Codex.
- Personal API keys with scopes, domain limits and expiry for scripts, on `/api/v1` only. Connect guide: `docs/agents.md`.
- **Keys and agents follow the role** (S8 R7), refused not revoked: without `keys` every key of the role's people answers `403 keys_not_allowed` before any limiter or last-use write, and `POST /api/keys` is `403 forbidden`; without `agents` every tool call answers "Your role no longer allows AI agents. Ask an owner." (no `tool_calls` row) while tokens keep refreshing (`/token` checks only that the connection and person are live, so nothing is revoked), raising a connection to write or delete is `403 forbidden`, and `/authorize` answers `403` "Your role does not allow connecting AI agents." Turning the permission back on restores the same keys and connections. Key and connection creation re-check the permission in the insert's batch. Listing and revoking one's own keys and connections, and lowering a connection, stay open (R3). A key's or agent's scope only narrows the role: every call goes through the same routes and the person's current rights.

**Dashboard**
- Keyboard-first: **Ctrl+K** palette (`g` + letter go, `c` + letter create, other text searches), `N` new link, `J`/`K` rows, every form keyboard-complete.
- Brand: logo `design/logo/linkwarren-mark.svg` (faceted orange rabbit), graphite `#15181D` + orange `#FD8D27`, Unbounded (titles, wordmark), IBM Plex Sans (UI), IBM Plex Mono (links and domains). Primary buttons graphite with an orange plus.
- First-run setup: name, sign-in, Cloudflare token (permissions checked one by one), main domain, email, bring your links.

**Instance and release**
- Each instance chooses its own dashboard host, which never appears in the repo. In host mode it is a dashboard-only host, never a short-link domain (example: `dash.example.com`); in path mode it is the main short domain and the dashboard lives under its path (example: `example.com/dashboard`).
- Email from the instance via Resend.
- No auto-update (decided 2026-11-22): a daily check of GitHub's latest release shows "vX.Y.Z available" in the sidebar to owners and Settings holders; turned off in Settings, This instance.
- License: **AGPL-3.0** (open source; decided 2026-11-20 over AGPL + Commons Clause, which would have made it source-available). Anyone may host and modify it; anyone who changes it, including to run it as a service, must publish their changes; closed products cannot embed it. Plus `TRADEMARK.md` (forks and hosted services may not use the name or logo) and a contributor agreement so the maintainers can grant commercial license exceptions.

## 3. Architecture

One Worker serves everything. The request **host** decides the path:
- `DASHBOARD_HOST` → dashboard SPA, JSON API under `/api`, MCP under `/mcp`, OAuth endpoints, machine API under `/api/v1`. Signed in by the app or by Cloudflare Access (`AUTH_MODE`).
- Path mode (`DASHBOARD_PATH`, for example `/dashboard`): `DASHBOARD_HOST` is the main short domain. The front door (`src/index.ts`, configured by `src/dash.ts`) decides with string compares only, before any D1 or KV work: the prefix and its subpaths are the dashboard (prefix stripped, so the app keeps its root routes), root OAuth discovery paths answer JSON, `/mcp` and `/api/v1` at the root stay the MCP server and the machine API, and everything else goes straight to the redirect handler.
- `LEGACY_DASHBOARD_HOST` (optional) → `301` for `GET`/`HEAD` to the same path under the dashboard, `410` for everything else.
- Any other host → the redirect handler, looking up `(domain for host, slug)`.

Storage: **D1** is the source of truth (users, domains, members, links, slug locks, audit log, daily click totals, and a small `settings` table; forwarders are rows in `links` with `forward_to` set, and the agents on/off switch is the `settings` row `mcp.enabled`). **KV** caches host→domain and `(domain, slug)`→link for the hot path, invalidated on every write. **Analytics Engine** receives one data point per redirect. A daily **cron** rolls Analytics Engine into D1 totals and purges audit entries older than 3 years.

Runtime dependencies kept to seven: `hono` (routing), `jose` (Access JWT), `zod` (input validation), `@simplewebauthn/server` (passkeys), and for MCP `@cloudflare/workers-oauth-provider`, `agents` and `@modelcontextprotocol/server`.

## 4. Stages

Each stage ships through the usual loop: branch, review, PR, merge, deploy to a dev instance, live check.

| Stage | Delivers | Live check |
|---|---|---|
| **S1 Core** | Repo, license, schema, redirect hot path, Access sign-in, links + domains API with authz, slug locks, audit log, import API, dev deploy | A test short domain redirects; dashboard API answers only through Access |
| S2 Dashboard | React SPA from the mockups: links, domains, people + audit, Ctrl+K palette, switcher, new-link form, keyboard model | Every mockup screen works against the dev API, keyboard-only |
| S3 Domain onboarding | Cloudflare API: attach same-account domains, Cloudflare for SaaS custom hostnames, status checks, approval flow, Cloudflare controls | Add an outside test domain by CNAME end to end |
| S4 Analytics | Analytics Engine writes, bot filtering, SQL API queries, daily rollups, analytics screen with filters, audit retention purge | Clicks on the test domain show up with correct splits |
| S5 Link rules | Password, country/device routing, UTM builder, QR (SVG/PNG) | Each rule verified with curl and a phone scan |
| S6 Agents + API | MCP with OAuth (read / read+write), tools, API keys, "via" audit | Connect from claude.ai and Claude Code; scopes live-tested |
| **S6b Bulk edit** | Select and bulk-change links, move between domains with forwarders, bulk API and MCP tool, owner switch for agents (migration 0008) | A move with forwarding: the old address answers one `302` to the new link, one click recorded; delete of the moved link answers the not-found page on both; the switch turns `/mcp` off and on |
| S7 People + setup | Invites (Resend), settings screens, first-run setup wizard | Fresh instance set up from zero in the wizard |
| S8 Release | Docs, release, and the one-click deploy, built last: a Deploy to Cloudflare button that forks the repo and provisions D1, KV and the Worker in the user's own account, plus an `npm run setup` terminal fallback | Both deploy paths end in the first-run wizard |

## 5. Out of scope (v1)
- Bio pages, splash pages, tracking pixels.
- Billing, plans or quotas: this is self-hosted software, not a SaaS.
- Bring-your-own database; non-Cloudflare hosting.
