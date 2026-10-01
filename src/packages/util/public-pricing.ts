/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The public /pricing page. The React page and the crawler fallback in
// hub/servers/app/public-prerender.ts both use these helpers and strings, so
// crawlers read the same tiers, prices and text as people do.

import {
  sortMembershipTiersByDisplayOrder,
  type MembershipTierOrderInput,
} from "./membership-tier-order";
import { currency } from "./misc";

export type BillingInterval = "month" | "year";

export const BILLING_INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "Monthly",
  year: "Annual",
};

export interface PublicPricingTier extends MembershipTierOrderInput {
  ai_limits?: Record<string, unknown>;
  disabled?: boolean;
  presentation?: { tagline?: string };
  store_description?: string;
  store_highlights?: readonly string[];
  store_visible?: boolean;
  trial_days?: unknown;
}

export const PUBLIC_PRICING_INCLUDED_AI_ALERT =
  "Some memberships on this site include AI usage. Compare the current tier limits below; availability and models depend on this site's configuration.";

export const PUBLIC_PRICING_NO_TIERS =
  "No public membership tiers are currently configured.";

export const PUBLIC_PRICING_TEAMS_TITLE = "For Teams and Organizations";

export const PUBLIC_PRICING_PLUS_TEAMS_TITLE = "Licensing and Deployment";

export const PUBLIC_PRICING_TEAM_SEATS = {
  body: "Buy membership seats for a group, then assign them to the people who need access. One account manages payment while each person works from their own CoCalc account. The purchaser must sign in before buying or managing seats.",
  title: "Team seats",
} as const;

export const PUBLIC_PRICING_ORGANIZATION_LICENSING = {
  body: "Departments, universities, labs, companies, and research groups can arrange access for many people under one license. Contact CoCalc when you need a quote, customized invoice, or purchasing workflow that does not fit self-service checkout.",
  title: "Organization licensing and billing",
} as const;

export const PUBLIC_PRICING_PROJECT_HOSTS = {
  body: "First compare CPU, RAM, GPU, storage, and software needs. Creating a host then requires a signed-in account with an eligible membership or grant; available models, capacity, and authorization vary by site and account.",
  title: "Dedicated project hosts",
} as const;

export const PUBLIC_PRICING_CUSTOMER_OPERATED = {
  body: "Compare local CoCalc Plus, one-VM CoCalc Star, and the Launchpad and Rocket private-deployment paths. You or your organization operate the infrastructure, recovery, and ongoing service.",
  title: "Customer-operated deployments",
} as const;

export const PUBLIC_PRICING_PRODUCT_QUOTES = {
  body: "For a customer-operated product purchase or billing workflow that does not fit self-service, contact CoCalc with the product, operating environment, and timeline.",
  title: "Quotes and customized invoices",
} as const;

// The tiers anyone may buy from the store, in display order. The tier API
// also returns tiers that are not for sale in the store (team, course and
// private tiers), and admins also get disabled ones.
export function publicStoreMembershipTiers<T extends PublicPricingTier>(
  tiers: readonly T[],
): T[] {
  return sortMembershipTiersByDisplayOrder(
    tiers.filter((tier) => tier.store_visible === true && !tier.disabled),
  );
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function membershipTiersIncludeAi(
  tiers: readonly PublicPricingTier[],
): boolean {
  return tiers.some(
    (tier) =>
      isPositiveNumber(tier.ai_limits?.units_5h) ||
      isPositiveNumber(tier.ai_limits?.units_7d),
  );
}

export function membershipPriceValue(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? numberValue
    : undefined;
}

export function isFreeMembershipTier(
  tier: Pick<MembershipTierOrderInput, "price_monthly" | "price_yearly">,
): boolean {
  return (
    membershipPriceValue(tier.price_monthly) === 0 &&
    membershipPriceValue(tier.price_yearly) === 0
  );
}

export function hasPriceForBillingInterval(
  tier: Pick<MembershipTierOrderInput, "price_monthly" | "price_yearly">,
  billingInterval: BillingInterval,
): boolean {
  if (isFreeMembershipTier(tier)) return true;
  return billingInterval === "month"
    ? membershipPriceValue(tier.price_monthly) != null
    : membershipPriceValue(tier.price_yearly) != null;
}

export function filterMembershipTiersForBillingInterval<
  T extends Pick<MembershipTierOrderInput, "price_monthly" | "price_yearly">,
>(tiers: readonly T[], billingInterval: BillingInterval): T[] {
  return tiers.filter((tier) =>
    hasPriceForBillingInterval(tier, billingInterval),
  );
}

function annualSavingsPercent(
  tier: Pick<MembershipTierOrderInput, "price_monthly" | "price_yearly">,
): number | undefined {
  const monthly = membershipPriceValue(tier.price_monthly);
  const yearly = membershipPriceValue(tier.price_yearly);
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

export interface MembershipPriceDisplay {
  amount: string;
  billingLine?: string;
  suffix: string;
}

// A tier's price as a monthly amount for one billing interval. Free tiers
// show no price.
export function membershipPriceDisplay(
  tier: Pick<MembershipTierOrderInput, "price_monthly" | "price_yearly">,
  billingInterval: BillingInterval,
): MembershipPriceDisplay | undefined {
  if (isFreeMembershipTier(tier)) return;
  const savings = annualSavingsPercent(tier);
  if (billingInterval === "month") {
    return {
      ...formatMonthlyDisplayPrice(
        membershipPriceValue(tier.price_monthly) ?? 0,
      ),
      billingLine:
        savings != null ? `Save ${savings}% with annual billing` : undefined,
    };
  }
  return {
    ...formatMonthlyDisplayPrice(
      (membershipPriceValue(tier.price_yearly) ?? 0) / 12,
    ),
    billingLine:
      savings != null
        ? `Billed annually, saving ${savings}%`
        : "Billed annually",
  };
}

export function membershipTrialLabel(tier: {
  trial_days?: unknown;
}): string | undefined {
  return typeof tier.trial_days === "number" && tier.trial_days > 0
    ? `${Math.floor(tier.trial_days)}-day free trial`
    : undefined;
}

export function membershipStoreDescription(
  tier: Pick<PublicPricingTier, "presentation" | "store_description">,
): string | undefined {
  return tier.store_description?.trim() || tier.presentation?.tagline;
}

export function membershipStoreHighlights(
  tier: Pick<PublicPricingTier, "store_highlights">,
): string[] {
  return Array.isArray(tier.store_highlights)
    ? tier.store_highlights.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];
}
