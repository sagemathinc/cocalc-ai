/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Radio, Space, Tag, Typography } from "antd";
import { FormattedMessage, useIntl } from "react-intl";

import { Panel, Switch } from "@cocalc/frontend/antd-bootstrap";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, IconName } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EMAIL_MODES,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  normalizeNotificationPreferences,
  type NotificationCategory,
  type NotificationEmailMode,
} from "@cocalc/util/notification-preferences";

const { Text, Paragraph } = Typography;

export const COMMUNICATION_ICON_NAME: IconName = "mail";

export function AccountPreferencesCommunication(): React.JSX.Element {
  const intl = useIntl();
  const other_settings = useTypedRedux("account", "other_settings");
  const stripe_customer = useTypedRedux("account", "stripe_customer");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const email_address = useTypedRedux("account", "email_address");
  const isVerified = !!email_address_verified?.get(email_address ?? "");
  const is_stripe_customer = !!stripe_customer?.getIn([
    "subscriptions",
    "total_count",
  ]);

  function on_change(name: string, value: any): void {
    redux.getActions("account").set_other_settings(name, value);
  }

  function rawNotificationPreferences() {
    const raw = other_settings?.get?.(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
    );
    return raw?.toJS?.() ?? raw;
  }

  const notificationPreferences = normalizeNotificationPreferences(
    rawNotificationPreferences(),
  );

  function setNotificationEmailMode(
    category: NotificationCategory,
    mode: NotificationEmailMode,
  ) {
    const next = normalizeNotificationPreferences(notificationPreferences);
    next.email[category] = mode;
    on_change(OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY, next);
  }

  function toggle_global_banner(val: boolean): void {
    if (val) {
      // this must be "null", not "undefined" – otherwise the data isn't stored in the DB.
      on_change("show_global_info2", null);
    } else {
      on_change("show_global_info2", webapp_client.server_time());
    }
  }

  function render_global_banner() {
    return (
      <Switch
        checked={!other_settings.get("show_global_info2")}
        onChange={(e) => toggle_global_banner(e.target.checked)}
      >
        <FormattedMessage
          id="account.other-settings.global_banner"
          defaultMessage={`<strong>Show Announcement Banner</strong>: only shows up if there is a
        message`}
        />
      </Switch>
    );
  }

  function render_no_free_warnings() {
    const extra = is_stripe_customer ? (
      <span>(thanks for being a customer)</span>
    ) : (
      <span>(only available to customers)</span>
    );

    return (
      <Switch
        disabled={!is_stripe_customer}
        checked={!!other_settings.get("no_free_warnings")}
        onChange={(e) => on_change("no_free_warnings", e.target.checked)}
      >
        <strong>Hide free warnings</strong>: do{" "}
        <strong>
          <i>not</i>
        </strong>{" "}
        show a warning banner when using a free trial project {extra}
      </Switch>
    );
  }

  function render_notification_email_preferences() {
    const hasEmailDelivery = NOTIFICATION_CATEGORIES.some(
      (category) => notificationPreferences.email[category.key] !== "off",
    );
    return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <Text strong>Notification email</Text>
          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Choose which notifications are emailed immediately, included in a
            daily digest, or kept in CoCalc only.
          </Paragraph>
        </div>
        {!isVerified && hasEmailDelivery && (
          <Alert
            type="warning"
            showIcon
            message="Verify your email address to receive notification email."
          />
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "minmax(180px, 0.7fr) minmax(260px, 1fr) minmax(300px, 1fr)",
            gap: 12,
            alignItems: "center",
          }}
        >
          <Text strong>Category</Text>
          <Text strong>What it includes</Text>
          <Text strong>Email delivery</Text>
          {NOTIFICATION_CATEGORIES.map((category) => (
            <NotificationPreferenceRow
              key={category.key}
              category={category}
              mode={notificationPreferences.email[category.key]}
              onChange={(mode) => setNotificationEmailMode(category.key, mode)}
            />
          ))}
        </div>
      </Space>
    );
  }

  return (
    <Panel
      size="small"
      header={
        <>
          <Icon name={COMMUNICATION_ICON_NAME} />{" "}
          {intl.formatMessage(labels.communication)}
        </>
      }
    >
      {render_notification_email_preferences()}
      <div style={{ marginTop: 16 }} />
      {render_global_banner()}
      {render_no_free_warnings()}
    </Panel>
  );
}

function NotificationPreferenceRow({
  category,
  mode,
  onChange,
}: {
  category: (typeof NOTIFICATION_CATEGORIES)[number];
  mode: NotificationEmailMode;
  onChange: (mode: NotificationEmailMode) => void;
}) {
  return (
    <>
      <Space direction="vertical" size={0}>
        <Text>{category.label}</Text>
        {category.requiredEmailMode && (
          <Tag color="blue">Required immediate email</Tag>
        )}
      </Space>
      <Text type="secondary">{category.description}</Text>
      {category.requiredEmailMode ? (
        <Text>Immediate</Text>
      ) : (
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          value={mode}
          onChange={(e) => onChange(e.target.value)}
          options={NOTIFICATION_EMAIL_MODES.map(({ key, label }) => ({
            value: key,
            label,
          }))}
        />
      )}
    </>
  );
}
