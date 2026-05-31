/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const ACCOUNT_SETTINGS_BODY = String.raw`
## What account settings are for

Account settings control your identity, preferences, SSH keys, support access,
and the billing tools attached to your CoCalc account. These settings are
account-scoped, not project-scoped: changing them follows you across projects,
courses, hosts, and browsers.

## Profile and identity

Use the profile page to edit your name, email, avatar, color, and account
metadata. The avatar image is visible in collaboration surfaces, while the
account color is also used independently in realtime editing and other shared
contexts.

Keep the account id available when working with support, admin tools, browser
automation, or agent-driven workflows. It is the stable identifier, while names
and emails can change.

## SSH keys

Use account SSH keys when the same public key should be available across
projects. Project-specific SSH access and host-specific access are different
surfaces, so verify which layer you need before adding or removing keys.

## Agent notes

For account actions, prefer stable route targets such as
\`/settings/profile\` and \`/settings/keys\` instead of legacy public-doc
links. The docs action ids are \`account.profile.open\` and
\`account.ssh-keys.open\`.
`;

export const BILLING_SETTINGS_BODY = String.raw`
## What billing settings are for

Billing settings collect subscriptions, licenses, purchases, payment methods,
statements, vouchers, and store access for the signed-in account. These screens
are account-scoped. Project upgrades may affect a project, but the purchase
history and payment instruments belong to the account.

## Subscriptions and licenses

Use subscriptions to review recurring paid access. Use licenses when access is
assigned through a license object, course, team, or institution. Before changing
access, check whether the entitlement is account-wide, project-specific, or
managed by an instructor or administrator.

## Payment methods and statements

Payment methods control how future charges are paid. Statements and receipts
are the audit trail for past charges. When helping a user, open the exact billing
screen first, then inspect the relevant account, project, or license context.

## Agent notes

Billing actions should route through the in-app account settings pages:
\`billing.subscriptions.open\`, \`billing.payment-methods.open\`, and
\`billing.statements.open\`. Avoid adding new \`doc.cocalc.com\` links for
billing help; use \`/app-docs\` or an executable docs action instead.
`;
