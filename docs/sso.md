---
title: Google, GitHub and single sign-on
description: Let people sign in with Google, GitHub or your own OpenID Connect provider (Okta, Authentik, Google), with domain auto-join and enforced single sign-on.
slug: docs/sso
---

# Google, GitHub and single sign-on

In app mode (`AUTH_MODE=app`, the default) an owner can add three sign-in buttons next to the email form: **Google**, **GitHub** and one **single sign-on** button for any OpenID Connect (OIDC) provider. Access mode does not use them: there, Cloudflare Access signs people in, and it is also the way to use SAML.

## How it works

- **Invite-only.** A sign-in is accepted only when the provider's **verified** email belongs to someone already in [People](people-and-roles.md), or to an email domain with auto-join on (below). Anyone else sees "not invited".
- **Linked after the first sign-in.** The first time, the person is found by email and the provider account is linked to them. From then on they are found by the provider's own account id, never by the email alone, so changing an email at the provider cannot take over someone else's account. A person can have one linked account per provider, and can see and unlink them in Sign-in and security.
- **Verified emails only.** Google and OIDC must send `email_verified: true` in the ID token; a missing claim counts as not verified. GitHub uses the account's primary email, and only when GitHub has verified it.
- **Names.** When the person has no name in linkwarren yet, the provider's name fills it (the `name` claim of the ID token, or the GitHub profile name). A name that is already set is never changed. A name that is empty after hidden characters are removed is ignored, and a longer one is cut to 40 characters; neither stops the sign-in.
- **Secrets stay secret.** Client secrets are stored encrypted (or set as Worker secrets) and are never shown again or written to the audit log.

## Turning a provider on

Settings, Sign-in shows a card per provider with its exact **redirect URI** and a copy button. Every provider needs that URI registered exactly as shown:

| Mode | Redirect URI |
| --- | --- |
| Host mode | `https://<DASHBOARD_HOST>/auth/sso/<provider>/callback` |
| Path mode | `https://<DASHBOARD_HOST><DASHBOARD_PATH>/auth/sso/<provider>/callback` |

`<provider>` is `google`, `github` or `oidc`. For example `https://links.example.com/auth/sso/google/callback`, or `https://example.com/dashboard/auth/sso/oidc/callback` in path mode.

Then paste the client ID and client secret, and switch the provider on. Pasting a secret needs `SECRETS_KEY` (see [configuration.md](configuration.md#optional-secrets)); without it, set `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` or `OIDC_CLIENT_SECRET` as Worker secrets. Only owners change provider settings. Saving an empty secret removes it.

A button shows on the sign-in page only when its provider is switched on and has a client ID and a secret (and, for single sign-on, an issuer).

### Google

1. In the Google Cloud console, open **Google Auth Platform** (APIs and services, OAuth consent screen in older menus) and set up the app. linkwarren asks for the `openid`, `email` and `profile` scopes: `profile` gives the person's name, used only when they have none in linkwarren yet.
2. Pick the audience. **Internal** lets everyone in your Google Workspace sign in. **External** starts in testing mode, where only the test users you list can sign in; anyone else gets a Google error page before linkwarren is reached. Add your people as test users, or publish the app to let any Google account through (linkwarren still accepts only invited people).
3. Under **Clients**, create a client of type **Web application** and add the Google redirect URI from Settings, Sign-in under **Authorized redirect URIs**.
4. Paste the client ID and secret in the Google card and switch it on.

### GitHub

1. In GitHub, open Settings, Developer settings, **OAuth Apps**, New OAuth App (an organization can own it too).
2. Set **Authorization callback URL** to the GitHub redirect URI from Settings, Sign-in. The homepage URL can be your dashboard address.
3. Generate a client secret, paste both values in the GitHub card and switch it on.

linkwarren asks for `read:user` and `user:email`, and reads the account id, the verified primary email and the profile name (used only to fill an empty name).

### Single sign-on (OIDC)

The single sign-on card takes an **issuer URL**, a client ID, a client secret and the button text ("Single sign-on" unless you change it). The issuer must be `https`, without a query or fragment. linkwarren reads `<issuer>/.well-known/openid-configuration` when you save: the document's `issuer` must equal what you typed exactly, and every endpoint must be `https`, or the save is refused with "discovery failed". Sign-in uses the authorization code flow with PKCE, a `state` and a `nonce`, and checks the ID token's signature (RS256 or ES256) against the provider's keys.

Changing the issuer unlinks every single sign-on account, because account ids from a different provider are a different set. People link again on their next sign-in.

**Okta.** Create an app integration of type OIDC, Web Application. Add the `oidc` redirect URI as a sign-in redirect URI and assign the people or groups. The issuer is your authorization server, for example `https://example.okta.com/oauth2/default`, or `https://example.okta.com` for the org server. Okta sends `email_verified` with the `email` scope.

**Authentik.** Create an OAuth2/OpenID provider (confidential client) with the `oidc` redirect URI, and an application that uses it. The issuer is shown on the provider page, for example `https://auth.example.com/application/o/linkwarren/`, with the trailing slash. The provider must return `email_verified: true` for the `email` scope: check its email scope mapping, and if it returns false, add a scope mapping that returns true for addresses you trust.

**Google as an OIDC provider.** Use `https://accounts.google.com` as the issuer, with a Google web client as described above, but registered with the `oidc` redirect URI. This is useful for testing single sign-on, or to enforce Google Workspace sign-in for a domain.

**Microsoft Entra ID.** Entra ID does not send the `email_verified` claim in ID tokens, so linkwarren refuses its sign-ins as unverified. Until that changes, sign people in with email links or passkeys, or put Cloudflare Access with Entra ID in front of the dashboard (access mode).

## Email domains

Below the provider cards, the email domain list (at most 50 domains) sets two things per domain, for example `example.com`:

- **Auto-join role.** A person whose verified email is at this domain, and who is not in People yet, is added on their first provider sign-in with this role. Owner is never allowed. Deleting the role turns auto-join off for that domain.
- **Enforce single sign-on.** People at this domain can then only use the single sign-on button: email links, passkeys, Google and GitHub are refused with "sign in with single sign-on". **Owners are never blocked**, so a broken single sign-on setup cannot lock you out. The rule is checked at sign-in; sessions that already exist keep working. People at an enforced domain cannot unlink their single sign-on account.

Only owners change the list. People with the Settings permission can see the whole page, but every change on it is for owners only: whoever controls the single sign-on issuer or the domain rules could otherwise sign in as someone else.

## Errors on the sign-in page

A failed provider sign-in returns to the sign-in page with one of these codes, never the provider's own message:

| Code | Meaning |
| --- | --- |
| `sso_failed` | The sign-in could not be completed: cancelled at the provider, expired (sign-ins must finish within 10 minutes), used twice, or the provider's answer did not check out. Start again. |
| `not_invited` | No one in People has this verified email, and its domain has no auto-join. |
| `disabled` | The person is disabled. |
| `sso_required` | The person's email domain enforces single sign-on: use the single sign-on button. |
| `email_unverified` | The provider did not confirm the email address. |
| `too_many` | Too many failed sign-ins from this network; wait 15 minutes. |

## Audit log

Each provider sign-in records `signin.sso` (the provider, and whether the person was added by auto-join) next to the usual sign-in entry. Changes to provider settings record `sso.settings` with the names of the changed fields, never their values. The email domain list records `email_domain.set` and `email_domain.delete`, and unlinking an account records `identity.unlink`.

What is stored about linked accounts is in [privacy.md](privacy.md#people-and-email).
