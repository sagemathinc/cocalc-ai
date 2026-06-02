/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Alert, Typography } from "antd";
import { defineMessage } from "react-intl";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { labels } from "@cocalc/frontend/i18n";
import { lite } from "@cocalc/frontend/lite";
import { OtherSettings } from "./other-settings";
import { CodexCredentialsPanel } from "./codex-credentials-panel";
import { CodexDefaultsPanel } from "./codex-defaults-panel";
import LiteAISettings from "./lite-ai-settings";
import { AIUsageStatus } from "@cocalc/frontend/misc/ai-usage-status";
import type { SettingsPageDefinition } from "./settings-page";

export const ACCOUNT_PREFERENCES_AI_PAGE = {
  component: AccountPreferencesAI,
  description: defineMessage({
    id: "account.settings.overview.ai",
    defaultMessage: "Configure AI assistant settings and integrations.",
  }),
  icon: ({ context }) => (
    <AIAvatar
      size={context === "overview" ? 24 : 16}
      style={context === "menu" ? { top: "-5px" } : undefined}
    />
  ),
  key: "ai",
  label: labels.ai,
} satisfies SettingsPageDefinition;

export function AccountPreferencesAI() {
  const other_settings = useTypedRedux("account", "other_settings");
  const stripe_customer = useTypedRedux("account", "stripe_customer");

  if (lite) {
    return (
      <>
        <Typography.Title level={4} style={{ marginBottom: 8 }}>
          Choose one: ChatGPT Plan or OpenAI API key
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Configure one Codex payment method for Lite.
        </Typography.Paragraph>
        <Alert
          type="info"
          showIcon
          title="If both are configured, ChatGPT Plan is used."
          style={{ marginBottom: 12 }}
        />
        <CodexCredentialsPanel />
        <CodexDefaultsPanel other_settings={other_settings} />
        <LiteAISettings />
      </>
    );
  }

  return (
    <>
      <OtherSettings
        other_settings={other_settings}
        is_stripe_customer={
          !!stripe_customer?.getIn(["subscriptions", "total_count"])
        }
        mode="ai"
      />
      <Typography.Title level={5} style={{ marginBottom: 8 }}>
        AI usage
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Current 5-hour and 7-day AI usage for your account. These limits apply
        even when you use CoCalc&apos;s shared API access.
      </Typography.Paragraph>
      <AIUsageStatus variant="full" showHelp />
      <CodexCredentialsPanel />
      <CodexDefaultsPanel other_settings={other_settings} />
    </>
  );
}
