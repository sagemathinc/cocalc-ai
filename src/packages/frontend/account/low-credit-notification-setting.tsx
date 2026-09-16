import { Checkbox, InputNumber, Space } from "antd";
import {
  useAccountOtherSetting,
  useActions,
} from "@cocalc/frontend/app-framework";
import {
  DEFAULT_LOW_CREDIT_THRESHOLD_USD,
  LOW_CREDIT_NOTIFICATIONS,
  LOW_CREDIT_THRESHOLD_USD,
  LOW_COURSE_CREDIT_NOTIFICATIONS,
  LOW_COURSE_CREDIT_THRESHOLD_USD,
} from "@cocalc/util/compute-notifications";

export function LowCreditNotificationSetting() {
  return (
    <section aria-label="Credit reminders">
      <Space direction="vertical">
        <CreditReminder source="personal" />
        <CreditReminder source="course" />
      </Space>
    </section>
  );
}

function CreditReminder({ source }: { source: "personal" | "course" }) {
  const actions = useActions("account");
  const enabledKey =
    source === "course"
      ? LOW_COURSE_CREDIT_NOTIFICATIONS
      : LOW_CREDIT_NOTIFICATIONS;
  const thresholdKey =
    source === "course"
      ? LOW_COURSE_CREDIT_THRESHOLD_USD
      : LOW_CREDIT_THRESHOLD_USD;
  const enabled = useAccountOtherSetting<boolean>(enabledKey) ?? false;
  const threshold =
    useAccountOtherSetting<number>(thresholdKey) ??
    DEFAULT_LOW_CREDIT_THRESHOLD_USD;
  return (
    <Space wrap>
      <Checkbox
        checked={enabled}
        onChange={(event) =>
          actions.set_other_settings(enabledKey, event.target.checked)
        }
      >
        {source === "course"
          ? "Notify me when available course credit falls below"
          : "Notify me when personal spendable credit falls below"}
      </Checkbox>
      <InputNumber
        aria-label={`Low ${source} credit threshold in USD`}
        prefix="$"
        min={1}
        max={1000}
        value={threshold}
        disabled={!enabled}
        onChange={(value) => {
          if (value != null) actions.set_other_settings(thresholdKey, value);
        }}
        style={{ width: 120 }}
      />
      <span>USD</span>
    </Space>
  );
}
