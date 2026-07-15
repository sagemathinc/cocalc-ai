/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Select, Space, Switch, Table } from "antd";
import type { TableColumnsType } from "antd";
import { defineMessage } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import {
  MARKETING_CONSENT_OTHER_SETTINGS_KEY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EMAIL_MODES,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  normalizeNotificationPreferences,
  type NotificationCategory,
  type NotificationEmailMode,
} from "@cocalc/util/notification-preferences";
import { CookieConsentSettings } from "./cookie-consent-settings";
import { SettingsCard } from "./settings-card";
import type { SettingsPageDefinition } from "./settings-page";

type NotificationCategoryRow = (typeof NOTIFICATION_CATEGORIES)[number];

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

  function setMarketingConsent(enabled: boolean): void {
    on_change(MARKETING_CONSENT_OTHER_SETTINGS_KEY, enabled);
  }

  function deliveryOptions(category: NotificationCategoryRow) {
    return NOTIFICATION_EMAIL_MODES.map(({ key, label }) => ({
      disabled:
        category.requiredEmailMode != null &&
        key !== category.requiredEmailMode,
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
          value={notificationPreferences.email[category.key]}
          onChange={(mode) => setNotificationEmailMode(category.key, mode)}
          options={deliveryOptions(category)}
          popupMatchSelectWidth={false}
        />
      ),
      title: "Delivery",
    },
  ];

  function render_notification_email_preferences() {
    const hasEmailDelivery = NOTIFICATION_CATEGORIES.some(
      (category) => notificationPreferences.email[category.key] !== "off",
    );
    return (
      <Space vertical style={{ width: "100%" }}>
        {!isVerified && hasEmailDelivery && (
          <Alert
            type="warning"
            showIcon
            message="Verify your email address to receive notification email."
          />
        )}
        <div style={{ maxWidth: "100%", width: "fit-content" }}>
          <Table
            columns={notificationColumns}
            dataSource={NOTIFICATION_CATEGORIES}
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
      <SettingsCard title="Notifications">
        {render_notification_email_preferences()}
      </SettingsCard>
      {render_marketing_email_preferences()}
      <CookieConsentSettings />
    </Space>
  );
}
