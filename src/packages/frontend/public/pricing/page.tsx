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
import { getPublicPricingContent } from "@cocalc/util/public-pricing-content";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function catalogPrice(value: unknown): number | undefined {
  // Missing prices are not zero: the corresponding billing interval is unavailable.
  if (value == null) return undefined;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error("Invalid catalog price");
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0)
    throw new Error("Invalid catalog price");
  return price;
}

function catalogTier(value: unknown): PublicMembershipTier {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("Invalid catalog tier");
  }
  for (const key of [
    "label",
    "store_description",
    "site_license_pool_description",
  ]) {
    if (value[key] != null && typeof value[key] !== "string")
      throw new Error("Invalid catalog text");
  }
  for (const key of ["disabled", "store_visible", "course_store_visible"]) {
    if (value[key] != null && typeof value[key] !== "boolean")
      throw new Error("Invalid catalog flag");
  }
  for (const key of [
    "priority",
    "trial_days",
    "course_duration_days",
    "course_grace_days",
  ]) {
    if (
      value[key] != null &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    ) {
      throw new Error("Invalid catalog number");
    }
  }
  if (
    value.store_highlights != null &&
    (!Array.isArray(value.store_highlights) ||
      !value.store_highlights.every((item) => typeof item === "string"))
  ) {
    throw new Error("Invalid catalog highlights");
  }
  for (const key of [
    "ai_limits",
    "features",
    "project_defaults",
    "usage_limits",
  ]) {
    const record = value[key];
    if (
      record != null &&
      (!isRecord(record) ||
        Object.values(record).some(
          (item) =>
            item != null &&
            !["number", "string", "boolean"].includes(typeof item),
        ))
    ) {
      throw new Error("Invalid catalog limits");
    }
  }
  const presentation = value.presentation;
  if (presentation != null) {
    if (
      !isRecord(presentation) ||
      (presentation.tagline != null &&
        typeof presentation.tagline !== "string") ||
      (presentation.detailGroups != null &&
        (!Array.isArray(presentation.detailGroups) ||
          !presentation.detailGroups.every(
            (group) =>
              isRecord(group) &&
              typeof group.key === "string" &&
              typeof group.title === "string" &&
              Array.isArray(group.details) &&
              group.details.every(
                (detail) =>
                  isRecord(detail) &&
                  typeof detail.key === "string" &&
                  typeof detail.label === "string" &&
                  typeof detail.value === "string" &&
                  (detail.help == null || typeof detail.help === "string"),
              ),
          )))
    ) {
      throw new Error("Invalid catalog presentation");
    }
  }
  return {
    ...value,
    price_monthly: catalogPrice(value.price_monthly),
    price_yearly: catalogPrice(value.price_yearly),
    course_price: catalogPrice(value.course_price),
  } as PublicMembershipTier;
}

async function loadMembershipTiers(
  signal: AbortSignal,
): Promise<PublicMembershipTier[]> {
  const resp = await fetch(
    joinUrlPath(appBasePath, "api/v2/purchases/get-membership-tiers"),
    { signal },
  );
  if (!resp.ok) throw new Error("Membership catalog request failed");
  const payload = await resp.json();
  if (!Array.isArray(payload?.tiers) || payload.error != null) {
    throw new Error("Membership catalog response is invalid");
  }
  const tiers = payload.tiers.map(catalogTier);
  if (new Set(tiers.map((tier) => tier.id)).size !== tiers.length) {
    throw new Error("Duplicate catalog tier");
  }
  return tiers;
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
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [request, setRequest] = useState(0);
  const isPlusProduct = cocalcProduct === "plus";
  const content = getPublicPricingContent(cocalcProduct);

  useEffect(() => {
    if (isPlusProduct) return;
    let canceled = false;
    let timedOut = false;
    const controller = new AbortController();
    setCatalogState("loading");
    setTiers(undefined);
    const timeout = setTimeout(() => {
      if (canceled) return;
      timedOut = true;
      controller.abort();
      setCatalogState("error");
    }, 20_000);
    void loadMembershipTiers(controller.signal)
      .then((value) => {
        if (canceled || timedOut) return;
        setTiers(value);
        setCatalogState("ready");
      })
      .catch(() => {
        if (!canceled && !timedOut) setCatalogState("error");
      })
      .finally(() => {
        clearTimeout(timeout);
      });
    return () => {
      canceled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [cocalcProduct, isPlusProduct, request]);

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
          {content.hero.title}
        </Title>
        <Paragraph style={{ margin: 0 }}>{content.hero.description}</Paragraph>
        <Flex gap={12} wrap>
          {isPlusProduct ? (
            <Button
              href={publicPath("products/cocalc-plus#install-cocalc-plus")}
              type="primary"
            >
              Review CoCalc Plus setup
            </Button>
          ) : (
            <Button href={membershipHref} type="primary">
              {isAuthenticated
                ? "Manage hosted membership"
                : "Create account for hosted CoCalc"}
            </Button>
          )}
          <Button href={publicPath("products")}>
            Compare operating models
          </Button>
        </Flex>
      </PublicSection>

      {!isPlusProduct && catalogState === "loading" ? (
        <PublicSection>
          <Paragraph role="status">Loading membership plans…</Paragraph>
        </PublicSection>
      ) : !isPlusProduct && catalogState === "error" ? (
        <PublicSection>
          <Alert
            showIcon
            type="warning"
            title="Membership plans could not be loaded."
            description="Try again to see current plans and prices."
            action={
              <Button onClick={() => setRequest((value) => value + 1)}>
                Try again
              </Button>
            }
          />
        </PublicSection>
      ) : !isPlusProduct && publicTiers.length > 0 ? (
        <Flex vertical gap="large">
          <Title level={2} style={{ margin: 0 }}>
            {content.memberships.title}
          </Title>
          <Paragraph style={{ margin: 0 }}>
            {content.memberships.description}
          </Paragraph>
          <MembershipBillingSelector
            billingInterval={billingInterval}
            setBillingInterval={setBillingInterval}
          />
          <Paragraph style={{ margin: 0, textAlign: "center" }}>
            {content.memberships.billing}
          </Paragraph>
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
              <Paragraph style={{ margin: 0, maxWidth: 760 }}>
                {content.memberships.upgrade}
              </Paragraph>
              {!isPlusProduct && hasIncludedAi ? (
                <Alert
                  showIcon
                  style={{ maxWidth: 720 }}
                  title={content.memberships.ai}
                  type="info"
                />
              ) : null}
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
      ) : !isPlusProduct && catalogState === "ready" ? (
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
          {content.nextTitle}
        </Title>
        <PublicGrid columns={2}>
          {!isPlusProduct ? (
            <PublicSection>
              <Space orientation="vertical" size="middle">
                <Title level={3} style={{ margin: 0 }}>
                  {content.team.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {content.team.description}
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
                  {content.organization.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {content.organization.description}
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
                  {content.host.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {content.host.description}
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
                {content.deployment.title}
              </Title>
              <Paragraph style={{ margin: 0 }}>
                {content.deployment.description}
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
                  {content.quote.title}
                </Title>
                <Paragraph style={{ margin: 0 }}>
                  {content.quote.description}
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
