/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Col, Row, Space, Tag, Typography } from "antd";

import {
  buildMembershipTierPresentation,
  type MembershipTierPresentation,
  type MembershipTierPresentationInput,
} from "@cocalc/util/membership-tier-presentation";

const { Text } = Typography;

export type MembershipTierWithPresentation = MembershipTierPresentationInput & {
  presentation?: MembershipTierPresentation;
};

function getPresentation(
  tier: MembershipTierWithPresentation,
): MembershipTierPresentation {
  return tier.presentation ?? buildMembershipTierPresentation(tier);
}

function BulletList({ items, limit }: { items: string[]; limit?: number }) {
  const visible = limit == null ? items : items.slice(0, limit);
  if (visible.length === 0) {
    return <Text type="secondary">No details configured.</Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: "20px" }}>
      {visible.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Section({
  items,
  limit,
  title,
}: {
  items: string[];
  limit?: number;
  title: string;
}) {
  return (
    <Space vertical size={4} style={{ width: "100%" }}>
      <Text strong>{title}</Text>
      <BulletList items={items} limit={limit} />
    </Space>
  );
}

export function MembershipTierBenefitTags({
  limit = 3,
  tier,
}: {
  limit?: number;
  tier: MembershipTierWithPresentation;
}) {
  const presentation = getPresentation(tier);
  const items = presentation.benefits.slice(0, limit);
  if (items.length === 0) return null;
  return (
    <Space wrap size={[4, 4]}>
      {items.map((item) => (
        <Tag key={item}>{item.replace(/\.$/, "")}</Tag>
      ))}
    </Space>
  );
}

export function MembershipTierBenefits({
  compact = false,
  showBilling = true,
  tier,
}: {
  compact?: boolean;
  showBilling?: boolean;
  tier: MembershipTierWithPresentation;
}) {
  const presentation = getPresentation(tier);

  if (compact) {
    const benefits =
      presentation.summaryBenefits.length > 0
        ? presentation.summaryBenefits
        : presentation.benefits;
    const limits =
      presentation.summaryLimits.length > 0
        ? presentation.summaryLimits
        : presentation.limits;
    return (
      <Space vertical size={6} style={{ width: "100%" }}>
        <Text type="secondary">{presentation.tagline}</Text>
        <BulletList items={benefits} limit={4} />
        {limits.length > 0 && (
          <Text type="secondary">Limits: {limits.slice(0, 5).join("; ")}</Text>
        )}
        {showBilling && presentation.billing.length > 0 && (
          <Text type="secondary">
            Billing: {presentation.billing.slice(0, 2).join("; ")}
          </Text>
        )}
      </Space>
    );
  }

  return (
    <Space vertical size="middle" style={{ width: "100%" }}>
      <Text type="secondary">{presentation.tagline}</Text>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={showBilling ? 8 : 12}>
          <Card size="small">
            <Section items={presentation.benefits} title="Benefits" />
          </Card>
        </Col>
        <Col xs={24} md={showBilling ? 8 : 12}>
          <Card size="small">
            <Section items={presentation.limits} title="Limits" />
          </Card>
        </Col>
        {showBilling && (
          <Col xs={24} md={8}>
            <Card size="small">
              <Section items={presentation.billing} title="Billing" />
            </Card>
          </Col>
        )}
      </Row>
    </Space>
  );
}
