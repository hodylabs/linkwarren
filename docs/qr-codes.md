---
title: QR codes
description: The QR code of every short link, and the QR codes screen for Wi-Fi, web addresses, text, email, phone, SMS and short links.
slug: docs/qr-codes
---

# QR codes

linkwarren makes QR codes in two places: every short link has its own, and the **QR codes** screen saves codes for anything else.

## A short link's QR code

Open a link on the Links page: its QR code is in the details, with **Download SVG** and **Download PNG** (`Q` focuses the download). The code holds the short link with `?lw=qr` added, so [analytics](analytics.md) can tell scans apart from typed visits; the marker is removed before the redirect. It always encodes the short link, never the destination, so you can change where the link goes without printing a new code. This works for [contact card links](vcards.md) too.

## The QR codes screen

Open **QR codes** in the sidebar (`G Q`) and press **New QR code**. Each code has a name, a kind, its content, colors and an error correction level, and you download it as SVG or PNG. A live preview follows the form.

| Kind | What the code holds | Limits |
| --- | --- | --- |
| Wi-Fi | Network name, security (WPA, WEP or none), whether the network is hidden, and the password. Phones join the network when they scan it. | Name at most 32 bytes, password at most 64 characters |
| Web address | A plain `http(s)` address. It is not a short link, so scans are not counted. | At most 2048 characters |
| Text | Plain text | At most 300 characters, so the code stays easy to scan from a printout |
| Email | A `mailto:` address with an optional subject and body | Subject at most 150, body at most 500 characters |
| Phone | A `tel:` number | 3 to 20 digits, with an optional leading `+` |
| SMS | A number and an optional message | Message at most 300 characters |
| Short link | Any link you can use, chosen from your links | |

A **short link** code is stored by the link's id and holds that link's own QR text, so its scans count as QR scans of the link, and the code follows the link if its address changes. If the link is deleted, the code shows as broken.

**Colors and error correction.** Pick the code and background colors. A light code on a dark background, or colors with a contrast ratio under 4.5, are refused, because many scanners cannot read them. Error correction is Low, Medium (the default), High or Highest; a higher level survives more damage but makes a denser code. There are no logos or frames.

**Who can make codes.** Anyone whose role has **Create links** makes codes and sees and edits their own. **Edit anyone's links** (owners always) sees and manages everyone's. Each person can keep at most 500 codes. Every create, change and delete is in the audit log, with the code's name and kind.

## Wi-Fi passwords

A Wi-Fi password is stored encrypted (AES-GCM with the `SECRETS_KEY` secret, see [configuration.md](configuration.md#optional-secrets)). It never appears in the list, the export, logs, errors or the audit log; only opening the code shows it, and only to someone who may edit it.

- Without `SECRETS_KEY`, a Wi-Fi code with a password cannot be saved (`409 secrets_key_missing`). Open networks work without it.
- If `SECRETS_KEY` is lost or changed, saved Wi-Fi passwords can no longer be read, and the code asks for the password again.
- When editing, leaving the password field alone keeps the saved password; clearing it removes it.

## No API for saved codes

Saved codes are managed in the dashboard only. The `/api/v1` API and the MCP tools have no QR code endpoints. A short link's own QR code needs none: it is the short link with `?lw=qr` added.
