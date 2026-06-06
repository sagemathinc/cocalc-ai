/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import { defineMessage } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { BlobCleanupButton } from "@cocalc/frontend/blobs/cleanup-button";
import { labels } from "@cocalc/frontend/i18n";
import { lite } from "@cocalc/frontend/lite";
import { OtherSettings } from "./other-settings";
import type { SettingsPageDefinition } from "./settings-page";

export const ACCOUNT_PREFERENCES_OTHER_PAGE = {
  component: AccountPreferencesOther,
  description: defineMessage({
    id: "account.settings.overview.other",
    defaultMessage: "Miscellaneous settings and options.",
  }),
  icon: "gear",
  key: "other",
  label: labels.other,
} satisfies SettingsPageDefinition;

export function AccountPreferencesOther() {
  const other_settings = useTypedRedux("account", "other_settings");
  const stripe_customer = useTypedRedux("account", "stripe_customer");

  return (
    <Space vertical size={16} style={{ width: "100%" }}>
      <OtherSettings
        other_settings={other_settings}
        is_stripe_customer={
          !!stripe_customer?.getIn(["subscriptions", "total_count"])
        }
        mode="other"
      />
      {!lite && <BlobCleanupButton mode="account" />}
    </Space>
  );
}
