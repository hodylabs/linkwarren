---
title: Self-hosting costs
description: What the Cloudflare Workers free plan covers for a linkwarren instance, checked against Cloudflare's own pricing and limits pages.
slug: docs/self-hosting-costs
---

# Self-hosting costs

linkwarren is built to run on the Cloudflare **Workers Free plan**. It uses no paid Workers features, and it stops itself before it would create a billed Cloudflare for SaaS hostname. You pay only for your domains, and for anything you choose to add on your Cloudflare account.

The figures below were checked against Cloudflare's pricing and limits pages on **2026-11-23**. Cloudflare changes its plans from time to time: the linked pages are the source of truth.

## The free plan, per account

Every allowance is for the whole Cloudflare account, shared with any other Workers you run there. Daily limits reset at 00:00 UTC.

### Workers

| Resource | Free allowance |
| --- | --- |
| Requests | 100,000 per day |
| CPU time | 10 ms per request |
| Subrequests | 50 per request |
| Cron Triggers | 5 per account (linkwarren uses 1) |
| Worker size | 64 MiB |
| Static asset files | 20,000 per Worker version |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### D1

| Resource | Free allowance |
| --- | --- |
| Rows read | 5 million per day |
| Rows written | 100,000 per day |
| Storage | 5 GB in total, 500 MB per database |
| Databases | 10 per account (linkwarren uses 1) |
| Queries per request | 50 |
| Time Travel (point-in-time restore) | 7 days |

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

### Workers KV

| Resource | Free allowance |
| --- | --- |
| Reads | 100,000 per day |
| Writes | 1,000 per day |
| Deletes | 1,000 per day |
| List requests | 1,000 per day |
| Stored data | 1 GB |

Source: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

### Workers Analytics Engine

| Resource | Free allowance |
| --- | --- |
| Data points written | 100,000 per day |
| Read queries | 10,000 per day |

Source: [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).

## What linkwarren spends

- **A click** is one Worker request and two KV reads (the domain and the link). When both are cached it does no D1 work. A cached entry lasts 5 minutes (a missing link 1 minute); after that the next click reads D1 once for it and writes the entry to KV again. With analytics on, each redirect also writes one Analytics Engine data point.
- **The dashboard** spends Worker requests and D1 reads and writes like any app. Its static files are served through the Worker from Workers static assets, so each one is a Worker request too.
- **The hourly job** rolls finished days of clicks from Analytics Engine into D1. It writes at most 10,000 D1 rows per run and 40,000 per UTC day, so it never takes the whole write budget.
- **Agents and API keys** are capped at 3000 calls per UTC day for the instance, about 42,000 D1 rows written at the cap.
- **Bulk edits** are capped at 500 KV deletes per UTC day, half the account's 1,000.

The exact costs per action, and why each limit is where it is, are in [deploy.md](deploy.md) (search for "Free plan").

## Where an instance hits the limits first

- **KV writes (1,000 per day).** Every cache refill, OAuth step and logo change writes KV. A link clicked all day long refills its entry about every 5 minutes, up to about 288 writes a day, and its domain's entry about as often. So a few links in constant use, or many different links and missing slugs, can use the day's writes. Redirects keep working when they are gone: the cache write is skipped and the redirect reads D1 instead (a few rows read per click, against 5 million a day).
- **Worker requests (100,000 per day).** Every click and every dashboard or API call is one request. What Cloudflare does past the limit is described on the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page; an instance with more traffic than that needs Workers Paid.
- **Resend email (100 per day on its free tier).** Not Cloudflare, but it limits sign-in links and invites. Invites take at most 40 of the 100. The opt-in [weekly email](analytics.md#weekly-email) uses the same budget, at most 2 per hourly run. See [people-and-roles.md](people-and-roles.md#inviting-people).

## Other Cloudflare charges

- **Cloudflare for SaaS** (outside domains): the first 100 custom hostnames are free and Cloudflare bills each one after that. linkwarren refuses to create one from the 95th on, so it never adds a billed hostname.
- **Rate limiting rules**: the Free plan includes one per zone. linkwarren's per-domain rate limit control uses that one.
- **Advanced certificates**: needed only for hosts two or more labels below their zone. They are a separate Cloudflare product, and linkwarren never orders one.

Anything else depends on your account's own plan and settings.

## Moving to Workers Paid

Nothing in linkwarren needs it. If you outgrow the free plan, Workers Paid lifts the daily request limit and raises the CPU, subrequest and D1 limits. linkwarren's own caps in `src/limits.ts` and `PASSWORD_HASH_ITERATIONS` are sized for the free plan; you can raise them there (see [configuration.md](configuration.md)).
