/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { BlobCleanupButton } from "@cocalc/frontend/blobs/cleanup-button";
import { lite } from "@cocalc/frontend/lite";
import { OtherSettings, OTHER_ICON_NAME } from "./other-settings";

// Re-export the icon constant for account preferences section
export { OTHER_ICON_NAME };

export function AccountPreferencesOther() {
  const other_settings = useTypedRedux("account", "other_settings");
  const stripe_customer = useTypedRedux("account", "stripe_customer");
  const kucalc = useTypedRedux("customize", "kucalc");

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <OtherSettings
        other_settings={other_settings}
        is_stripe_customer={
          !!stripe_customer?.getIn(["subscriptions", "total_count"])
        }
        kucalc={kucalc}
        mode="other"
      />
      {!lite && <BlobCleanupButton mode="account" />}
    </Space>
  );
}
