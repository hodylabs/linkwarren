# linkwarren

A self-hosted, multi-domain link shortener that runs entirely in your own Cloudflare account (Workers, D1, KV). One owner, many users, many domains, each domain with its own slugs.

**Status: in development.** Nothing here is ready to deploy yet. See `docs/spec.md` for the design.

linkwarren is open source software, licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).

Copyright (C) 2026 Hody LLC

The name and logo are covered by `TRADEMARK.md`. To contribute, read `CONTRIBUTING.md`.

## Features

Multi-domain slugs, an optional name per link to find it by (searched with the slug and destination), link rules (schedule, password, routing), contact card (vCard) links that download a contact with an optional photo, analytics (an overview and a page per link with countries, referrers, devices, operating systems, browsers, languages, cities and the busiest hours, plus an opt-in weekly email summary), bulk edit on the Links page, a QR code generator (Wi-Fi, web address, text, email, phone, SMS and short links, with colors), moving links between domains with forwarding of the old address, an owner switch for agent access, people and invites, a first-run setup wizard (with import, `docs/import.md`), and a full JSON export (`docs/backup.md`). See `docs/spec.md`.

## Deploying

The dashboard runs on its own host (for example `dash.example.com`) or at a path on the main short domain (for example `example.com/dashboard`). See [docs/deploy.md](docs/deploy.md).

## Privacy

Short links set no cookies and run no scripts. What linkwarren records per click, and what it never stores, is in `docs/privacy.md`.

## Agents and API

Agents (Claude, ChatGPT, Claude Code, Codex) connect to the built-in MCP server with OAuth, and scripts use personal API keys. See `docs/agents.md`.

## Development

See `docs/development.md` for tests, the dashboard build and running the dashboard against a local Worker.
