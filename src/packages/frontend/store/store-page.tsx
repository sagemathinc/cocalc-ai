/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Space, Tag, Typography } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { MembershipStatusPanel } from "@cocalc/frontend/account/membership-status";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

import AdminPurchasePanel from "./admin-purchase-panel";
import VoucherPurchasePanel from "./voucher-purchase-panel";

const { Paragraph, Text, Title } = Typography;

export function StorePage() {
  const isAdmin = !!useTypedRedux("account", "is_admin");

  return (
    <div style={{ padding: "20px", overflowY: "auto" }}>
      <Title level={3} style={{ marginBottom: 4 }}>
        Store
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: "20px" }}>
        Purchase memberships and vouchers inside the app. The student-pay, team,
        and user-owned-host commerce flows are intentionally deferred to a
        second round after the Next.js rewrite is complete.
      </Paragraph>

      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Card
          extra={
            <Space>
              <Button
                onClick={() =>
                  openAccountSettings({ kind: "tab", page: "vouchers" })
                }
              >
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
              openAccountSettings({ kind: "tab", page: "vouchers" })
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
