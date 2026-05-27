/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import { Alert, Button, Flex, Space, Tag, Typography } from "antd";

import {
  MembershipTierBenefits,
  type MembershipTierWithPresentation,
} from "@cocalc/frontend/account/membership-tier-benefits";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PublicCard,
  PublicGrid,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { currency } from "@cocalc/util/misc";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

export interface PublicMembershipTier extends MembershipTierWithPresentation {
  disabled?: boolean;
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
  trial_days?: number;
  priority?: number;
  store_visible?: boolean;
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

function PricingTierTile({
  isAuthenticated,
  tier,
}: {
  isAuthenticated?: boolean;
  tier: PublicMembershipTier;
}) {
  const label = tier.label ?? tier.id;
  const trialDays =
    typeof tier.trial_days === "number" && tier.trial_days > 0
      ? Math.floor(tier.trial_days)
      : 0;

  const href = isAuthenticated
    ? appPath("settings/store")
    : appPath("auth/sign-up");

  return (
    <PublicCard
      href={href}
      title={
        <Flex align="center" gap={8} justify="space-between">
          <span>{label}</span>
          {yearlySavingsTag(tier)}
        </Flex>
      }
    >
      <Flex vertical gap="middle">
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
        {trialDays > 0 && (
          <Tag color="green">
            {trialDays}-day free trial with payment method
          </Tag>
        )}
        <MembershipTierBenefits compact tier={tier} />
      </Flex>
    </PublicCard>
  );
}

export default function PricingPage({
  isAuthenticated = false,
}: {
  isAuthenticated?: boolean;
}) {
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
      {visibleTiers.length > 0 ? (
        <PublicGrid columns={4}>
          {visibleTiers.map((tier) => (
            <PricingTierTile
              isAuthenticated={isAuthenticated}
              key={tier.id}
              tier={tier}
            />
          ))}
        </PublicGrid>
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
