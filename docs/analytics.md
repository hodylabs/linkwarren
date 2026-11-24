---
title: Analytics
description: Clicks over time, QR scans, countries, referrers, devices, operating systems, browsers, languages, cities, busiest times, and the weekly email.
slug: docs/analytics
---

# Analytics

linkwarren counts every visit to a live short link, without cookies and without scripts on the short link. Analytics need Workers Analytics Engine; how to set it up (the `CLICKS` binding, `AE_READ_TOKEN`, `VISITOR_SALT` and the hourly rollup) is in [deploy.md](deploy.md#analytics-optional).

## The Analytics screen

Open **Analytics** in the sidebar (`G A`).

- **Range**: 24 hours, 7, 30 or 90 days, or custom dates (up to 366 days, ending today at the latest). The 24-hour view is hourly and needs live clicks from Analytics Engine; the others are daily.
- **Filters**: one or more domains, and a link search that matches the short address (`go.example.com/spring`). A search covers at most 500 matching links, and the screen says when it was cut.
- **Chart**: clicks over time, split into QR scans and visits that were typed or clicked. It works with the keyboard (arrow keys, Home and End read each bar) and switches to a table.
- **Totals**: clicks, QR scans, typed or clicked, the change on the period before, and unique visitors when `VISITOR_SALT` is set.
- **Breakdowns**: top links, countries, referrers ("Direct, typed or saved" when there is none) and devices (mobile, tablet, desktop).
- **Detail**: operating systems, browsers, languages, cities and regions, and **When people click**, a weekday by hour table in your browser's time zone that names the busiest hour.
- **Export CSV** downloads what the screen shows.

Bots and link previews (the card a chat app shows when a link is pasted) are left out of every count.

### One link's page

Click a link in Top links, or **Open link analytics** in a link's details on the Links page, to open `/analytics/link/<id>`: the same range, chart, totals, breakdowns, detail and CSV for that link alone.

### Who sees what

People see analytics for the domains they can use. **See analytics for every domain** in a role (owners always) shows every domain. A link page opens only for someone who may see that link's domain; anyone else gets "not found".

## How long the data covers

Each click is one data point in Analytics Engine, which keeps points for three months. The hourly job copies each finished UTC day into daily totals in D1, which are kept for good.

- **Chart, totals, countries, referrers and devices** come from the daily totals for older days and from Analytics Engine for the most recent ones, so they cover any range.
- **Operating systems, browsers, languages, cities and busiest times** are read only from Analytics Engine, so they cover the last 90 days of the range at most. The page says which days they cover, and a range older than 90 days has none.

Without `AE_READ_TOKEN`, the screen shows daily totals from D1 only, and says so. Without the `CLICKS` binding nothing is recorded.

## What is recorded per click

One data point per visit to a live link (`GET` only), written after the visitor has been answered, so analytics never slow a redirect down:

- the domain, the link and its slug;
- the country, and the city as Cloudflare reports it (or the region when there is no city), for example `Toronto, CA`;
- the device (mobile, tablet, desktop or other), the operating system family (iOS, Android, Windows, macOS, Linux, ChromeOS or Other) and the browser family (Chrome, Safari, Firefox, Edge, Opera, Samsung Internet or Other);
- the first language the browser asks for, cut to two parts (for example `en-us`);
- the referring site's host name, never the full address;
- whether it was a QR scan or typed or clicked, and whether the visitor looks like a person, a bot or a link preview;
- a visitor code that changes every UTC day (only with `VISITOR_SALT`).

The visitor's IP address and user agent are read at the moment of the click to work out the visitor code and the families above, and are **never stored**. The full list of what is and is not kept is in [privacy.md](privacy.md).

## Weekly email

Each person can get a short summary of last week's clicks by email. It is off until they turn it on.

- **Turn it on** in Sign-in and security, **Weekly clicks summary**. Your browser's time zone is saved with it. The switch needs email set up on the instance (`EMAIL_FROM` and a Resend key); without it the switch is off and says why. It is part of app-mode sign-in, so it is not offered in access mode.
- **When it comes**: from 07:00 on Monday in your time zone, about the Monday to Sunday before (UTC days). The first one comes on the next Monday after you turn it on, never the same day.
- **What it says**: total clicks, QR scans against typed or clicked, the change on the week before, and your top 5 links, for exactly the links your Analytics screen shows you. Plain text and simple HTML, no images or tracking.
- **Unsubscribe**: every email has an unsubscribe link (and a one-click unsubscribe for mail apps). It needs no sign-in: it asks first, then turns the email off. Turning the email on again makes a new link, and older links stop working. You can also switch it off in Sign-in and security.

Delivery rules, for operators: the hourly job sends at most 2 emails per run, so a run that misses Monday catches up later that week. A week is never sent twice: a send that Resend refuses for good (a bad or suppressed address) is not retried until the next week; a temporary failure (Resend down, rate limited, a network error, or clicks not rolled up yet) is retried on a later run, at most 6 tries a week. The details are in [deploy.md](deploy.md#scheduled-job). The weekly email shares the Resend budget with sign-in links and invites.

## Over the API

`GET /api/v1/analytics/links` returns 7 days of daily clicks for up to 50 links ([api.md](api.md#get-analyticslinks)), and agents have `link_stats` ([mcp.md](mcp.md)). The full reports, the link page and the detail are in the dashboard only.

## Alerts

Each person can get an email when one of their links changes pace. It is off until they turn it on.

- **Turn it on** in Sign-in and security, **Link alert emails**, then pick the kinds: **Gone quiet** and **Spike** (both on by default). Like the weekly email it needs email set up on the instance and is part of app-mode sign-in, so it is not offered in access mode.
- **Gone quiet**: a link that had at least 5 clicks a day on average over days 15 to 42 before today, and no click in the last 14 days (today included). The same link is not reported as quiet again for 28 days.
- **Spike**: yesterday (UTC) had at least 20 clicks and at least 3 times the average of the 7 days before it. Each spike day is reported once.
- **Which links**: only links your Analytics screen shows you, checked again when the email is made, so a role or domain change counts at once. Only clicks on domains you can use count. Forwarding addresses and expired links are left out.
- **How often**: at most one email per person per UTC day, listing up to 10 alerts (the rest come the next day), and at most 20 alert emails per instance per day, so Resend's free 100 a day stay mostly for sign-in links and invites. Each email has a one-click unsubscribe link that turns alerts off without signing in.

For operators: alerts run on their own Cron Trigger, `45 * * * *`, apart from the hourly rollup at :15 (see [deploy.md](deploy.md#scheduled-job)). An instance set up before v0.8.0 must add it to `triggers.crons` in `wrangler.instance.jsonc`. A run reads the D1 daily totals up to the rollup mark and the newer days, yesterday included, from Analytics Engine. Without Analytics Engine reads, or when a read fails, no alert is sent: a missing day never counts as "quiet". When nobody is due the run reads nothing.

## Share page

A read-only page of one link's or one domain's clicks, for a client who has no account. It lives at `<dashboard>/share/<token>`.

- **Make one**: on the Links page, open a link and use **Share page**, **New share link**; for a domain, open it on the Domains page. The page's URL is shown once, right after it is made: copy it then, because only a hash of it is kept and it cannot be shown again. A link or domain can have up to 10 active share pages.
- **Who can**: for a link, anyone who may edit it (its creator, the domain's owner, an owner, or someone with `links.editAny`); for a domain, its owner or someone with `domains.manage`. The same people list and revoke them. Making and revoking are in the audit log as `share.create` and `share.revoke` (never the URL).
- **What it shows**: total clicks, QR scans and typed visits for the last 30 days (UTC), a daily table, and the top countries, referrers and devices. Totals only: no link lists, no recent clicks, nothing about a single visitor.
- **When it stops**: once revoked, once the link or domain is deleted, once the link moves to another domain, or once the person who made it is disabled or removed. Every one of these answers the same "not found" page.
- **Limits**: 60 views a minute per IP range; the page is cached privately for 60 seconds and sends `noindex` and no referrer.

In access mode the dashboard host sits behind Cloudflare Access, so a client cannot open the page unless the Access application has a bypass policy for the path `/share/*`, like the `/healthz` bypass in [deploy.md](deploy.md#access-mode). The token is still the only key to the page.
