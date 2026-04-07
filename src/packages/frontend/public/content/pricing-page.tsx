/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";

import { Alert, Button, Card, Flex, Space, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { currency, plural, round2 } from "@cocalc/util/misc";
import { upgrades } from "@cocalc/util/upgrade-spec";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

export interface PublicMembershipTier {
  disabled?: boolean;
  features?: Record<string, unknown>;
  id: string;
  label?: string;
  llm_limits?: Record<string, unknown>;
  price_monthly?: number;
  price_yearly?: number;
  priority?: number;
  project_defaults?: Record<string, unknown>;
  store_visible?: boolean;
}

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "16px",
} as const;

const PROJECT_DEFAULT_KEYS = [
  "memory",
  "disk_quota",
  "mintime",
  "network",
  "always_running",
] as const;

const TIER_DESCRIPTIONS: Record<string, string> = {
  free: "A light entry point for evaluation and occasional use.",
  member:
    "The standard paid membership for serious day-to-day work with notebooks, terminals, and AI support.",
  pro: "Higher limits and more headroom for heavier workloads and more demanding technical projects.",
  student:
    "A time-limited class-focused membership intended for course terms rather than ongoing subscriptions.",
};

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

function normalizeRecord(value?: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} min`;
  }
  const rounded = Number.isInteger(hours) ? hours : round2(hours);
  return `${rounded} ${plural(rounded, "hour")}`;
}

function formatQuotaValue(key: string, value: unknown): string {
  const spec = (upgrades as any).params?.[key];
  if (spec?.input_type === "checkbox") {
    return value ? "Included" : "Not included";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }
  const displayValue =
    spec?.display_factor != null ? value * spec.display_factor : value;
  if (key === "mintime") {
    return formatDurationHours(displayValue);
  }
  const rounded = Number.isInteger(displayValue)
    ? displayValue
    : round2(displayValue);
  const unit = spec?.display_unit ?? spec?.unit ?? "";
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

function membershipHighlights(tier: PublicMembershipTier): string[] {
  const projectDefaults = normalizeRecord(tier.project_defaults);
  const llmLimits = normalizeRecord(tier.llm_limits);
  const features = normalizeRecord(tier.features);

  const highlights = PROJECT_DEFAULT_KEYS.flatMap((key) => {
    if (!(key in projectDefaults)) return [];
    const value = projectDefaults[key];
    if (key === "always_running" && !value) return [];
    if (key === "network") {
      return [
        value ? "Internet-enabled projects" : "No outbound internet access",
      ];
    }
    if (key === "mintime") {
      return [`Projects stay running for ${formatQuotaValue(key, value)}`];
    }
    const label =
      key === "memory"
        ? "Project memory"
        : key === "disk_quota"
          ? "Project disk"
          : "Always running";
    return [`${label}: ${formatQuotaValue(key, value)}`];
  });

  const limit5h = Number(llmLimits.units_5h ?? llmLimits.limit_5h ?? 0);
  const limit7d = Number(llmLimits.units_7d ?? llmLimits.limit_7d ?? 0);
  if (Number.isFinite(limit5h) && limit5h > 0) {
    highlights.push(
      `AI usage included with ${round2(limit5h)} units per 5 hours`,
    );
  }
  if (Number.isFinite(limit7d) && limit7d > 0) {
    highlights.push(`Rolling 7-day AI allowance: ${round2(limit7d)} units`);
  }
  if (features.create_hosts) {
    const hostTier = Number(features.project_host_tier ?? 0);
    highlights.push(
      hostTier > 0
        ? `Can rent custom project hosts (tier ${hostTier})`
        : "Can rent custom project hosts",
    );
  }

  return highlights.slice(0, 5);
}

function yearlySavingsTag(tier: PublicMembershipTier): ReactNode {
  const monthly = Number(tier.price_monthly ?? 0);
  const yearly = Number(tier.price_yearly ?? 0);
  if (!(monthly > 0) || !(yearly > 0)) return null;
  const yearlyEquivalent = monthly * 12;
  if (!(yearlyEquivalent > yearly)) return null;
  const savings = Math.round((1 - yearly / yearlyEquivalent) * 100);
  if (!(savings > 0)) return null;
  return <Tag color="blue">Save about {savings}% yearly</Tag>;
}

function TierCard({
  isAuthenticated,
  tier,
}: {
  isAuthenticated?: boolean;
  tier: PublicMembershipTier;
}) {
  const label = tier.label ?? tier.id;
  const highlights = membershipHighlights(tier);
  const description =
    TIER_DESCRIPTIONS[tier.id] ??
    "A public membership tier configured by this deployment.";

  return (
    <Card
      styles={{
        body: {
          display: "grid",
          gap: 12,
          height: "100%",
        },
      }}
      variant="outlined"
    >
      <Flex align="center" gap={8} justify="space-between">
        <Title level={3} style={{ margin: 0 }}>
          {label}
        </Title>
        {yearlySavingsTag(tier)}
      </Flex>
      <Paragraph style={{ margin: 0 }}>{description}</Paragraph>
      <div>
        <Text strong style={{ fontSize: "1.35rem" }}>
          {currency(Number(tier.price_monthly ?? 0))}
        </Text>
        <Text type="secondary"> / month</Text>
      </div>
      <div>
        <Text strong>{currency(Number(tier.price_yearly ?? 0))}</Text>
        <Text type="secondary"> / year</Text>
      </div>
      {highlights.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: "20px" }}>
          {highlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <Text type="secondary">Detailed limits are configured by admins.</Text>
      )}
      <Flex gap={8} wrap>
        {isAuthenticated ? (
          <Button href={appPath("settings/store")} type="primary">
            Open Store
          </Button>
        ) : (
          <>
            <Button href={appPath("auth/sign-up")} type="primary">
              Create account
            </Button>
            <Button href={appPath("auth/sign-in")}>Sign in</Button>
          </>
        )}
      </Flex>
    </Card>
  );
}

export default function PricingPage({
  isAuthenticated = false,
  siteName,
  tiers,
}: {
  isAuthenticated?: boolean;
  siteName: string;
  tiers?: PublicMembershipTier[];
}) {
  const visibleTiers = [...(tiers ?? [])]
    .filter((tier) => tier.store_visible && !tier.disabled)
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return ap - bp;
      return (a.label ?? a.id).localeCompare(b.label ?? b.id);
    });

  return (
    <>
      <PublicSectionCard>
        <Title level={2} style={{ margin: 0 }}>
          Membership-first pricing
        </Title>
        <Paragraph style={{ margin: 0 }}>
          {siteName} now sells access primarily through memberships. The
          complicated legacy model of buying quotas for one individual project
          is going away. The one intentional pay-as-you-go exception is custom
          user-owned project hosts under <Text code>/hosts</Text>.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          Visible membership tiers below come directly from this deployment's
          admin configuration. Use the store for self-serve memberships and
          vouchers, and use support for campus, institute, or invoice-based
          purchasing.
        </Paragraph>
        <Flex gap={8} wrap>
          {isAuthenticated ? (
            <Button href={appPath("settings/store")} type="primary">
              Open Store
            </Button>
          ) : (
            <>
              <Button href={appPath("auth/sign-up")} type="primary">
                Create account
              </Button>
              <Button href={appPath("auth/sign-in")}>Sign in</Button>
            </>
          )}
          <Button
            href={supportPurchasePath(
              "Membership and campus pricing",
              "I want to ask about memberships, vouchers, or campus-wide pricing.",
            )}
          >
            Ask Sales
          </Button>
        </Flex>
      </PublicSectionCard>

      {visibleTiers.length > 0 ? (
        <div style={GRID_STYLE}>
          {visibleTiers.map((tier) => (
            <TierCard
              isAuthenticated={isAuthenticated}
              key={tier.id}
              tier={tier}
            />
          ))}
        </div>
      ) : (
        <PublicSectionCard>
          <Alert
            title="No public membership tiers are currently configured."
            showIcon
            type="info"
          />
        </PublicSectionCard>
      )}

      <PublicSectionCard>
        <Title level={2} style={{ margin: 0 }}>
          What you can buy
        </Title>
        <div style={GRID_STYLE}>
          <Card variant="borderless">
            <Title level={4}>Individual memberships</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              The main product is a recurring membership. Admins define the
              actual tiers and prices, and those tiers determine the defaults
              for project resources, AI usage, and feature access.
            </Paragraph>
          </Card>
          <Card variant="borderless">
            <Title level={4}>Vouchers</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              Vouchers let an instructor, department, or organization prepay
              credit and distribute redeemable codes. They are a practical way
              to cover accounts today without waiting for the fuller team and
              campus purchasing flows.
            </Paragraph>
          </Card>
          <Card variant="borderless">
            <Title level={4}>Self-hosted software</Title>
            <Paragraph style={{ marginBottom: 0 }}>
              CoCalc Plus and CoCalc Launchpad are separate software offerings
              for local and self-hosted deployments. They are not project-level
              quota purchases.
            </Paragraph>
          </Card>
        </div>
      </PublicSectionCard>

      <PublicSectionCard>
        <Title level={2} style={{ margin: 0 }}>
          Teaching and course payment options
        </Title>
        <div style={GRID_STYLE}>
          <Card variant="outlined">
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
          </Card>

          <Card variant="outlined">
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
          </Card>

          <Card variant="outlined">
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
          </Card>
        </div>
      </PublicSectionCard>

      <div style={GRID_STYLE}>
        <PublicSectionCard>
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
        </PublicSectionCard>

        <PublicSectionCard>
          <Title level={3} style={{ margin: 0 }}>
            On-premises and self-hosted installs
          </Title>
          <Paragraph style={{ margin: 0 }}>
            If you want to run CoCalc yourself, use the existing software
            offerings instead of the hosted membership flow.
          </Paragraph>
          <Flex gap={8} wrap>
            <Button href={appPath("software/cocalc-plus")}>CoCalc Plus</Button>
            <Button href={appPath("software/cocalc-launchpad")}>
              CoCalc Launchpad
            </Button>
          </Flex>
        </PublicSectionCard>

        <PublicSectionCard>
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
        </PublicSectionCard>
      </div>
    </>
  );
}
