import { Alert, Space } from "antd";
import { useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import Balance from "./balance";
import LegacyBillingMigrationStatus from "./legacy-billing-migration-status";

export const BALANCE_SETTINGS_PAGE = {
  component: BalancePage,
  description: defineMessage({
    id: "account.settings.overview.balance",
    defaultMessage:
      "View account credit, add funds, and configure automatic deposits.",
  }),
  icon: "line-chart",
  key: "balance",
  label: labels.balance,
} satisfies SettingsPageDefinition;

export default function BalancePage() {
  const [error, setError] = useState<string>("");

  const refresh = async () => {
    try {
      setError("");
      await webapp_client.purchases_client.getBalance();
    } catch (err) {
      setError(`${err}`);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <Space vertical size="middle" style={{ width: "100%" }}>
      {error ? <Alert type="error" message={error} /> : null}
      <LegacyBillingMigrationStatus />
      <Balance refresh={refresh} />
    </Space>
  );
}
