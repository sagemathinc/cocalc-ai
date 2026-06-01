/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lite } from "@cocalc/frontend/lite";
import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";
import ApiKeys from "./settings/api-keys";
import GlobalSSHKeys from "./ssh-keys/global-ssh-keys";

import type { SettingsPageDefinition } from "./settings-page";

export const ACCOUNT_PREFERENCES_SECURITY_PAGE = {
  component: AccountPreferencesSecurity,
  description: defineMessage({
    id: "account.settings.overview.keys",
    defaultMessage: "Manage API keys and setup SSH keys.",
  }),
  icon: "key",
  key: "keys",
  label: labels.ssh_and_api_keys,
} satisfies SettingsPageDefinition;

export function AccountPreferencesSecurity() {
  return (
    <>
      {!lite && <GlobalSSHKeys />}
      <ApiKeys />
    </>
  );
}
