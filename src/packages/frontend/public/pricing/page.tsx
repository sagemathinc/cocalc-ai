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
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import {
  membershipTiersIncludeAi,
  PUBLIC_PRICING_CUSTOMER_OPERATED,
  PUBLIC_PRICING_INCLUDED_AI_ALERT,
  PUBLIC_PRICING_NO_TIERS,
  PUBLIC_PRICING_ORGANIZATION_LICENSING,
  PUBLIC_PRICING_PLUS_TEAMS_TITLE,
  PUBLIC_PRICING_PRODUCT_QUOTES,
  PUBLIC_PRICING_PROJECT_HOSTS,
  PUBLIC_PRICING_TEAM_SEATS,
  PUBLIC_PRICING_TEAMS_TITLE,
  publicStoreMembershipTiers,
} from "@cocalc/util/public-pricing";
import { HELP_EMAIL } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

import { PublicGrid, PublicSection } from "../layout/shell";
import { publicPath } from "../routes";
import { MembershipOverviewTable } from "./membership-overview-table";

const { Paragraph, Title } = Typography;

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

  const publicTiers = publicStoreMembershipTiers(tiers ?? []);
  const hasIncludedAi = membershipTiersIncludeAi(publicTiers);
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
    <>
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
            title={PUBLIC_PRICING_INCLUDED_AI_ALERT}
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
          <Alert title={PUBLIC_PRICING_NO_TIERS} showIcon type="info" />
        </PublicSection>
      ) : null}

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          {isPlusProduct
            ? PUBLIC_PRICING_PLUS_TEAMS_TITLE
            : PUBLIC_PRICING_TEAMS_TITLE}
        </Title>
        <PublicGrid columns={2}>
          {!isPlusProduct ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  {PUBLIC_PRICING_TEAM_SEATS.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {PUBLIC_PRICING_TEAM_SEATS.body}
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
                  {PUBLIC_PRICING_ORGANIZATION_LICENSING.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {PUBLIC_PRICING_ORGANIZATION_LICENSING.body}
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
                  {PUBLIC_PRICING_PROJECT_HOSTS.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {PUBLIC_PRICING_PROJECT_HOSTS.body}
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
                {PUBLIC_PRICING_CUSTOMER_OPERATED.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>
                {PUBLIC_PRICING_CUSTOMER_OPERATED.body}
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
                  {PUBLIC_PRICING_PRODUCT_QUOTES.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {PUBLIC_PRICING_PRODUCT_QUOTES.body}
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
    </>
  );
}
