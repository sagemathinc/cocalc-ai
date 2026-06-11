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
import { currency } from "@cocalc/util/misc";

const { Paragraph, Text, Title } = Typography;

export type BillingInterval = "month" | "year";

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

export function membershipPriceValue(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? numberValue
    : undefined;
}

export function isFreeMembershipTier(tier: MembershipPricingTier): boolean {
  return (
    membershipPriceValue(tier.price_monthly) === 0 &&
    membershipPriceValue(tier.price_yearly) === 0
  );
}

export function hasPriceForBillingInterval(
  tier: MembershipPricingTier,
  billingInterval: BillingInterval,
): boolean {
  if (isFreeMembershipTier(tier)) return true;
  return billingInterval === "month"
    ? membershipPriceValue(tier.price_monthly) != null
    : membershipPriceValue(tier.price_yearly) != null;
}

export function filterMembershipTiersForBillingInterval<
  T extends MembershipPricingTier,
>(tiers: readonly T[], billingInterval: BillingInterval): T[] {
  return tiers.filter((tier) =>
    hasPriceForBillingInterval(tier, billingInterval),
  );
}

function annualSavingsPercent(tier: MembershipPricingTier): number | undefined {
  const monthly = membershipPriceValue(tier.price_monthly);
  const yearly = membershipPriceValue(tier.price_yearly);
  if (!(monthly != null && yearly != null && monthly > 0 && yearly > 0)) {
    return;
  }
  const yearlyEquivalent = monthly * 12;
  if (yearlyEquivalent <= yearly) return;
  const savings = Math.round((1 - yearly / yearlyEquivalent) * 100);
  return savings > 0 ? savings : undefined;
}

function formatMonthlyDisplayPrice(value: number): {
  amount: string;
  suffix: string;
} {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.005) {
    return { amount: currency(rounded, 0), suffix: "/ month" };
  }
  return { amount: currency(value), suffix: "/ mo" };
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
            { label: "Annual", value: "year" },
            { label: "Monthly", value: "month" },
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
  let price: { amount: string; suffix: string } | undefined;
  let billingLine = "\u00a0";
  if (!isFreeMembershipTier(tier)) {
    const savings = annualSavingsPercent(tier);
    if (billingInterval === "month") {
      price = formatMonthlyDisplayPrice(
        membershipPriceValue(tier.price_monthly) ?? 0,
      );
      billingLine =
        savings != null ? `Save ${savings}% with annual billing` : "\u00a0";
    } else {
      const yearly = membershipPriceValue(tier.price_yearly) ?? 0;
      price = formatMonthlyDisplayPrice(yearly / 12);
      billingLine =
        savings != null
          ? `Billed annually, saving ${savings}%`
          : "Billed annually";
    }
  }

  const { token } = theme.useToken();
  const promotion =
    typeof tier.trial_days === "number" && tier.trial_days > 0
      ? `${Math.floor(tier.trial_days)}-day free trial`
      : undefined;
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
          color="green"
          style={{
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
  const description =
    tier.store_description?.trim() || tier.presentation?.tagline;
  const configuredHighlights = Array.isArray(tier.store_highlights)
    ? tier.store_highlights.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];

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
