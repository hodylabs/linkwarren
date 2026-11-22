# Privacy

This page describes what a linkwarren instance records when someone opens a short link. It applies to every instance that turns on click analytics (see [deploy.md](deploy.md), "Analytics"). Without analytics configured, nothing is recorded per click.

## What is recorded per click

Each redirect to a live link records one data point with:

- the domain and the link (its id and slug)
- the country code, as Cloudflare reports it
- the device class: mobile, tablet, desktop or other
- the referrer host only (for example `example.com`), never the full referring address
- whether the visit came from a QR code or was typed or clicked
- whether the visitor looks like a person, a bot, or a chat-app link preview
- a visitor code that changes every UTC day

The visitor code is a keyed hash of the day, the IP address and the user agent, cut to 16 hex characters. The key is a secret salt of the instance: without it the code cannot be turned back into an IP address. Because the day is part of the hash, the same person gets a different code the next day, so visits cannot be linked across days. Unique visitors are therefore counted per link per UTC day: a person who opens two links, or comes back tomorrow, counts again.

Bots and chat-app link previews are recorded the same way as people, as raw points kept for 90 days, but marked as bots or previews. They are left out of the click and visitor counts for people, so previews in chat apps do not inflate them.

## What is never stored

- IP addresses
- full user agents
- full referrer URLs
- cookies
- any identifier that lasts beyond a day

Short links set no cookies and run no scripts: a visitor gets a plain redirect.

## How long data is kept

- Raw click points live 90 days in Cloudflare Workers Analytics Engine, then the platform removes them.
- Daily totals stay in the instance's D1 database until the instance is deleted.
- The audit log of dashboard changes is kept for 3 years.

Everything stays in the Cloudflare account that runs the instance. linkwarren sends no data anywhere else.
