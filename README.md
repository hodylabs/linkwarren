# linkwarren

A self-hosted, multi-domain link shortener that runs entirely in your own Cloudflare account (Workers, D1, KV). One owner, many users, many domains, each domain with its own slugs.

**Status: in development.** Nothing here is ready to deploy yet. See `docs/spec.md` for the design.

linkwarren is open source software, licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).

Copyright (C) 2026 Hody LLC

The name and logo are covered by `TRADEMARK.md`. To contribute, read `CONTRIBUTING.md`.

## Features

Multi-domain slugs, link rules (schedule, password, routing), analytics, bulk edit on the Links page, moving links between domains with forwarding of the old address, an owner switch for agent access, people and invites, a first-run setup wizard (with import, `docs/import.md`), and a full JSON export (`docs/backup.md`). See `docs/spec.md`.

## Privacy

Short links set no cookies and run no scripts. What linkwarren records per click, and what it never stores, is in `docs/privacy.md`.

## Agents and API

Agents (Claude, ChatGPT, Claude Code, Codex) connect to the built-in MCP server with OAuth, and scripts use personal API keys. See `docs/agents.md`.

## Development

See `docs/development.md` for tests, the dashboard build and running the dashboard against a local Worker.
