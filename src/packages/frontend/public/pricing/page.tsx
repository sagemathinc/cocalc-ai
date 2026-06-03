/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useState,
} from "react";

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
import { currency, humanSize, round2 } from "@cocalc/util/misc";
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

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
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

const EMPTY_COMPARISON_VALUE = <Text type="secondary">—</Text>;

type ComparisonRow = {
  label: string;
  value: (context: {
    tier: PublicMembershipTier;
    tiers: readonly PublicMembershipTier[];
  }) => ReactNode;
};

type ComparisonGroup = {
  rows: ComparisonRow[];
  title: string;
};

function formatNumberValue(value: unknown): ReactNode {
  const numberValue = asNumber(value);
  return numberValue == null ? EMPTY_COMPARISON_VALUE : `${numberValue}`;
}

function formatMbValue(value: unknown): ReactNode {
  const numberValue = asNumber(value);
  if (numberValue == null) return EMPTY_COMPARISON_VALUE;
  if (numberValue >= 1000) {
    const gb = numberValue / 1000;
    return `${Number.isInteger(gb) ? gb : round2(gb)} GB`;
  }
  return `${numberValue} MB`;
}

function formatBytesValue(value: unknown): ReactNode {
  const numberValue = asNumber(value);
  return numberValue == null ? EMPTY_COMPARISON_VALUE : humanSize(numberValue);
}

function formatBooleanValue(value: unknown): ReactNode {
  return value === true ? (
    <Text aria-label="Yes">✓</Text>
  ) : (
    <Text aria-label="No" type="secondary">
      —
    </Text>
  );
}

function positiveComparisonValues(values: readonly unknown[]): number[] {
  return Array.from(
    new Set(
      values
        .map(asNumber)
        .filter((value): value is number => value != null && value > 0),
    ),
  ).sort((a, b) => a - b);
}

function formatComparativeNumberValue({
  standardValue,
  value,
  values,
}: {
  standardValue?: unknown;
  value: unknown;
  values: readonly unknown[];
}): ReactNode {
  const numberValue = asNumber(value);
  if (numberValue == null || numberValue <= 0) return "None";

  const positiveValues = positiveComparisonValues([...values, numberValue]);
  const standardNumber = asNumber(standardValue);
  const effectiveStandard =
    standardNumber != null && standardNumber > 0
      ? standardNumber
      : positiveValues[Math.floor((positiveValues.length - 1) / 2)];

  if (effectiveStandard == null) return "None";
  if (numberValue === effectiveStandard) return "Standard";
  if (numberValue > effectiveStandard) return "Expanded";
  return numberValue === positiveValues[0] ? "Minimal" : "Light";
}

function hasPositiveUsageLimit(
  tier: PublicMembershipTier,
  firstKey: string,
  secondKey: string,
): boolean {
  const limits = usageLimits(tier);
  return [firstKey, secondKey].some((key) => {
    const limit = asNumber(limits[key]);
    return limit != null && limit > 0;
  });
}

function getAiUsageComparisonValue(
  tier: PublicMembershipTier,
): number | undefined {
  const aiLimits = asRecord(tier.ai_limits);
  return (
    asNumber(aiLimits.units_7d ?? aiLimits.limit_7d) ??
    asNumber(aiLimits.units_5h ?? aiLimits.limit_5h)
  );
}

function getStandardTierComparisonValue(
  tiers: readonly PublicMembershipTier[],
  value: (tier: PublicMembershipTier) => number | undefined,
): number | undefined {
  const standardTier = tiers.find(
    (tier) =>
      tier.id === "standard" || (tier.label ?? "").toLowerCase() === "standard",
  );
  return standardTier == null ? undefined : value(standardTier);
}

function projectDefaults(tier: PublicMembershipTier): Record<string, unknown> {
  return asRecord(tier.project_defaults);
}

function usageLimits(tier: PublicMembershipTier): Record<string, unknown> {
  return asRecord(tier.usage_limits);
}

function tierFeatures(tier: PublicMembershipTier): Record<string, unknown> {
  return asRecord(tier.features);
}

const COMPARISON_GROUPS: ComparisonGroup[] = [
  {
    title: "Project Limits",
    rows: [
      {
        label: "RAM",
        value: ({ tier }) => formatMbValue(projectDefaults(tier).memory),
      },
      {
        label: "Disk",
        value: ({ tier }) => formatMbValue(projectDefaults(tier).disk_quota),
      },
      {
        label: "Collaborators",
        value: ({ tier }) =>
          formatNumberValue(
            usageLimits(tier).project_max_collaborators_and_pending_invites,
          ),
      },
    ],
  },
  {
    title: "Global Limits",
    rows: [
      {
        label: "Projects owned",
        value: ({ tier }) => formatNumberValue(usageLimits(tier).max_projects),
      },
      {
        label: "Projects running",
        value: ({ tier }) =>
          formatNumberValue(usageLimits(tier).max_sponsored_running_projects),
      },
      {
        label: "Total disk",
        value: ({ tier }) => {
          const limits = usageLimits(tier);
          return formatBytesValue(
            limits.total_storage_hard_bytes ?? limits.total_storage_soft_bytes,
          );
        },
      },
      {
        label: "Included AI usage",
        value: ({ tier, tiers }) =>
          formatComparativeNumberValue({
            value: getAiUsageComparisonValue(tier),
            values: tiers.map(getAiUsageComparisonValue),
            standardValue: getStandardTierComparisonValue(
              tiers,
              getAiUsageComparisonValue,
            ),
          }),
      },
    ],
  },
  {
    title: "Functionality",
    rows: [
      {
        label: "Dedicated hosts",
        value: ({ tier }) =>
          formatBooleanValue(tierFeatures(tier).create_hosts),
      },
      {
        label: "Postpaid dedicated-host billing",
        value: ({ tier }) =>
          formatBooleanValue(
            hasPositiveUsageLimit(
              tier,
              "credit_spend_limit_5h_usd",
              "credit_spend_limit_7d_usd",
            ),
          ),
      },
      {
        label: "Launchpad license",
        value: ({ tier }) =>
          formatBooleanValue(
            tierFeatures(tier).launchpad_license === true || tier.id === "pro",
          ),
      },
    ],
  },
];

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

function PricingComparisonTable({ tiers }: { tiers: PublicMembershipTier[] }) {
  const { token } = theme.useToken();
  const tableStyle: CSSProperties = {
    borderCollapse: "collapse",
    minWidth: "100%",
  };
  const headerCellStyle: CSSProperties = {
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    paddingBlock: token.paddingSM,
    paddingInline: token.padding,
    textAlign: "center",
    whiteSpace: "nowrap",
  };
  const rowHeaderStyle: CSSProperties = {
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    paddingBlock: token.paddingSM,
    paddingInline: token.padding,
    textAlign: "left",
    whiteSpace: "nowrap",
  };
  const valueCellStyle: CSSProperties = {
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    paddingBlock: token.paddingSM,
    paddingInline: token.padding,
    textAlign: "center",
    whiteSpace: "nowrap",
  };
  const groupCellStyle: CSSProperties = {
    background: token.colorFillAlter,
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    paddingBlock: token.paddingSM,
    paddingInline: token.padding,
    textAlign: "left",
  };

  return (
    <PublicSection>
      <Title level={2} style={{ margin: 0 }}>
        Compare Memberships
      </Title>
      <div style={{ overflowX: "auto" }}>
        <table aria-label="Membership comparison" style={tableStyle}>
          <thead>
            <tr>
              <th style={headerCellStyle} />
              {tiers.map((tier) => (
                <th key={tier.id} scope="col" style={headerCellStyle}>
                  <Title level={4} style={{ margin: 0 }}>
                    {tier.label ?? tier.id}
                  </Title>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_GROUPS.map((group) => (
              <Fragment key={group.title}>
                <tr>
                  <th
                    colSpan={tiers.length + 1}
                    scope="colgroup"
                    style={groupCellStyle}
                  >
                    <Title level={4} style={{ margin: 0 }}>
                      {group.title}
                    </Title>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={`${group.title}-${row.label}`}>
                    <th scope="row" style={rowHeaderStyle}>
                      <Text>{row.label}</Text>
                    </th>
                    {tiers.map((tier) => (
                      <td
                        key={`${row.label}-${tier.id}`}
                        style={valueCellStyle}
                      >
                        {row.value({ tier, tiers })}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </PublicSection>
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
            <>
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
              <PricingComparisonTable tiers={visibleTiers} />
            </>
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
          For Teams and Organizations
        </Title>
        <PublicGrid columns={2}>
          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Team seats
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Buy membership seats for a group, then assign them to the people
                who need access. One account manages payment while each person
                works from their own CoCalc account.
              </Paragraph>
              <Button href={appPath("settings/team-licenses")}>
                Manage team seats
              </Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Organization licenses
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Departments, universities, labs, companies, and research groups
                can arrange access for many people under one license.
              </Paragraph>
              <Button
                href={supportPurchasePath(
                  "Organization license",
                  "I want to discuss a CoCalc organization license.",
                )}
              >
                Contact sales
              </Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Dedicated project hosts
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Run projects on dedicated compute when shared resources are not
                enough. Memberships determine which dedicated host options are
                available to your account.
              </Paragraph>
              <Button href={appPath("hosts")}>Open project hosts</Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Quotes and customized invoices
              </Title>
              <Paragraph style={{ margin: 0 }}>
                For purchases above $100 or billing workflows that do not fit
                self-service checkout, contact us for a quote or customized
                invoice.
              </Paragraph>
              <Button
                href={supportPurchasePath(
                  "Quote or customized invoice",
                  "I want to request a quote or customized invoice for CoCalc.",
                )}
              >
                Request a quote
              </Button>
            </Space>
          </PublicSection>
        </PublicGrid>
      </PublicSection>
    </>
  );
}
