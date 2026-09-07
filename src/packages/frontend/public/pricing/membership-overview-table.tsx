/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Fragment, type CSSProperties, type ReactNode } from "react";

import { theme, Typography } from "antd";

import type { MembershipPricingTier } from "@cocalc/frontend/account/membership-pricing-chooser";
import { humanSize, round2 } from "@cocalc/util/misc";

import { PublicSection } from "../layout/shell";

const { Text, Title } = Typography;

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
    tier: MembershipPricingTier;
    tiers: readonly MembershipPricingTier[];
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

function formatCpuPriority(value: unknown): ReactNode {
  const priority = asNumber(value);
  if (priority == null || priority <= 1) return "Low";
  if (priority <= 2) return "Medium";
  if (priority < 8) return "High";
  return "Highest";
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

function projectDefaults(tier: MembershipPricingTier): Record<string, unknown> {
  return asRecord(tier.project_defaults);
}

function usageLimits(tier: MembershipPricingTier): Record<string, unknown> {
  return asRecord(tier.usage_limits);
}

function tierFeatures(tier: MembershipPricingTier): Record<string, unknown> {
  return asRecord(tier.features);
}

function hasPositiveUsageLimit(
  tier: MembershipPricingTier,
  firstKey: string,
  secondKey: string,
): boolean {
  const limits = usageLimits(tier);
  return [firstKey, secondKey].some((key) => {
    const limit = asNumber(limits[key]);
    return limit != null && limit > 0;
  });
}

const COMPARISON_GROUPS: ComparisonGroup[] = [
  {
    title: "Limits Per Project",
    rows: [
      {
        label: "CPU priority",
        value: ({ tier }) =>
          formatCpuPriority(usageLimits(tier).shared_compute_priority),
      },
      {
        label: "RAM",
        value: ({ tier }) => formatMbValue(projectDefaults(tier).memory),
      },
      {
        label: "Disk",
        value: ({ tier }) => formatMbValue(projectDefaults(tier).disk_quota),
      },
    ],
  },
  {
    title: "Global Limits Across All Projects",
    rows: [
      {
        label: "Owned Projects",
        value: ({ tier }) => formatNumberValue(usageLimits(tier).max_projects),
      },
      {
        label: "Running Projects",
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
    ],
  },
  {
    title: "Functionality",
    rows: [
      {
        label:
          "Dedicated Project Host VM with much larger RAM, CPU, and Disk (pay as you go)",
        value: ({ tier }) =>
          formatBooleanValue(tierFeatures(tier).create_hosts),
      },
      {
        label: "Pay at the end of the month for dedicated project host",
        value: ({ tier }) =>
          formatBooleanValue(
            hasPositiveUsageLimit(
              tier,
              "credit_spend_limit_5h_usd",
              "credit_spend_limit_7d_usd",
            ),
          ),
      },
    ],
  },
];

export function MembershipOverviewTable({
  tiers,
}: {
  tiers: MembershipPricingTier[];
}) {
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
      <div
        role="region"
        aria-label="Membership comparison"
        tabIndex={0}
        style={{ overflowX: "auto" }}
      >
        <table aria-label="Membership comparison" style={tableStyle}>
          <thead>
            <tr>
              <th style={headerCellStyle} />
              {tiers.map((tier) => (
                <th key={tier.id} scope="col" style={headerCellStyle}>
                  <Text strong style={{ fontSize: 20, lineHeight: "28px" }}>
                    {tier.label ?? tier.id}
                  </Text>
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
                    <Text strong style={{ fontSize: 20, lineHeight: "28px" }}>
                      {group.title}
                    </Text>
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
