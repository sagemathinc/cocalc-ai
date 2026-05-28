/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Flex,
  Segmented,
  Space,
  Tag,
  theme,
  Typography,
} from "antd";

import type { MembershipTierWithPresentation } from "@cocalc/frontend/account/membership-tier-benefits";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicGrid,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { currency } from "@cocalc/util/misc";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;
type BillingInterval = "month" | "year";

export interface PublicMembershipTier extends MembershipTierWithPresentation {
  disabled?: boolean;
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
  trial_days?: number;
  priority?: number;
  store_visible?: boolean;
  store_description?: string;
  store_highlights?: readonly string[];
}

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function supportPurchasePath(subject: string, body: string): string {
  const params = new URLSearchParams({
    body,
    subject,
    title: "Ask Sales",
    type: "purchase",
  });
  return `${appPath("support/new")}?${params.toString()}`;
}

async function loadMembershipTiers(): Promise<
  PublicMembershipTier[] | undefined
> {
  try {
    const resp = await fetch(
      joinUrlPath(appBasePath, "api/v2/purchases/get-membership-tiers"),
    );
    const payload = await resp.json();
    return Array.isArray(payload?.tiers) ? payload.tiers : undefined;
  } catch {
    return undefined;
  }
}

function priceValue(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? numberValue
    : undefined;
}

function isFreeTier(tier: PublicMembershipTier): boolean {
  return (
    priceValue(tier.price_monthly) === 0 && priceValue(tier.price_yearly) === 0
  );
}

function hasPriceForInterval(
  tier: PublicMembershipTier,
  billingInterval: BillingInterval,
): boolean {
  if (isFreeTier(tier)) return true;
  return billingInterval === "month"
    ? priceValue(tier.price_monthly) != null
    : priceValue(tier.price_yearly) != null;
}

function annualSavingsPercent(tier: PublicMembershipTier): number | undefined {
  const monthly = priceValue(tier.price_monthly);
  const yearly = priceValue(tier.price_yearly);
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

function PricingBillingSelector({
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
            { label: "Monthly", value: "month" },
            { label: "Annual", value: "year" },
          ]}
          size="large"
          value={billingInterval}
        />
      </Flex>
    </ConfigProvider>
  );
}

function PricingTierPayment({
  billingInterval,
  label,
  tier,
}: {
  billingInterval: BillingInterval;
  label: string;
  tier: PublicMembershipTier;
}) {
  let price: { amount: string; suffix: string } | undefined;
  let billingLine = "\u00a0";
  if (!isFreeTier(tier)) {
    const savings = annualSavingsPercent(tier);
    if (billingInterval === "month") {
      price = formatMonthlyDisplayPrice(priceValue(tier.price_monthly) ?? 0);
      billingLine =
        savings != null ? `Save ${savings}% with annual billing` : "\u00a0";
    } else {
      const yearly = priceValue(tier.price_yearly) ?? 0;
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

function PricingTierBody({ tier }: { tier: PublicMembershipTier }) {
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

function PricingTierTile({
  billingInterval,
  isAuthenticated,
  tier,
}: {
  billingInterval: BillingInterval;
  isAuthenticated?: boolean;
  tier: PublicMembershipTier;
}) {
  const label = tier.label ?? tier.id;
  const href = isAuthenticated
    ? appPath("settings/store")
    : appPath("auth/sign-up");
  const { token } = theme.useToken();

  return (
    <a
      href={href}
      style={{
        color: "inherit",
        display: "block",
        height: "100%",
        textDecoration: "none",
      }}
    >
      <Card
        className="cocalc-public-card"
        hoverable
        styles={{
          body: { height: "100%" },
          header: { paddingBlock: token.paddingSM },
          title: { whiteSpace: "normal" },
        }}
        style={{ height: "100%" }}
        title={
          <PricingTierPayment
            billingInterval={billingInterval}
            label={label}
            tier={tier}
          />
        }
        variant="outlined"
      >
        <PricingTierBody tier={tier} />
      </Card>
    </a>
  );
}

export default function PricingPage({
  isAuthenticated = false,
}: {
  isAuthenticated?: boolean;
}) {
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("year");
  const [tiers, setTiers] = useState<PublicMembershipTier[]>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let canceled = false;
    void loadMembershipTiers()
      .then((value) => {
        if (!canceled) setTiers(value ?? []);
      })
      .finally(() => {
        if (!canceled) setLoaded(true);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const publicTiers = [...(tiers ?? [])]
    .filter((tier) => tier.store_visible && !tier.disabled)
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return ap - bp;
      return (a.label ?? a.id).localeCompare(b.label ?? b.id);
    });
  const visibleTiers = publicTiers.filter((tier) =>
    hasPriceForInterval(tier, billingInterval),
  );

  return (
    <>
      {publicTiers.length > 0 ? (
        <Flex vertical gap="large">
          <PricingBillingSelector
            billingInterval={billingInterval}
            setBillingInterval={setBillingInterval}
          />
          {visibleTiers.length > 0 ? (
            <PublicGrid columns={4}>
              {visibleTiers.map((tier) => (
                <PricingTierTile
                  billingInterval={billingInterval}
                  isAuthenticated={isAuthenticated}
                  key={tier.id}
                  tier={tier}
                />
              ))}
            </PublicGrid>
          ) : (
            <PublicSection>
              <Alert
                title={`No ${billingInterval === "month" ? "monthly" : "annual"} membership tiers are currently configured.`}
                showIcon
                type="info"
              />
            </PublicSection>
          )}
        </Flex>
      ) : loaded ? (
        <PublicSection>
          <Alert
            title="No public membership tiers are currently configured."
            showIcon
            type="info"
          />
        </PublicSection>
      ) : null}

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          What you can buy
        </Title>
        <PublicGrid columns={3}>
          <PublicSection>
            <Title level={4}>Individual memberships</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              The main product is a recurring membership. Admins define the
              actual tiers and prices, and those tiers determine the defaults
              for project resources, AI usage, and feature access.
            </Paragraph>
          </PublicSection>
          <PublicSection>
            <Title level={4}>Vouchers</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              Vouchers let an instructor, department, or organization prepay
              credit and distribute redeemable codes. They are a practical way
              to cover accounts today without waiting for the fuller team and
              campus purchasing flows.
            </Paragraph>
          </PublicSection>
          <PublicSection>
            <Title level={4}>Self-hosted software</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              CoCalc Plus and CoCalc Launchpad are separate software offerings
              for local and self-hosted deployments. They are not project-level
              quota purchases.
            </Paragraph>
          </PublicSection>
        </PublicGrid>
      </PublicSection>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Teaching and course payment options
        </Title>
        <PublicGrid columns={3}>
          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Flex align="center" gap={8} wrap>
                <Title level={4} style={{ margin: 0 }}>
                  Students pay directly
                </Title>
                <Tag color="processing">Planned student tier</Tag>
              </Flex>
              <Paragraph style={{ margin: 0 }}>
                The long-term course model is a one-off four-month student
                membership. It does not renew automatically and is meant for a
                single academic term, even if the student is enrolled in more
                than one class at once.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This dedicated student-membership flow is a second-round
                deliverable after the Next.js removal itself lands.
              </Paragraph>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Flex align="center" gap={8} wrap>
                <Title level={4} style={{ margin: 0 }}>
                  Instructor or institute pays
                </Title>
                <Tag color="green">Current path</Tag>
              </Flex>
              <Paragraph style={{ margin: 0 }}>
                Today the practical way to cover a course is for an instructor
                or institution to buy memberships or vouchers on behalf of
                students. That can be done through the in-app store, admin
                assisted purchase, or voucher batches.
              </Paragraph>
              <Flex gap={8} wrap>
                <Button href={appPath("redeem")}>Redeem a voucher</Button>
                <Button
                  href={supportPurchasePath(
                    "Cover memberships for a course",
                    "I want to cover memberships for students in a class.",
                  )}
                >
                  Contact sales
                </Button>
              </Flex>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Flex align="center" gap={8} wrap>
                <Title level={4} style={{ margin: 0 }}>
                  Campus-wide site license
                </Title>
                <Tag color="gold">Important next step</Tag>
              </Flex>
              <Paragraph style={{ margin: 0 }}>
                The future institutional model is that verified campus email
                accounts automatically receive a configured membership tier.
                That is not implemented yet, but it is a major planned product
                direction and the right path for broad campus adoption.
              </Paragraph>
              <Button
                href={supportPurchasePath(
                  "Campus-wide site license",
                  "I want to discuss a campus-wide CoCalc membership deployment.",
                )}
              >
                Ask about campus pricing
              </Button>
            </Space>
          </PublicSection>
        </PublicGrid>
      </PublicSection>

      <PublicGrid columns={3}>
        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            Subscription options
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Memberships can be configured monthly and yearly. Yearly pricing is
            usually the lower-friction option for individuals or labs that know
            they want the service for the full academic or business year.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            For purchasing workflows that do not fit self-service card checkout,
            use support to request invoicing, purchase-order handling, or
            assisted purchases.
          </Paragraph>
        </PublicSection>

        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            On-premises and self-hosted installs
          </Title>
          <Paragraph style={{ margin: 0 }}>
            If you want to run CoCalc yourself, use the existing software
            offerings instead of the hosted membership flow.
          </Paragraph>
          <Flex gap={8} wrap>
            <Button href={appPath("products/cocalc-plus")}>CoCalc Plus</Button>
            <Button href={appPath("products/cocalc-launchpad")}>
              CoCalc Launchpad
            </Button>
          </Flex>
        </PublicSection>

        <PublicSection>
          <Title level={3} style={{ margin: 0 }}>
            User-owned project hosts
          </Title>
          <Paragraph style={{ margin: 0 }}>
            Custom project hosts are the one planned pay-as-you-go exception.
            Membership controls whether you can rent them and what spending
            model applies, but the host billing flow itself lives under
            <Text code> /hosts </Text> and is a separate second-round follow-up.
          </Paragraph>
          <Button href={appPath("hosts")}>Project hosts</Button>
        </PublicSection>
      </PublicGrid>
    </>
  );
}
