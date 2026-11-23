---
title: People and roles
description: Inviting people, built-in and custom roles, domain access, and signing in with email links, passkeys or Cloudflare Access.
slug: docs/people-and-roles
---

# People and roles

Everyone who uses the dashboard is a person in linkwarren's own list. Signing in only proves an email address; the list decides who gets in and what they can do. Two things decide what a person can do: their **role** (what kind of work) and their **domains** (where).

## Inviting people

On the People screen, invite someone with their email, a role (Member by default) and, optionally, the shared domains they may use. This needs **Invite and manage people** in your role. Granting shared domains on an invite also needs **Add and manage domains**.

The person is created as invited and gets an email from the instance with a link to `https://<dashboard host>/join`. They become active the first time they sign in. An invite can be sent again or withdrawn while the person has not signed in yet.

Invite emails share the Resend budget with sign-in links. linkwarren sends at most 1 invite per address per minute, 20 per hour and 40 per UTC day, so invites never take more than 40 of Resend's free 100 daily emails; sign-in links and the weekly emails use the rest. At a cap the person is still created, and the dashboard says the email was not sent; send it again later. In access mode, also add each invitee to your Cloudflare Access policy, or they cannot open the dashboard.

## Roles

A role is a set of permissions. There are two built-in roles, and owners can add up to 20 custom ones.

- **Owner**: every permission, always. Owners can do anything, including the things no other role can (the first-run setup, pasting secrets, checking the Cloudflare token, creating and editing roles). There is always at least one active owner.
- **Member**: built in and editable. By default it can create links, change many links at once, add its own private domains, create personal API keys and connect AI agents.
- **Custom roles**: owners create them on the People screen, Roles view, from these permissions:

| Permission | What it allows |
| --- | --- |
| Create links | Make short links and saved QR codes, and change or delete their own. |
| Edit anyone's links | Change or delete links other people made, on domains they can use, release slug locks, and manage everyone's saved QR codes. |
| Change many links at once | Bulk edit: select several links and edit, move or delete them together. |
| See analytics for every domain | Without it, analytics cover only the domains the person can use. |
| Add their own domains | Add private domains for themselves, which an owner or a domain manager approves. |
| Add and manage domains | Add main and shared domains, approve, turn off or reject domains, choose who can use them, and use the Cloudflare controls. |
| Invite and manage people | Invite people, change their role and access, sign them out and remove them, only up to their own permissions. |
| Personal API keys | Create API keys for scripts. |
| Connect AI agents | Connect assistants such as Claude or ChatGPT. Separate from API keys. |
| Instance settings | Name, logo, main domain, link defaults and email, the agents switch, and the Cloudflare connection settings. Saved secrets stay with owners. |
| Export and import | Download the whole instance and import links from a file. |
| Audit log | See every change made by people and agents. |

Role names are 1 to 40 characters and unique, ignoring case. A role that people still hold can be deleted only by moving them to another role in the same step. Changes to a role apply on each person's next request; nobody has to sign in again.

**Up to their own permissions.** A person who manages people but is not an owner can only act on people whose role has no permission theirs lacks, can only give out such roles, and never acts on an owner or on themselves. Only owners can make someone an owner.

## Domain access

Roles say what someone can do; domains say where. Each domain has a type:

- **main**: every person can create links on it.
- **shared**: only the people added as its members.
- **private**: its owner, and the people they add.

On the Domains screen, a domain manager (or a private domain's owner) adds and removes members. **Add and manage domains** lets a person administer every domain, but not use a shared one: to create links there they add themselves as a member, which is recorded in the audit log. Owners can use every domain. Details are in [domains.md](domains.md).

API keys and AI agents never reach more domains than their person. An API key can be narrowed to some domains when it is created.

## Signing in

`AUTH_MODE` in the config picks one of two modes for the whole instance. They never mix. See [configuration.md](configuration.md#dashboard-and-sign-in).

### App mode (the default)

linkwarren signs people in itself:

- **Email link**: enter your email, and a link arrives that works once, for 15 minutes. The form gives the same answer for every address, so it never tells which emails have accounts.
- **Passkey**: after the first email sign-in, add a passkey in Sign-in and security, up to 10 per person. A passkey signs you in on that device without an email. Passkeys belong to the dashboard host: if the dashboard moves to another host, add them again.

A session lasts 30 days from your last visit, and at most 90 days. Sign-in and security lists your sessions and passkeys, and has **Sign out everywhere**.

Limits against guessing and mail floods: 5 sign-in emails per address and 20 per network every 15 minutes, 20 failed link or passkey checks per network every 15 minutes, and 50 sign-in emails per hour for the whole instance.

### Access mode

Cloudflare Access signs people in in front of the dashboard, and linkwarren reads the verified email from the Access token. There are no email links or passkeys in this mode. Set it up as described in [deploy.md](deploy.md#access-mode). People still need to be in linkwarren's list: an Access login for an email that was never invited is refused.

## Changing, disabling and removing people

People managers (and owners) can, from the People screen:

- **Change a role.** It applies on the person's next request.
- **Disable** a person. Their sessions end, their API keys stop working, and their AI agent connections are revoked at once. Enabling them again lets them sign in again; agents must reconnect.
- **Sign them out** of every session.
- **Remove** a person. Their links and domains are handed over in the same step. When an owner removes someone, they go to that owner unless another active person is chosen (an owner, when main or shared domains are handed over). When a people manager who is not an owner removes someone, they always go to an owner: the first active owner by default, or another active owner they choose.

Everyone can see and revoke their own API keys and agent connections. A people manager can also lower or disconnect the connections and keys of the people they manage. Every change is in the audit log, which keeps entries for 3 years.
