/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import {
  Card,
  ConfigProvider,
  Flex,
  Segmented,
  Tag,
  theme,
  Typography,
} from "antd";

import type { MembershipTierWithPresentation } from "./membership-tier-benefits";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  BILLING_INTERVAL_LABELS,
  membershipPriceDisplay,
  membershipStoreDescription,
  membershipStoreHighlights,
  membershipTrialLabel,
  type BillingInterval,
} from "@cocalc/util/public-pricing";

const { Paragraph, Text, Title } = Typography;

export {
  filterMembershipTiersForBillingInterval,
  hasPriceForBillingInterval,
  isFreeMembershipTier,
  membershipPriceValue,
} from "@cocalc/util/public-pricing";
export type { BillingInterval };

export interface MembershipPricingTier extends MembershipTierWithPresentation {
  ai_limits?: Record<string, unknown>;
  disabled?: boolean;
  features?: Record<string, unknown>;
  id: string;
  label?: string;
  price_monthly?: unknown;
  price_yearly?: unknown;
  priority?: number;
  project_defaults?: Record<string, unknown>;
  store_description?: string;
  store_highlights?: readonly string[];
  store_visible?: boolean;
  trial_days?: number;
  usage_limits?: Record<string, unknown>;
}

export function MembershipBillingSelector({
  billingInterval,
  setBillingInterval,
}: {
  billingInterval: BillingInterval;
  setBillingInterval: (value: BillingInterval) => void;
}) {
  const { token } = theme.useToken();
  return (
    <ConfigProvider
      theme={{
        components: {
          Segmented: {
            itemSelectedBg: token.colorPrimary,
            itemSelectedColor: token.colorTextLightSolid,
            trackBg: token.colorBgContainer,
          },
        },
      }}
    >
      <Flex justify="center">
        <Segmented<BillingInterval>
          onChange={setBillingInterval}
          options={[
            { label: BILLING_INTERVAL_LABELS.year, value: "year" },
            { label: BILLING_INTERVAL_LABELS.month, value: "month" },
          ]}
          size="large"
          value={billingInterval}
        />
      </Flex>
    </ConfigProvider>
  );
}

function MembershipPricingTierPayment({
  billingInterval,
  label,
  tier,
}: {
  billingInterval: BillingInterval;
  label: string;
  tier: MembershipPricingTier;
}) {
  const price = membershipPriceDisplay(tier, billingInterval);
  const billingLine = price?.billingLine ?? "\u00a0";

  const { token } = theme.useToken();
  const promotion = membershipTrialLabel(tier);
  const promotionPlaceholder = "7-day free trial";

  return (
    <Flex vertical gap={token.marginXS}>
      <Flex
        align="center"
        justify="center"
        style={{
          minHeight: token.controlHeightSM,
        }}
      >
        <Tag
          aria-hidden={promotion == null}
          style={{
            color: UI_COLORS.success,
            background: UI_COLORS.successBg,
            borderColor: UI_COLORS.success,
            marginInlineEnd: 0,
            visibility: promotion == null ? "hidden" : undefined,
          }}
        >
          {promotion ?? promotionPlaceholder}
        </Tag>
      </Flex>
      <Flex align="baseline" gap="middle" justify="space-between" wrap>
        <Title level={3} style={{ margin: 0 }}>
          {label}
        </Title>
        {price != null ? (
          <Flex align="baseline" gap={token.marginXXS} wrap={false}>
            <Text
              strong
              style={{
                color: token.colorText,
                fontSize: token.fontSizeHeading3,
                lineHeight: token.lineHeightHeading3,
                whiteSpace: "nowrap",
              }}
            >
              {price.amount}
            </Text>
            <Text type="secondary" style={{ whiteSpace: "nowrap" }}>
              {price.suffix}
            </Text>
          </Flex>
        ) : null}
      </Flex>
      <Text
        type="secondary"
        style={{
          display: "block",
          fontSize: token.fontSize,
          lineHeight: token.lineHeight,
          minHeight: token.fontSize * token.lineHeight,
          textAlign: "center",
        }}
      >
        {billingLine}
      </Text>
    </Flex>
  );
}

function MembershipPricingTierBody({ tier }: { tier: MembershipPricingTier }) {
  const { token } = theme.useToken();
  const description = membershipStoreDescription(tier);
  const configuredHighlights = membershipStoreHighlights(tier);

  return (
    <Flex vertical gap="middle">
      {description ? (
        <Paragraph style={{ margin: 0 }}>{description}</Paragraph>
      ) : null}
      {configuredHighlights.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingInlineStart: token.paddingLG,
          }}
        >
          {configuredHighlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </Flex>
  );
}

export function MembershipPricingTierGrid({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: "grid",
        gap: token.padding,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MembershipPricingTierTile({
  billingInterval,
  current = false,
  hoverable = false,
  href,
  onClick,
  tier,
}: {
  billingInterval: BillingInterval;
  current?: boolean;
  hoverable?: boolean;
  href?: string;
  onClick?: () => void;
  tier: MembershipPricingTier;
}) {
  const label = tier.label ?? tier.id;
  const { token } = theme.useToken();
  const isInteractive = href != null || onClick != null || hoverable;

  const card = (
    <Card
      className="cocalc-public-card"
      hoverable={isInteractive}
      styles={{
        body: { height: "100%" },
        header: { paddingBlock: token.paddingSM },
        title: { whiteSpace: "normal" },
      }}
      style={{
        background: current ? token.colorInfoBg : undefined,
        borderColor: current ? token.colorPrimary : undefined,
        height: "100%",
      }}
      title={
        <MembershipPricingTierPayment
          billingInterval={billingInterval}
          label={label}
          tier={tier}
        />
      }
      variant="outlined"
    >
      <MembershipPricingTierBody tier={tier} />
    </Card>
  );

  const wrapperStyle: CSSProperties = {
    color: "inherit",
    display: "block",
    height: "100%",
    textDecoration: "none",
  };

  if (href != null) {
    return (
      <a href={href} style={wrapperStyle}>
        {card}
      </a>
    );
  }

  if (onClick != null) {
    return (
      <button
        onClick={onClick}
        style={{
          ...wrapperStyle,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          font: "inherit",
          padding: 0,
          textAlign: "left",
          width: "100%",
        }}
        type="button"
      >
        {card}
      </button>
    );
  }

  return card;
}
