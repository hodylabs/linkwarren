---
title: linkwarren - Design Spec
project: linkwarren
type: design-spec
status: approved
tags: [linkwarren, link-shortener, cloudflare-workers, d1, mcp, open-source]
created: 2026-11-20
---

> [!abstract] What this is
> **linkwarren** is a self-hosted, multi-domain link shortener that runs entirely in your own Cloudflare account (Workers, D1, KV, Analytics Engine). One owner, many users, many domains, each domain with its own set of slugs. It replaces Hody's legacy install (used only as a shortener). Public repo `hodylabs/linkwarren`, open source under AGPL-3.0.
> Status: requirements, name, logo and UI approved in conversation 2026-11-20. No code or repo yet.

## 1. Why build it

Every Workers-native shortener checked on 2026-11-20 keys slugs globally, so `a.com/promo` and `b.com/promo` cannot point to different places: Sink (`slug` primary key), WR.DO (Postgres, `url @unique`, redirect ignores the host), Rushomon (`idx_links_shortcode_active` global), shrtnr (`slug UNIQUE`). The one with the right `(domain, slug)` model, `botnick/shortlink`, has no license (asked in botnick/shortlink#21). linkwarren is written from scratch: ideas only, no code copied.

## 2. Requirements (decided by Hody)

**Domains**
- Three types: **main** (every user can create links), **shared** (only users the owner grants), **private** (its owner plus people they invite).
- Slugs are unique per domain: the key is `(domain_id, slug_key)`.
- Per-domain settings: where the **bare domain** goes, where a **missing or deleted link** goes, case-sensitive slugs (default off), hide from search engines (default on), extra reserved slugs.
- A deleted link falls back to the domain's not-found redirect, and its slug is **locked** so nobody else can take over printed QR codes. Only the owner releases a lock.
- Non-owners can add their own domains and create slugs on them at once; links answer with a "not active yet" page until the **owner approves** the domain.
- Domains in the owner's Cloudflare account attach directly by API. Outside domains connect with a **CNAME through Cloudflare for SaaS**. A CNAME on a bare domain needs CNAME flattening or ALIAS at the outside DNS provider; subdomains always work.
- For same-account domains, domain settings expose a few Cloudflare controls (security level, rate limits).

**Links**
- Destination `http` or `https` only. Redirect **302 by default** (301 is opt-in per link), so a printed QR code can change destination.
- Rules: schedule (starts at), expiry, password, country and device routing, campaign (UTM) builder, pass query string through.
- QR codes always encode the short link, never the destination.

**People and access**
- Sign-in through **Cloudflare Access** (Google, one-time email code). Access proves the email; the app's own `users` table decides who gets in. People are invited from the dashboard.
- The **owner** sees and manages every user, domain and link.
- **Full audit log** of every change by every person and agent, kept **3 years**. Agent changes are recorded as "person via tool".

**Analytics**
- Clicks per link, split QR scan vs typed or clicked, countries, devices, referrers, bots and link previews left out.
- Filters: domain (multi-select), date range (presets and custom From/To), link search.
- Raw click detail kept 90 days (Analytics Engine), then daily totals in D1.

**Agents and API**
- MCP built into the app at `/<dashboard host>/mcp`, OAuth per the MCP standard Kind A: remote, read-only by default, read+write chosen on the approval screen, acts as the approving person, every tool call audited by tool name, revocable. Works from Claude, ChatGPT, Claude Code and Codex.
- Personal API keys with scopes and expiry for scripts.

**Dashboard**
- Approved mockups: `~/.dev/Projects/linkwarren/design/ui/index.html` and `setup.html`. Keyboard-first like termynl: **Ctrl+K** palette (`g` + letter go, `c` + letter create, other text searches), `N` new link, `J`/`K` rows, every form keyboard-complete.
- Brand: logo `design/logo/linkwarren-mark.svg` (faceted orange rabbit), graphite `#15181D` + orange `#FD8D27`, Unbounded (titles, wordmark), IBM Plex Sans (UI), IBM Plex Mono (links and domains). Primary buttons graphite with an orange plus.
- First-run setup: name, sign-in, Cloudflare token (permissions checked one by one), main domain, email, bring your links.

**Instance and release**
- Each instance chooses its own dashboard host; it is never a short-link domain and never appears in the repo. Hody's dev instance: Cloudflare account `hody`, dashboard **dev.hody.link**.
- Email from the instance via Resend.
- License: **AGPL-3.0** (open source; decided 2026-11-20 over AGPL + Commons Clause, which would have made it source-available). Anyone may host and modify it; anyone who changes it, including to run it as a service, must publish their changes; closed products cannot embed it. Plus `TRADEMARK.md` (forks and hosted services may not use the name or logo) and a contributor agreement so Hody can sell commercial license exceptions.

## 3. Architecture

One Worker serves everything. The request **host** decides the path:
- `DASHBOARD_HOST` → dashboard SPA, JSON API under `/api`, MCP under `/mcp`, OAuth endpoints. Behind Cloudflare Access.
- Any other host → the redirect handler, looking up `(domain for host, slug)`.

Storage: **D1** is the source of truth (users, domains, members, links, slug locks, audit log, daily click totals). **KV** caches host→domain and `(domain, slug)`→link for the hot path, invalidated on every write. **Analytics Engine** receives one data point per redirect. A daily **cron** rolls Analytics Engine into D1 totals and purges audit entries older than 3 years.

Runtime dependencies kept to: `hono` (routing), `jose` (Access JWT), `zod` (input validation), and later `@cloudflare/workers-oauth-provider` + `agents` (MCP stage), all already used in Hody's Workers.

## 4. Stages

Each stage ships through the usual loop: branch, Claude review, CodeRabbit, PR, merge, deploy to the dev instance, live check, vault update.

| Stage | Delivers | Live check |
|---|---|---|
| **S1 Core** | Repo, license, schema, redirect hot path, Access sign-in, links + domains API with authz, slug locks, audit log, legacy import + verify scripts, dev deploy | A test short domain redirects; dashboard API answers only through Access |
| S2 Dashboard | React SPA from the mockups: links, domains, people + audit, Ctrl+K palette, switcher, new-link form, keyboard model | Every mockup screen works against the dev API, keyboard-only |
| S3 Domain onboarding | Cloudflare API: attach same-account domains, Cloudflare for SaaS custom hostnames, status checks, approval flow, Cloudflare controls | Add an outside test domain by CNAME end to end |
| S4 Analytics | Analytics Engine writes, bot filtering, SQL API queries, daily rollups, analytics screen with filters, audit retention purge | Clicks on the test domain show up with correct splits |
| S5 Link rules | Password, country/device routing, UTM builder, QR (SVG/PNG) | Each rule verified with curl and a phone scan |
| S6 Agents + API | MCP with OAuth (read / read+write), tools, API keys, "via" audit | Connect from claude.ai and Claude Code; scopes live-tested |
| S7 People + setup | Invites (Resend), settings screens, first-run setup wizard | Fresh instance set up from zero in the wizard |
| S8 Migration + release | Import only Hody's `hody.link` links from legacy (other domains exported to an audit CSV for Hody to keep or drop first), verify every old URL, switch DNS per domain, README/docs, make repo public | Every old URL answers the same `Location` as before |

## 5. Out of scope (v1)
- Bio pages, splash pages, tracking pixels (legacy features Hody does not use).
- Billing, plans or quotas: this is self-hosted software, not a SaaS.
- Bring-your-own database; non-Cloudflare hosting.
