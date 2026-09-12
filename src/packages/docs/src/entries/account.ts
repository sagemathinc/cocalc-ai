/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  ACCOUNT_SETTINGS_BODY,
  BILLING_SETTINGS_BODY,
  TWO_FACTOR_AUTHENTICATION_BODY,
} from "../content/account";

export const ACCOUNT_ENTRIES: DocsEntry[] = [
  {
    actions: [
      {
        description: "Open Account Settings -> Profile.",
        executable: true,
        id: "account.profile.open",
        label: "Open profile settings",
      },
      {
        description: "Open Account Settings -> Preferences -> API & SSH Keys.",
        executable: true,
        id: "account.ssh-keys.open",
        label: "Open API & SSH keys",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: ACCOUNT_SETTINGS_BODY.trim(),
    category: "Account and billing",
    id: "account.settings",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "Account identity and SSH key settings connected to collaboration tools",
    ),
    lastReviewed: "2026-05-31",
    slug: "account/settings",
    status: "ready",
    summary:
      "Manage profile, identity, account metadata, preferences, API keys, and SSH keys.",
    title: "Manage account settings",
    visibility: "signed-in",
  },
  {
    actions: [
      {
        description: "Open Account Settings -> Profile -> Security.",
        executable: true,
        id: "account.security.open",
        label: "Open security settings",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TWO_FACTOR_AUTHENTICATION_BODY.trim(),
    category: "Account and billing",
    id: "account.two-factor-authentication",
    image: docsIcon(
      "/public/docs/two-factor-authentication.svg",
      "CoCalc security flow with Google sign-in, authenticator codes, passkeys, and fresh 2FA checks",
    ),
    lastReviewed: "2026-07-09",
    searchKeywords:
      "two-factor authentication 2fa mfa passkey passkeys authenticator app totp google sso fresh auth dedicated hosts create host computer server security",
    slug: "account/two-factor-authentication",
    status: "ready",
    summary:
      "Configure CoCalc 2FA with authenticator codes or passkeys, and understand why it is separate from Google SSO 2FA.",
    title: "Set up two-factor authentication",
    visibility: "signed-in",
  },
  {
    actions: [
      {
        description: "Open Account Settings -> Membership.",
        executable: true,
        id: "account.membership.open",
        label: "Open membership",
      },
      {
        description: "Open Account Settings -> Payment Methods.",
        executable: true,
        id: "billing.payment-methods.open",
        label: "Open payment methods",
      },
      {
        description: "Open Account Settings -> Statements.",
        executable: true,
        id: "billing.statements.open",
        label: "Open statements",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: BILLING_SETTINGS_BODY.trim(),
    category: "Account and billing",
    id: "billing.settings",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "Billing settings with membership, payment methods, and statements",
    ),
    lastReviewed: "2026-05-31",
    slug: "billing/settings",
    status: "ready",
    summary:
      "Review membership, licenses, payment methods, purchases, and statements.",
    title: "Manage billing settings",
    visibility: "signed-in",
  },
];
