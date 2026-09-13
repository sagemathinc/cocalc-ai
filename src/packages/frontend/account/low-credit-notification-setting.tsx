import { Checkbox, InputNumber, Space } from "antd";
import {
  useAccountOtherSetting,
  useActions,
} from "@cocalc/frontend/app-framework";
import {
  DEFAULT_LOW_CREDIT_THRESHOLD_USD,
  LOW_CREDIT_NOTIFICATIONS,
  LOW_CREDIT_THRESHOLD_USD,
} from "@cocalc/util/compute-notifications";

export function LowCreditNotificationSetting() {
  const actions = useActions("account");
  const enabled =
    useAccountOtherSetting<boolean>(LOW_CREDIT_NOTIFICATIONS) ?? false;
  const threshold =
    useAccountOtherSetting<number>(LOW_CREDIT_THRESHOLD_USD) ??
    DEFAULT_LOW_CREDIT_THRESHOLD_USD;
  return (
    <Space wrap>
      <Checkbox
        checked={enabled}
        onChange={(event) =>
          actions.set_other_settings(
            LOW_CREDIT_NOTIFICATIONS,
            event.target.checked,
          )
        }
      >
        Notify me when personal spendable credit falls below
      </Checkbox>
      <InputNumber
        aria-label="Low personal credit threshold in USD"
        prefix="$"
        min={1}
        max={1000}
        value={threshold}
        disabled={!enabled}
        onChange={(value) => {
          if (value != null)
            actions.set_other_settings(LOW_CREDIT_THRESHOLD_USD, value);
        }}
        style={{ width: 120 }}
      />
      <span>USD</span>
    </Space>
  );
}
