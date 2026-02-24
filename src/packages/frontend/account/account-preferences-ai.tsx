/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Alert, Typography } from "antd";
import { lite } from "@cocalc/frontend/lite";
import { OtherSettings } from "./other-settings";
import { CodexCredentialsPanel } from "./codex-credentials-panel";
import LiteAISettings from "./lite-ai-settings";

export function AccountPreferencesAI() {
  const other_settings = useTypedRedux("account", "other_settings");
  const stripe_customer = useTypedRedux("account", "stripe_customer");
  const kucalc = useTypedRedux("customize", "kucalc");

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
          message="If both are configured, ChatGPT Plan is used."
          style={{ marginBottom: 12 }}
        />
        <CodexCredentialsPanel />
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
        kucalc={kucalc}
        mode="ai"
      />
      <CodexCredentialsPanel />
    </>
  );
}
