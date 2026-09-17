/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Alert, Button, Collapse, Flex, Space, Typography } from "antd";

import { MembershipTierComparison } from "@cocalc/frontend/account/membership-tier-details";
import {
  filterMembershipTiersForBillingInterval,
  MembershipBillingSelector,
  MembershipPricingTierGrid,
  MembershipPricingTierTile,
  type BillingInterval,
  type MembershipPricingTier,
} from "@cocalc/frontend/account/membership-pricing-chooser";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { HELP_EMAIL } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

import { PublicGrid, PublicSection } from "../layout/shell";
import { publicPath } from "../routes";
import { MembershipOverviewTable } from "./membership-overview-table";
import { PUBLIC_COLORS } from "../theme";

const { Paragraph, Title } = Typography;

const PRICING_PAGE_CSS = `
  .cocalc-public-pricing {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    gap: clamp(36px, 5vw, 64px);
  }

  .cocalc-public-pricing > section:first-of-type {
    padding: 24px 0 32px;
    border-bottom: 1px solid ${PUBLIC_COLORS.border};
  }

  .cocalc-public-pricing > section:first-of-type h2 {
    font-size: clamp(28px, 3vw, 36px);
    font-weight: 500;
    letter-spacing: -0.035em;
    line-height: 1.08;
  }

  .cocalc-public-pricing > section:first-of-type .ant-typography:not(h2) {
    max-width: 720px;
    font-size: 18px;
    line-height: 1.65;
  }

  .cocalc-public-pricing > section:not(:first-of-type) {
    padding-top: 24px;
  }

  .cocalc-public-pricing h3 {
    line-height: 1.2;
  }
`;

type PublicMembershipTier = MembershipPricingTier;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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

function purchaseContactHref({
  body,
  helpEmail,
  subject,
  zendesk,
}: {
  body: string;
  helpEmail?: string;
  subject: string;
  zendesk: boolean;
}): string {
  if (zendesk) {
    return supportPurchasePath(subject, body);
  }
  return `mailto:${helpEmail?.trim() || HELP_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

export default function PricingPage({
  cocalcProduct,
  helpEmail,
  isAuthenticated = false,
  zendesk = false,
}: {
  cocalcProduct?: string;
  helpEmail?: string;
  isAuthenticated?: boolean;
  zendesk?: boolean;
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
  const hasIncludedAi = publicTiers.some(
    (tier) =>
      isPositiveNumber(tier.ai_limits?.units_5h) ||
      isPositiveNumber(tier.ai_limits?.units_7d),
  );
  const visibleTiers = filterMembershipTiersForBillingInterval(
    publicTiers,
    billingInterval,
  );
  const isPlusProduct = cocalcProduct === "plus";
  const hasProjectHostTier = publicTiers.some(
    (tier) => tier.features?.create_hosts === true,
  );
  const canEvaluateResearchCompute =
    getPublicFeaturePage("research-compute", {
      cocalc_product: cocalcProduct,
    }) != null;
  const showProjectHostPath =
    !isPlusProduct &&
    (canEvaluateResearchCompute || (isAuthenticated && hasProjectHostTier));
  const membershipHref = isAuthenticated
    ? appPath("settings/membership")
    : appPath("auth/sign-up");

  return (
    <div className="cocalc-public-pricing">
      <style>{PRICING_PAGE_CSS}</style>
      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          Find the right fit
        </Title>
        <Paragraph style={{ margin: 0 }}>
          {isPlusProduct
            ? "CoCalc Plus is the local, one-user runtime. Use the product paths below when you need hosted collaboration, a shared VM, or a customer-operated private deployment."
            : "The right setup depends on where CoCalc runs and how your team buys. The membership grid below applies to the hosted service on this site. For local, single-VM, and customer-operated paths, continue through the relevant product or contact page."}
        </Paragraph>
        {!isPlusProduct && hasIncludedAi ? (
          <Alert
            showIcon
            style={{ maxWidth: 720 }}
            title="Some memberships on this site include AI usage. Compare the current tier limits below; availability and models depend on this site's configuration."
            type="info"
          />
        ) : null}
        <Flex gap={12} wrap>
          {!isPlusProduct ? (
            <Button href={membershipHref} type="primary">
              {isAuthenticated
                ? "Manage hosted membership"
                : "Create account for hosted CoCalc"}
            </Button>
          ) : null}
          <Button href={publicPath("products")}>
            Compare operating models
          </Button>
        </Flex>
      </PublicSection>

      {!isPlusProduct && publicTiers.length > 0 ? (
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
              <MembershipOverviewTable tiers={visibleTiers} />
              <PublicSection>
                <Collapse
                  destroyOnHidden
                  items={[
                    {
                      children: (
                        <MembershipTierComparison
                          showTitle={false}
                          tiers={visibleTiers}
                        />
                      ),
                      key: "exact-membership-details",
                      label: "Compare exact limits and features",
                    },
                  ]}
                />
              </PublicSection>
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
      ) : !isPlusProduct && loaded ? (
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
          {isPlusProduct
            ? "Licensing and Deployment"
            : "For Teams and Organizations"}
        </Title>
        <PublicGrid columns={2}>
          {!isPlusProduct ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  Team seats
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Buy membership seats for a group, then assign them to the
                  people who need access. One account manages payment while each
                  person works from their own CoCalc account. The purchaser must
                  sign in before buying or managing seats.
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
                    : "Create account for team seats"}
                </Button>
              </Space>
            </PublicSection>
          ) : null}

          {!isPlusProduct ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  Organization licensing and billing
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  Departments, universities, labs, companies, and research
                  groups can arrange access for many people under one license.
                  Contact CoCalc when you need a quote, customized invoice, or
                  purchasing workflow that does not fit self-service checkout.
                </Paragraph>
                <Button
                  href={purchaseContactHref({
                    body: "I want to discuss CoCalc organization licensing, a quote, or a customized invoice. Helpful context: expected users or projects, workload, duration, product or operating model, procurement and billing requirements, and timeline.",
                    helpEmail,
                    subject: "Organization licensing or billing",
                    zendesk,
                  })}
                >
                  {zendesk
                    ? "Discuss organization pricing"
                    : "Email CoCalc about pricing"}
                </Button>
              </Space>
            </PublicSection>
          ) : null}

          {showProjectHostPath ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  Dedicated project hosts
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  First compare CPU, RAM, GPU, storage, and software needs.
                  Creating a host then requires a signed-in account with an
                  eligible membership or grant; available models, capacity, and
                  authorization vary by site and account.
                </Paragraph>
                <Flex gap={8} wrap>
                  {canEvaluateResearchCompute ? (
                    <Button href={publicPath("features/research-compute")}>
                      Evaluate research compute
                    </Button>
                  ) : null}
                  {isAuthenticated ? (
                    <Button href={appPath("hosts")}>Open project hosts</Button>
                  ) : null}
                </Flex>
              </Space>
            </PublicSection>
          ) : null}

          <PublicSection>
            <Space orientation="vertical" size="middle">
              <Title level={3} style={{ margin: 0 }}>
                Customer-operated deployments
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Compare local CoCalc Plus, one-VM CoCalc Star, and the Launchpad
                and Rocket private-deployment paths. You or your organization
                operate the infrastructure, recovery, and ongoing service.
              </Paragraph>
              <Button href={publicPath("products")}>
                Compare customer-operated options
              </Button>
            </Space>
          </PublicSection>

          {isPlusProduct ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  Quotes and customized invoices
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  For a customer-operated product purchase or billing workflow
                  that does not fit self-service, contact CoCalc with the
                  product, operating environment, and timeline.
                </Paragraph>
                <Button
                  href={purchaseContactHref({
                    body: "I want to request a quote or customized invoice for a customer-operated CoCalc product. Helpful context: expected users or projects, product or operating model, billing requirements, desired term, and timeline.",
                    helpEmail,
                    subject: "Customer-operated product quote",
                    zendesk,
                  })}
                >
                  Request a product quote
                </Button>
              </Space>
            </PublicSection>
          ) : null}
        </PublicGrid>
      </PublicSection>
    </div>
  );
}
