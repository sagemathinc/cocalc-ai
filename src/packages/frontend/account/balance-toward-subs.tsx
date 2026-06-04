import { Space, Switch, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT } from "@cocalc/util/db-schema/accounts";

const { Text } = Typography;

export function UseBalance() {
  const use_balance_toward_subscriptions = useTypedRedux(
    "account",
    "other_settings",
  )?.get("use_balance_toward_subscriptions");
  const checked =
    use_balance_toward_subscriptions ??
    USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT;

  return (
    <Space vertical>
      <Space>
        <Switch
          aria-label="Use account balance for renewals"
          checked={checked}
          onChange={(value) => {
            const actions = redux.getActions("account");
            actions.set_other_settings(
              "use_balance_toward_subscriptions",
              value,
            );
          }}
        />
        <Text strong>Use account balance for renewals</Text>
      </Space>
      <Text type="secondary">
        {checked
          ? "Renewals use your account balance only when it covers the full renewal amount; otherwise CoCalc charges your payment method in full."
          : "Renewals charge your payment method."}
      </Text>
    </Space>
  );
}
