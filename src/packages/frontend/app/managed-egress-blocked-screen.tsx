/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, List, Space, Typography } from "antd";
import { useState } from "react";

import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import type { ManagedEgressBlockedInfo } from "@cocalc/frontend/purchases/managed-egress-blocked";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

const CONTAINER_STYLE = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 16px",
  overflow: "auto",
  background: "#fafafa",
} as const;

const CARD_STYLE = {
  width: "min(720px, 100%)",
  borderRadius: "16px",
  boxShadow: "0 12px 32px rgba(0,0,0,0.08)",
} as const;

export function ManagedEgressBlockedScreen({
  blocked,
}: {
  blocked: ManagedEgressBlockedInfo;
}): React.JSX.Element {
  const [purchaseOpen, setPurchaseOpen] = useState(false);

  return (
    <div style={CONTAINER_STYLE}>
      <Card style={CARD_STYLE}>
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <div>
            <Text strong style={{ color: COLORS.ORANGE_WARN }}>
              Network access temporarily blocked
            </Text>
            <Title level={2} style={{ marginTop: "8px", marginBottom: "8px" }}>
              {blocked.title}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              You are still signed in, but new browser sessions are temporarily
              blocked until your managed network usage drops below the current
              window limits.
            </Paragraph>
          </div>
          <Alert
            type="warning"
            showIcon
            message="Upgrade is still available"
            description="Use the upgrade flow below if you need more network capacity immediately. Purchase APIs continue to work even while interactive network access is blocked."
          />
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
            <Button
              type="primary"
              icon={<Icon name="shopping-cart" />}
              onClick={() => setPurchaseOpen(true)}
            >
              Upgrade membership
            </Button>
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
