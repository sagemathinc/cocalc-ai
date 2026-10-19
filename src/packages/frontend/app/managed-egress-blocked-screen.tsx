/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, List, Space, Typography } from "antd";
import { useState } from "react";

import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import { HelpEmailLink } from "@cocalc/frontend/customize";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import {
  managedEgressBlockUpgradeHelps,
  type ManagedEgressBlockedInfo,
} from "@cocalc/frontend/purchases/managed-egress-blocked";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Paragraph, Text, Title } = Typography;

const CONTAINER_STYLE = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 16px",
  overflow: "auto",
  background: UI_COLORS.page,
} as const;

const CARD_STYLE = {
  width: "min(720px, 100%)",
  borderRadius: "16px",
  background: UI_COLORS.surface,
  borderColor: UI_COLORS.border,
  boxShadow: `0 12px 32px ${UI_COLORS.shadow}`,
} as const;

export function ManagedEgressBlockedScreen({
  blocked,
}: {
  blocked: ManagedEgressBlockedInfo;
}): React.JSX.Element {
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  // A membership upgrade raises the shared network allowance, but not the
  // account control traffic limit; only support can raise that one.
  const upgradeHelps = managedEgressBlockUpgradeHelps(blocked);
  const resetsAt =
    blocked.resets_at != null ? new Date(blocked.resets_at) : undefined;

  return (
    <div
      style={CONTAINER_STYLE}
      role="region"
      aria-labelledby="managed-egress-blocked-title"
      data-cocalc-managed-egress-blocked
    >
      <Card style={CARD_STYLE}>
        <Space vertical size="large" style={{ width: "100%" }}>
          <div>
            <Text strong style={{ color: UI_COLORS.warning }}>
              Network access temporarily blocked
            </Text>
            <Title
              id="managed-egress-blocked-title"
              level={2}
              style={{ marginTop: "8px", marginBottom: "8px" }}
            >
              {blocked.title}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              You are still signed in. This block lifts by itself once usage in
              the window drops below the limit
              {resetsAt != null && Number.isFinite(resetsAt.getTime()) ? (
                <>
                  {" "}
                  (expected around{" "}
                  <Text strong>{resetsAt.toLocaleString()}</Text>)
                </>
              ) : null}
              .
            </Paragraph>
          </div>
          {upgradeHelps ? (
            <Alert
              type="warning"
              showIcon
              title="Upgrade is still available"
              description="Use the upgrade flow below if you need more network capacity immediately. Purchase APIs continue to work even while interactive network access is blocked."
            />
          ) : (
            <Alert
              type="info"
              showIcon
              title="Need it sooner?"
              description={
                <>
                  Contact support at <HelpEmailLink /> to have this limit raised
                  for your account.
                </>
              }
            />
          )}
          {blocked.details.length > 0 ? (
            <List
              bordered
              size="small"
              dataSource={blocked.details}
              renderItem={(item) => (
                <List.Item>
                  <Text>{item}</Text>
                </List.Item>
              )}
            />
          ) : null}
          <Space wrap>
            {upgradeHelps ? (
              <Button
                type="primary"
                icon={<Icon name="shopping-cart" />}
                onClick={() => setPurchaseOpen(true)}
              >
                Upgrade membership
              </Button>
            ) : null}
            <Button
              icon={<Icon name="refresh" />}
              onClick={() => window.location.reload()}
            >
              Try again
            </Button>
          </Space>
        </Space>
      </Card>
      <MembershipPurchaseModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
      />
    </div>
  );
}
