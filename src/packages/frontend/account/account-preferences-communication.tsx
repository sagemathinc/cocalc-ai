/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { BellOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Space, Switch, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { defineMessage } from "react-intl";

import { React, redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import {
  buildMarketingEmailConsentRecord,
  MARKETING_CONSENT_OTHER_SETTINGS_KEY,
  MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EMAIL_MODES,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY,
  notificationModeSendsEmail,
  normalizeNotificationPreferences,
  normalizeNotificationPreferencesV2,
  type CodexNotificationEventClass,
  type NotificationEmailStrategy,
  type NotificationCategory,
  type NotificationEmailMode,
} from "@cocalc/util/notification-preferences";
import { CookieConsentSettings } from "./cookie-consent-settings";
import { SettingsCard } from "./settings-card";
import type { SettingsPageDefinition } from "./settings-page";

type NotificationCategoryRow = (typeof NOTIFICATION_CATEGORIES)[number];
const { Text } = Typography;

const CODEX_EVENT_ROWS: Array<{
  key: CodexNotificationEventClass;
  label: string;
}> = [
  { key: "attention", label: "Needs attention" },
  { key: "completion", label: "Turn completed" },
  { key: "terminal_failure", label: "Turn failed" },
];

const CODEX_EMAIL_OPTIONS: Array<{
  value: NotificationEmailStrategy;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "immediate", label: "Immediately" },
  { value: "digest", label: "Daily digest" },
  { value: "unresolved_after_delay", label: "After 5 minutes unresolved" },
];

export const ACCOUNT_PREFERENCES_COMMUNICATION_PAGE = {
  component: AccountPreferencesCommunication,
  description: defineMessage({
    id: "account.settings.overview.communication",
    defaultMessage: "Notification preferences and communication settings.",
  }),
  icon: "mail",
  key: "communication",
  label: labels.communication,
} satisfies SettingsPageDefinition;

export function AccountPreferencesCommunication(): React.JSX.Element {
  const other_settings = useTypedRedux("account", "other_settings");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const email_address = useTypedRedux("account", "email_address");
  const isVerified = !!email_address_verified?.get(email_address ?? "");
  const [browserPermission, setBrowserPermission] = React.useState<
    NotificationPermission | "unsupported"
  >(() =>
    typeof window === "undefined" || !("Notification" in window)
      ? "unsupported"
      : window.Notification.permission,
  );

  function on_change(name: string, value: any): void {
    redux.getActions("account").set_other_settings(name, value);
  }

  function rawNotificationPreferences() {
    const raw = other_settings?.get?.(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
    );
    return raw?.toJS?.() ?? raw;
  }

  function rawNotificationPreferencesV2() {
    const raw = other_settings?.get?.(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY,
    );
    return raw?.toJS?.() ?? raw;
  }

  const notificationPreferences = normalizeNotificationPreferences(
    rawNotificationPreferences(),
  );
  const notificationPreferencesV2 = normalizeNotificationPreferencesV2(
    rawNotificationPreferencesV2(),
    rawNotificationPreferences(),
  );
  const marketingConsent =
    other_settings?.get?.(MARKETING_CONSENT_OTHER_SETTINGS_KEY) === true;

  function setNotificationEmailMode(
    category: NotificationCategory,
    mode: NotificationEmailMode,
  ) {
    const next = normalizeNotificationPreferences(notificationPreferences);
    next.email[category] = mode;
    on_change(OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY, next);
  }

  function setCodexPreference(
    eventClass: CodexNotificationEventClass,
    patch: Partial<
      (typeof notificationPreferencesV2.ai.events)[CodexNotificationEventClass]
    >,
  ): void {
    const next = normalizeNotificationPreferencesV2(
      notificationPreferencesV2,
      notificationPreferences,
    );
    next.ai.events[eventClass] = {
      ...next.ai.events[eventClass],
      ...patch,
    };
    on_change(OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY, next);
  }

  function setCompletionDefault(enabled: boolean): void {
    const next = normalizeNotificationPreferencesV2(
      notificationPreferencesV2,
      notificationPreferences,
    );
    next.ai.completion_default = enabled;
    on_change(OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY, next);
  }

  async function requestBrowserPermission(): Promise<void> {
    if (!("Notification" in window)) return;
    setBrowserPermission(await window.Notification.requestPermission());
  }

  function showTestBrowserNotification(): void {
    if (
      !("Notification" in window) ||
      window.Notification.permission !== "granted"
    ) {
      return;
    }
    new window.Notification("CoCalc notification test", {
      body: "Browser notifications are working.",
      tag: "cocalc-notification-test",
    });
  }

  function setMarketingConsent(enabled: boolean): void {
    redux.getActions("account").set_other_settings_many({
      [MARKETING_CONSENT_OTHER_SETTINGS_KEY]: enabled,
      [MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY]:
        buildMarketingEmailConsentRecord({
          enabled,
          source: "communication-settings",
        }),
    });
  }

  function deliveryOptions(category: NotificationCategoryRow) {
    return NOTIFICATION_EMAIL_MODES.map(({ key, label }) => ({
      disabled: category.requiredEmailMode
        ? key !== category.requiredEmailMode
        : category.allowedEmailModes != null &&
          !category.allowedEmailModes.includes(key),
      label,
      value: key,
    }));
  }

  const notificationColumns: TableColumnsType<NotificationCategoryRow> = [
    {
      dataIndex: "label",
      key: "category",
      title: "Category",
    },
    {
      dataIndex: "description",
      key: "description",
      title: "Scope",
    },
    {
      key: "delivery",
      render: (_, category) => (
        <Select
          aria-label={`Delivery for ${category.label}`}
          value={notificationPreferences.email[category.key]}
          onChange={(mode) => setNotificationEmailMode(category.key, mode)}
          options={deliveryOptions(category)}
          popupMatchSelectWidth={false}
        />
      ),
      title: "Delivery",
    },
  ];

  const codexColumns: TableColumnsType<(typeof CODEX_EVENT_ROWS)[number]> = [
    { dataIndex: "label", key: "event", title: "Event" },
    ...(["inbox", "toast", "browser"] as const).map((channel) => ({
      key: channel,
      title: channel[0].toUpperCase() + channel.slice(1),
      render: (_value, event) => (
        <Switch
          size="small"
          aria-label={`${channel} notifications for ${event.label}`}
          checked={notificationPreferencesV2.ai.events[event.key][channel]}
          onChange={(checked) =>
            setCodexPreference(event.key, { [channel]: checked })
          }
        />
      ),
    })),
    {
      key: "email",
      title: "Email",
      render: (_, event) => (
        <Select
          aria-label={`Email notifications for ${event.label}`}
          value={notificationPreferencesV2.ai.events[event.key].email}
          options={CODEX_EMAIL_OPTIONS}
          popupMatchSelectWidth={false}
          onChange={(email) => setCodexPreference(event.key, { email })}
        />
      ),
    },
  ];

  function render_notification_email_preferences() {
    const hasEmailDelivery =
      NOTIFICATION_CATEGORIES.filter(({ key }) => key !== "ai").some(
        (category) =>
          notificationModeSendsEmail(
            notificationPreferences.email[category.key],
          ),
      ) ||
      CODEX_EVENT_ROWS.some(
        ({ key }) => notificationPreferencesV2.ai.events[key].email !== "off",
      );
    return (
      <Space vertical style={{ width: "100%" }}>
        {!isVerified && hasEmailDelivery && (
          <Alert
            type="warning"
            showIcon
            title="Verify your email address to receive notification email."
          />
        )}
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Text strong>Codex and agents</Text>
          <Space wrap>
            <Switch
              aria-label="Notify when Codex turns complete by default"
              checked={notificationPreferencesV2.ai.completion_default}
              onChange={setCompletionDefault}
            />
            <Text>Notify when Codex turns complete by default</Text>
          </Space>
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <Table
              aria-label="Codex and agent notification channels"
              columns={codexColumns}
              dataSource={CODEX_EVENT_ROWS}
              pagination={false}
              rowKey="key"
              size="small"
              style={{ minWidth: 650 }}
            />
          </div>
          <Space wrap>
            <Text>
              Browser permission: <strong>{browserPermission}</strong>
            </Text>
            {browserPermission === "default" ? (
              <Button
                icon={<BellOutlined />}
                onClick={() => void requestBrowserPermission()}
              >
                Enable browser notifications
              </Button>
            ) : null}
            <Button
              icon={<BellOutlined />}
              disabled={browserPermission !== "granted"}
              onClick={showTestBrowserNotification}
            >
              Test notification
            </Button>
          </Space>
        </Space>
        <div style={{ maxWidth: "100%", width: "fit-content" }}>
          <Table
            columns={notificationColumns}
            dataSource={NOTIFICATION_CATEGORIES.filter(
              ({ key }) => key !== "ai",
            )}
            pagination={false}
            rowKey="key"
          />
        </div>
      </Space>
    );
  }

  function render_marketing_email_preferences() {
    return (
      <SettingsCard title="Onboarding and marketing emails">
        <Space>
          <Switch
            aria-label="Allow optional onboarding and marketing emails"
            checked={marketingConsent}
            onChange={setMarketingConsent}
          />
          <span>
            Allow optional onboarding help, product tips, and marketing emails.
          </span>
        </Space>
      </SettingsCard>
    );
  }

  return (
    <Space vertical size="middle" style={{ width: "100%" }}>
      {render_marketing_email_preferences()}
      <SettingsCard title="Notifications">
        {render_notification_email_preferences()}
      </SettingsCard>
      <CookieConsentSettings />
    </Space>
  );
}
