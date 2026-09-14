/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const ACCOUNT_SETTINGS_BODY = String.raw`
## What account settings are for

Account settings control your identity, preferences, API keys, SSH keys,
support access, and the billing tools attached to your CoCalc account. Most
apply across your projects, but some preferences are stored only in the current
browser. For example, **Startup performance** and activity-bar labels are
browser-local. Check a setting's description before expecting it to follow you
to another browser.

## Profile and identity

Use **Profile** to edit your name, email, avatar, and color. Your account id
and creation time are shown for reference. The avatar image is visible in
collaboration surfaces, while the account color is also used independently in
realtime editing and other shared contexts.

Keep the account id available when working with support, admin tools, browser
automation, or agent-driven workflows. It is the stable identifier, while names
and emails can change.

## API and SSH keys

Use **Preferences -> API & SSH Keys** when managing account API keys or when the
same SSH public key should be available across projects. Project-specific SSH
access and host-specific access are different surfaces, so verify which layer
you need before adding or removing keys.

## Agent notes

For account actions, prefer stable route targets such as
\`/settings/profile\` and \`/settings/keys\` instead of legacy public-doc
links. The docs action ids are \`account.profile.open\` and
\`account.ssh-keys.open\`.
`;

export const TWO_FACTOR_AUTHENTICATION_BODY = String.raw`
## Where to configure CoCalc two-factor authentication

Open **Account Settings -> Profile -> Security**. The direct route is
[the Security section of your profile settings](/settings/profile#security).

The Security section contains CoCalc's own two-factor authentication controls.
This is separate from the two-factor authentication that may protect your
Google, GitHub, Microsoft, university, or institutional sign-in account.

## What you can configure

CoCalc supports two second-factor methods:

| Method | What it is | When to use it |
| :-- | :-- | :-- |
| Authenticator app codes | A rotating 6-digit code from an app such as Google Authenticator, 1Password, Authy, Microsoft Authenticator, or another TOTP app. | Use this when you want a portable method that works across browsers and devices. |
| Passkeys | WebAuthn credentials backed by your browser, operating system, hardware security key, phone, or password manager. | Use this when you want phishing-resistant approval that is much less tedious than typing a 6-digit code: approve with a device prompt, fingerprint, face unlock, PIN, or hardware key. |

You may configure either method, or both, and you may have multiple passkeys.
Having both is useful: a passkey is fast, phishing-resistant, and avoids
repeatedly finding and typing short-lived codes, while an authenticator app
gives you a broadly compatible fallback.

## How CoCalc uses fresh authentication

CoCalc does not only ask whether you signed in sometime recently. For sensitive
operations, it asks you to prove that the person at the browser right now is
still the account owner.

| Check | What CoCalc checks | Typical examples |
| :-- | :-- | :-- |
| CoCalc 2FA enrollment | You have an active CoCalc authenticator app or passkey. | Creating billable dedicated hosts requires this alongside a fresh session and the applicable membership and funding checks. |
| Normal fresh auth | You recently re-entered a password, completed an approved sign-in flow, or otherwise refreshed the current browser session. | Changing account profile details, changing password or email settings, adding credentials, confirming account-level changes, or creating billable dedicated hosts. |
| Two-factor fresh auth | You recently approved a CoCalc second factor, such as a 6-digit authenticator code or a passkey prompt. | Deleting a project host or changing its SSH authorized keys, and other actions that explicitly require recent second-factor verification. |
| Sign-in 2FA | When your account has CoCalc 2FA enabled, sign-in may require one of your configured CoCalc second factors. | Signing in from a new browser, after a session expires, or after CoCalc decides the sign-in needs a stronger check. |

The exact prompts depend on the action, account state, site policy, and browser
session. Enabling a factor and approving it recently are different checks. When
you need to refresh a session and have CoCalc 2FA enabled, the verification
dialog uses your configured second factor. Some actions also explicitly require
recent CoCalc second-factor approval.

## Why Google SSO 2FA is not enough for every CoCalc action

If you sign in with Google and your Google account has two-factor
authentication enabled, that protects the Google sign-in step. It does not prove
that you completed a second factor moments before a dangerous CoCalc action.

For example, you may have completed Google 2FA days or weeks ago, then kept a
browser session open. That is normal and convenient for everyday work, but it is
not strong enough for actions such as:

| Action category | Why account verification matters |
| :-- | :-- |
| Dedicated hosts | Creating billable hosts requires native CoCalc 2FA enrollment and a fresh session. Deleting a host or changing its SSH access requires recent CoCalc second-factor verification. |
| Security recovery | Disabling 2FA, changing credentials, or approving sensitive support actions can lock users out or weaken account protection. |
| Administrative actions | Site administration and billing operations can affect many users, projects, or costs. |
| Destructive changes | Some project, host, or account operations are difficult or impossible to undo safely. |

Google sign-in and CoCalc second-factor checks serve different purposes. A
Google 2FA setting does not enroll an authenticator app or passkey with CoCalc
and does not satisfy an action that explicitly requires recent CoCalc
second-factor verification. Complete the CoCalc prompt when it appears.

## If CoCalc says two-factor authentication is required

When you see a message such as **Enable two-factor authentication to create
dedicated hosts**, configure CoCalc 2FA in the
[Security section of profile settings](/settings/profile#security). After adding
an authenticator app or passkey, return to the host page and try the action
again.

If your university or Google account already has 2FA, keep it enabled. The
host-creation message asks you to enable a CoCalc-managed factor for this
account. A separate fresh-auth prompt may also be required before the action
can proceed.

## Recommended setup

1. Open [Account Settings -> Profile -> Security](/settings/profile#security).
2. Add a passkey if your browser or password manager supports it.
3. Add an authenticator app as a backup method.
4. Save any recovery codes shown during setup in a safe place.
5. Return to the action that required 2FA, such as **Create Host**.

For support replies, it is usually enough to say: "Please enable CoCalc 2FA in
Account Settings -> Profile -> Security, then retry creating the dedicated host
and complete any fresh-auth prompt. Your Google 2FA protects Google sign-in;
it does not enable a CoCalc second factor. Some other host actions also require
recent approval with that CoCalc factor."
`;

export const BILLING_SETTINGS_BODY = String.raw`
## What billing settings are for

Billing settings collect licenses, purchases, payment methods, statements,
and store access for the signed-in account. These screens are
account-scoped. Purchased membership tiers and dedicated project hosts may
change how projects run, but the purchase history and payment instruments
belong to the account.

## Membership and licenses

Use Membership settings to review recurring paid personal access. Use licenses
when access is assigned through a license object, course, team, or institution.
Before changing access, check whether the entitlement is account-wide,
project-specific, or managed by an instructor or administrator.

## Payment methods and statements

Payment methods control how future charges are paid. Statements and receipts
are the audit trail for past charges. When helping a user, open the exact billing
screen first, then inspect the relevant account, project, or license context.

## Agent notes

Billing actions should route through the in-app account settings pages:
\`account.membership.open\`, \`billing.payment-methods.open\`, and
\`billing.statements.open\`. Avoid adding new \`doc.cocalc.com\` links for
billing help; use \`/app-docs\` or an executable docs action instead.
`;
