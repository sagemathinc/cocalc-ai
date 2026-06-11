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

import { Alert, Button, Flex, Space, theme, Typography } from "antd";

import {
  filterMembershipTiersForBillingInterval,
  MembershipBillingSelector,
  MembershipPricingTierGrid,
  MembershipPricingTierTile,
  type BillingInterval,
  type MembershipPricingTier,
} from "@cocalc/frontend/account/membership-pricing-chooser";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicGrid, PublicSection } from "../layout/shell";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { humanSize, round2 } from "@cocalc/util/misc";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

type PublicMembershipTier = MembershipPricingTier;

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

  const publicTiers = sortMembershipTiersByDisplayOrder(
    (tiers ?? []).filter((tier) => tier.store_visible && !tier.disabled),
  );
  const visibleTiers = filterMembershipTiersForBillingInterval(
    publicTiers,
    billingInterval,
  );

  return (
    <>
      {publicTiers.length > 0 ? (
        <Flex vertical gap="large">
          <MembershipBillingSelector
            billingInterval={billingInterval}
            setBillingInterval={setBillingInterval}
          />
          {visibleTiers.length > 0 ? (
            <>
              <MembershipPricingTierGrid>
                {visibleTiers.map((tier) => (
                  <MembershipPricingTierTile
                    billingInterval={billingInterval}
                    hoverable
                    href={
                      isAuthenticated
                        ? appPath("settings/membership")
                        : appPath("auth/sign-up")
                    }
                    key={tier.id}
                    tier={tier}
                  />
                ))}
              </MembershipPricingTierGrid>
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
