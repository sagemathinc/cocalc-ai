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
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { builtinPolicyPath, type PublicConfig } from "../common";
import { PublicGrid, PublicSection } from "../layout/shell";
import { PUBLIC_TYPE } from "../theme";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { humanSize, round2 } from "@cocalc/util/misc";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

type PublicMembershipTier = MembershipPricingTier;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function supportPurchasePath({
  body,
  context,
  subject,
  title,
}: {
  body: string;
  context: string;
  subject: string;
  title: string;
}): string {
  const params = new URLSearchParams({
    body,
    context,
    subject,
    title,
    type: "purchase",
  });
  return `${appPath("support/new")}?${params.toString()}`;
}

function DecorativeButtonIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <Icon name={name} />
    </span>
  );
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

const EMPTY_COMPARISON_VALUE = (
  <Text aria-label="Not available" role="text" type="secondary">
    —
  </Text>
);

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

function formatCpuPriority(value: unknown): ReactNode {
  const priority = asNumber(value);
  if (priority == null || priority <= 1) return "Low";
  if (priority <= 2) return "Medium";
  if (priority < 8) return "High";
  return "Highest";
}

function formatBooleanValue(value: unknown): ReactNode {
  return value === true ? (
    <Text aria-label="Yes" role="text">
      ✓
    </Text>
  ) : (
    <Text aria-label="No" role="text" type="secondary">
      —
    </Text>
  );
}

// Hidden on June 15, 2026: restore with the Included AI usage row if public
// pricing should compare included AI qualitatively again.
// function positiveComparisonValues(values: readonly unknown[]): number[] {
//   return Array.from(
//     new Set(
//       values
//         .map(asNumber)
//         .filter((value): value is number => value != null && value > 0),
//     ),
//   ).sort((a, b) => a - b);
// }
//
// function formatComparativeNumberValue({
//   standardValue,
//   value,
//   values,
// }: {
//   standardValue?: unknown;
//   value: unknown;
//   values: readonly unknown[];
// }): ReactNode {
//   const numberValue = asNumber(value);
//   if (numberValue == null || numberValue <= 0) return "None";
//
//   const positiveValues = positiveComparisonValues([...values, numberValue]);
//   const standardNumber = asNumber(standardValue);
//   const effectiveStandard =
//     standardNumber != null && standardNumber > 0
//       ? standardNumber
//       : positiveValues[Math.floor((positiveValues.length - 1) / 2)];
//
//   if (effectiveStandard == null) return "None";
//   if (numberValue === effectiveStandard) return "Standard";
//   if (numberValue > effectiveStandard) return "Expanded";
//   return numberValue === positiveValues[0] ? "Minimal" : "Light";
// }

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

// Hidden on June 15, 2026: restore with the Included AI usage row if public
// pricing should compare included AI qualitatively again.
// function getAiUsageComparisonValue(
//   tier: PublicMembershipTier,
// ): number | undefined {
//   const aiLimits = asRecord(tier.ai_limits);
//   return (
//     asNumber(aiLimits.units_7d ?? aiLimits.limit_7d) ??
//     asNumber(aiLimits.units_5h ?? aiLimits.limit_5h)
//   );
// }
//
// function getStandardTierComparisonValue(
//   tiers: readonly PublicMembershipTier[],
//   value: (tier: PublicMembershipTier) => number | undefined,
// ): number | undefined {
//   const standardTier = tiers.find(
//     (tier) =>
//       tier.id === "standard" ||
//       (tier.label ?? "").toLowerCase() === "standard",
//   );
//   return standardTier == null ? undefined : value(standardTier);
// }

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
      // Hidden on June 15, 2026: collaborators are not expected to be a
      // meaningful public differentiator while limits are intentionally loose.
      // {
      //   label: "Collaborators",
      //   value: ({ tier }) =>
      //     formatNumberValue(
      //       usageLimits(tier).project_max_collaborators_and_pending_invites,
      //     ),
      // },
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
      // Hidden on June 15, 2026: included AI is not part of the public
      // comparison until the product language is finalized.
      // {
      //   label: "Included AI usage",
      //   value: ({ tier, tiers }) =>
      //     formatComparativeNumberValue({
      //       value: getAiUsageComparisonValue(tier),
      //       values: tiers.map(getAiUsageComparisonValue),
      //       standardValue: getStandardTierComparisonValue(
      //         tiers,
      //         getAiUsageComparisonValue,
      //       ),
      //     }),
      // },
    ],
  },
  {
    title: "Functionality",
    rows: [
      {
        label: "Dedicated compute",
        value: ({ tier }) =>
          formatBooleanValue(tierFeatures(tier).create_hosts),
      },
      {
        label: "Postpaid compute host billing",
        value: ({ tier }) =>
          formatBooleanValue(
            hasPositiveUsageLimit(
              tier,
              "credit_spend_limit_5h_usd",
              "credit_spend_limit_7d_usd",
            ),
          ),
      },
      // Hidden on June 15, 2026: Launchpad licensing is not developed enough
      // for the public membership comparison yet.
      // {
      //   label: "Launchpad license",
      //   value: ({ tier }) =>
      //     formatBooleanValue(
      //       tierFeatures(tier).launchpad_license === true ||
      //         tier.id === "pro",
      //     ),
      // },
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
        Compare hosted plans
      </Title>
      <div style={{ overflowX: "auto" }}>
        <table aria-label="Hosted CoCalc.ai plan comparison" style={tableStyle}>
          <thead>
            <tr>
              <th style={headerCellStyle} />
              {tiers.map((tier) => (
                <th key={tier.id} scope="col" style={headerCellStyle}>
                  <Text strong>{tier.label ?? tier.id}</Text>
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
                    <Text strong>{group.title}</Text>
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

function HostedPlansFallback({
  billingInterval,
  hasPublicTiers,
}: {
  billingInterval: BillingInterval;
  hasPublicTiers: boolean;
}) {
  const intervalLabel = billingInterval === "month" ? "monthly" : "annual";
  const message = hasPublicTiers
    ? `No ${intervalLabel} hosted plan prices are published here yet.`
    : "Hosted plan prices are not published here yet.";
  const description = hasPublicTiers
    ? "The available hosted plans do not include pricing for this billing interval in this environment. Compare operating models or talk with CoCalc about hosted memberships and organizational buying."
    : "Hosted memberships are the managed CoCalc.ai account path. Compare operating models for hosted, local, and customer-operated choices, or talk with CoCalc about memberships, site licensing, and quotes.";

  return (
    <PublicSection>
      <Alert description={description} showIcon title={message} type="info" />
      <Flex gap={12} style={{ marginTop: 16 }} wrap>
        <Button
          href={appPath("products")}
          icon={<DecorativeButtonIcon name="servers" />}
        >
          Compare operating models
        </Button>
        <Button
          href={supportPurchasePath({
            body: "I want to ask about CoCalc.ai hosted plans, memberships, or organizational buying. Helpful context: approximate users or projects, course/lab/team/institution, timeline, and procurement constraints.",
            context: "pricing-hosted-plans",
            subject: "Hosted CoCalc.ai plans",
            title: "Ask CoCalc about hosted plans",
          })}
          icon={<DecorativeButtonIcon name="support" />}
        >
          Talk with CoCalc about hosted plans
        </Button>
      </Flex>
    </PublicSection>
  );
}

export default function PricingPage({
  config,
  isAuthenticated = false,
}: {
  config?: PublicConfig;
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
  const privacyHref = builtinPolicyPath(config, "privacy");
  const trustHref = builtinPolicyPath(config, "trust");

  return (
    <>
      <Flex vertical gap="large">
        <PublicSection>
          <Title level={2} style={{ margin: 0 }}>
            Hosted CoCalc.ai plans
          </Title>
          <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
            Hosted CoCalc.ai plans let teams share projects, review work
            together in real time, recover context with TimeTravel, and keep
            building — hosted and operated by CoCalc, with no infrastructure to
            run. Plan limits below apply to hosted memberships; local,
            single-VM, and private-deployment options are in the buying paths
            below.
          </Paragraph>
          <Flex gap={12} wrap>
            <Button
              href={appPath("products")}
              icon={<DecorativeButtonIcon name="servers" />}
            >
              Compare operating models
            </Button>
          </Flex>
        </PublicSection>
        {publicTiers.length > 0 ? (
          <>
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
              <HostedPlansFallback
                billingInterval={billingInterval}
                hasPublicTiers
              />
            )}
          </>
        ) : loaded ? (
          <HostedPlansFallback
            billingInterval={billingInterval}
            hasPublicTiers={false}
          />
        ) : null}
      </Flex>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Buying paths for groups and deployments
        </Title>
        <Paragraph style={{ margin: 0 }}>
          For teams, courses, labs, and institutions, pricing is usually two
          decisions: where CoCalc runs, and what purchasing or support wrapper
          the group needs.
        </Paragraph>
        {trustHref || privacyHref ? (
          <Flex aria-label="Pricing trust materials" gap={12} role="group" wrap>
            {trustHref ? (
              <Button href={trustHref}>Review trust materials</Button>
            ) : null}
            {privacyHref ? (
              <Button href={privacyHref}>Review privacy policy</Button>
            ) : null}
          </Flex>
        ) : null}
        <PublicGrid columns={2}>
          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Team seats
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Add hosted CoCalc.ai seats for a group, then assign them to
                people who need managed access. Team seats stay inside the
                self-service hosted plan model.
              </Paragraph>
              <Button
                href={
                  isAuthenticated
                    ? appPath("settings/team-licenses")
                    : appPath("auth/sign-up")
                }
              >
                {isAuthenticated
                  ? "Manage team seats"
                  : "Sign up for team seats"}
              </Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Site licensing
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Use site licensing when an organization needs one agreement
                around procurement, governance, support expectations, rollout,
                data-location, privacy, or security questions, or deployment
                rights across CoCalc.ai, Star, Launchpad, or Rocket.
              </Paragraph>
              <Button
                href={supportPurchasePath({
                  body: "I want to discuss a CoCalc site license for an organization. Helpful context: expected users or groups, operating model, procurement timeline, onboarding needs, data-location, privacy, or security questions, and support coordination needs.",
                  context: "pricing-site-license",
                  subject: "Site licensing",
                  title: "Ask CoCalc about site licensing",
                })}
              >
                Talk with CoCalc about site licensing
              </Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Dedicated compute
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Use a compute host when hosted CoCalc.ai projects need more
                isolated or larger compute. This is hosted infrastructure, not a
                private deployment path.
              </Paragraph>
              <Button
                href={
                  isAuthenticated
                    ? appPath("hosts")
                    : appPath("docs/hosts/project-hosts")
                }
              >
                {isAuthenticated
                  ? "Manage dedicated compute"
                  : "Compute host docs"}
              </Button>
            </Space>
          </PublicSection>

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Quotes and customized invoices
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Request a quote when checkout is not enough: larger hosted
                purchases, procurement workflows, site licensing, deployment
                rights, or invoices above $100.
              </Paragraph>
              <Button
                href={supportPurchasePath({
                  body: "I want to request a quote, site license, or customized invoice for CoCalc. Helpful context: product path, expected users or projects, billing timeline, procurement process, and any deployment, privacy, security, data-location, or support constraints.",
                  context: "pricing-quote",
                  subject: "Quote, site license, or customized invoice",
                  title: "Request a CoCalc quote",
                })}
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
