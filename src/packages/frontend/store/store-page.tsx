/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Space, Tag, Typography } from "antd";
import { defineMessage } from "react-intl";
import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { MembershipStatusPanel } from "@cocalc/frontend/account/membership-status";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { labels } from "@cocalc/frontend/i18n";
import { joinUrlPath } from "@cocalc/util/url-path";

import AdminPurchasePanel from "./admin-purchase-panel";
import VoucherPurchasePanel from "./voucher-purchase-panel";

const { Paragraph, Text, Title } = Typography;

export const STORE_SETTINGS_PAGE = {
  component: StorePage,
  description: defineMessage({
    id: "account.settings.overview.store",
    defaultMessage:
      "Buy memberships, team seats, and vouchers, then jump directly to project host billing.",
  }),
  icon: "shopping-cart",
  key: "store",
  label: labels.store,
} satisfies SettingsPageDefinition;

export function StorePage() {
  const isAdmin = !!useTypedRedux("account", "is_admin");

  return (
    <div style={{ padding: "20px", overflowY: "auto" }}>
      <Title level={3} style={{ marginBottom: 4 }}>
        Store
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: "20px" }}>
        Purchase memberships and vouchers inside the app. Course seats, team
        seats, and user-owned-host commerce flows are handled from their
        purpose-built pages.
      </Paragraph>

      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <Card
          extra={
            <Space>
              <Button onClick={() => openAccountSettings({ page: "vouchers" })}>
                Voucher Center
              </Button>
              <Button href={joinUrlPath(appBasePath, "hosts")}>
                Project Hosts
              </Button>
            </Space>
          }
          title="Membership"
        >
          <MembershipStatusPanel showHeader={false} />
        </Card>

        <Card title="Credit vouchers">
          <VoucherPurchasePanel
            onOpenVoucherCenter={() =>
              openAccountSettings({ page: "vouchers" })
            }
          />
        </Card>

        <Card
          title={
            <Space>
              Student memberships
              <Tag>Second round</Tag>
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            The focused four-month student membership flow replaces the old
            token pages, but it is explicitly deferred until after this Next.js
            migration lands.
          </Paragraph>
        </Card>

        <Card
          title={
            <Space>
              User-owned host billing
              <Tag>Second round</Tag>
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Billing for project hosts will live under <Text code>/hosts</Text>.
            The store links there, but the pricing model and monthly charge flow
            are a separate follow-up.
          </Paragraph>
        </Card>

        {isAdmin && <AdminPurchasePanel />}
      </Space>
    </div>
  );
}
