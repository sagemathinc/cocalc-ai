/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { SettingsPageType } from "@cocalc/util/types/settings";

import { ACCOUNT_PREFERENCES_AI_PAGE } from "./account-preferences-ai";
import { ACCOUNT_PREFERENCES_APPEARANCE_PAGE } from "./account-preferences-appearance";
import { ACCOUNT_PREFERENCES_COMMUNICATION_PAGE } from "./account-preferences-communication";
import { ACCOUNT_PREFERENCES_EDITOR_PAGE } from "./account-preferences-editor";
import { ACCOUNT_PREFERENCES_KEYBOARD_PAGE } from "./account-preferences-keyboard";
import { ACCOUNT_PREFERENCES_OTHER_PAGE } from "./account-preferences-other";
import { ACCOUNT_PREFERENCES_PROFILE_PAGE } from "./account-preferences-profile";
import { ACCOUNT_PREFERENCES_SECURITY_PAGE } from "./account-preferences-security";
import {
  SITE_LICENSES_SETTINGS_PAGE,
  SOFTWARE_LICENSES_SETTINGS_PAGE,
  TEAM_LICENSES_SETTINGS_PAGE,
} from "./licenses/licenses-page";
import { MEMBERSHIP_SETTINGS_PAGE } from "./membership-page";
import { PAYMENT_METHODS_SETTINGS_PAGE } from "@cocalc/frontend/purchases/payment-methods-page";
import { PAYMENTS_SETTINGS_PAGE } from "@cocalc/frontend/purchases/payments-page";
import { PURCHASES_SETTINGS_PAGE } from "@cocalc/frontend/purchases/purchases-page";
import { STATEMENTS_SETTINGS_PAGE } from "@cocalc/frontend/purchases/statements-page";
import { STORE_SETTINGS_PAGE } from "@cocalc/frontend/store/store-page";
import { USAGE_LIMITS_SETTINGS_PAGE } from "./usage-limits-page";
import { VOUCHER_CENTER_SETTINGS_PAGE } from "@cocalc/frontend/store/voucher-center-page";
import { SUPPORT_TICKETS_SETTINGS_PAGE } from "@cocalc/frontend/support/tickets";
import type { SettingsPageDefinition } from "./settings-page";

type RegisteredSettingsPageType = Exclude<SettingsPageType, "index">;

export const SETTINGS_PAGE_DEFINITIONS = {
  ai: ACCOUNT_PREFERENCES_AI_PAGE,
  appearance: ACCOUNT_PREFERENCES_APPEARANCE_PAGE,
  communication: ACCOUNT_PREFERENCES_COMMUNICATION_PAGE,
  editor: ACCOUNT_PREFERENCES_EDITOR_PAGE,
  keyboard: ACCOUNT_PREFERENCES_KEYBOARD_PAGE,
  keys: ACCOUNT_PREFERENCES_SECURITY_PAGE,
  membership: MEMBERSHIP_SETTINGS_PAGE,
  other: ACCOUNT_PREFERENCES_OTHER_PAGE,
  "payment-methods": PAYMENT_METHODS_SETTINGS_PAGE,
  payments: PAYMENTS_SETTINGS_PAGE,
  profile: ACCOUNT_PREFERENCES_PROFILE_PAGE,
  purchases: PURCHASES_SETTINGS_PAGE,
  statements: STATEMENTS_SETTINGS_PAGE,
  store: STORE_SETTINGS_PAGE,
  "team-licenses": TEAM_LICENSES_SETTINGS_PAGE,
  support: SUPPORT_TICKETS_SETTINGS_PAGE,
  "site-licenses": SITE_LICENSES_SETTINGS_PAGE,
  "software-licenses": SOFTWARE_LICENSES_SETTINGS_PAGE,
  "usage-limits": USAGE_LIMITS_SETTINGS_PAGE,
  vouchers: VOUCHER_CENTER_SETTINGS_PAGE,
} satisfies Record<RegisteredSettingsPageType, SettingsPageDefinition>;

export type RegisteredSettingsPage = keyof typeof SETTINGS_PAGE_DEFINITIONS;

export function getRegisteredSettingsPageDefinition(
  page: SettingsPageType,
): SettingsPageDefinition | undefined {
  return page === "index"
    ? undefined
    : SETTINGS_PAGE_DEFINITIONS[page as RegisteredSettingsPage];
}
