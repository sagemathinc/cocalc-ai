/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Typography } from "antd";
import { defineMessage } from "react-intl";
import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import SupportTicketsView from "@cocalc/frontend/public/support/tickets-view";
import openSupportTab from "./open";

const { Paragraph, Title } = Typography;

export const SupportTickets: React.FC = () => {
  const helpEmail = useTypedRedux("customize", "help_email");
  const zendesk = !!useTypedRedux("customize", "zendesk");

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Title level={3} style={{ marginBottom: 8 }}>
          Support
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Create a support ticket without leaving the app, paste screenshots
          directly into the composer, and review your existing Zendesk tickets
          below.
          {helpEmail ? ` You can also reach us at ${helpEmail}.` : ""}
        </Paragraph>
      </div>
      <Space wrap>
        <Button type="primary" onClick={() => openSupportTab()}>
          New support ticket
        </Button>
      </Space>
      <SupportTicketsView config={{ zendesk }} />
    </Space>
  );
};

export const SUPPORT_TICKETS_SETTINGS_PAGE = {
  component: SupportTickets,
  description: defineMessage({
    id: "account.settings.overview.support",
    defaultMessage: "Access support tickets and help resources.",
  }),
  icon: "medkit",
  key: "support",
  label: labels.support,
} satisfies SettingsPageDefinition;
