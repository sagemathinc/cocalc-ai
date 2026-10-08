/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { EducatorOffers } from "@cocalc/conat/hub/api/purchases";
import { getSeedMembershipTierMap } from "@cocalc/server/membership/tiers";
import { toDecimal } from "@cocalc/util/money";

import {
  educatorEligibilityMessage,
  getEducatorEligibility,
} from "./eligibility";

function asPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const price = toDecimal(value as any).toNumber();
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/** Educational offers available to this account, with its eligibility. */
export async function getEducatorOffers(
  account_id: string,
): Promise<EducatorOffers> {
  const tierMap = await getSeedMembershipTierMap({ includeDisabled: false });
  const tiers = Object.values(tierMap)
    .filter((tier) => tier.instructor_purchase_visible === true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((tier) => {
      const term_price = asPrice(tier.instructor_term_price);
      const term_days = Number(tier.instructor_term_days);
      const hasTerm =
        term_price != null && Number.isInteger(term_days) && term_days > 0;
      return {
        membership_class: tier.id,
        label: tier.label ?? tier.id,
        store_description: tier.store_description ?? null,
        store_highlights: tier.store_highlights ?? [],
        price_monthly: asPrice(tier.price_monthly),
        price_yearly: asPrice(tier.price_yearly),
        term_price: hasTerm ? term_price : null,
        term_days: hasTerm ? term_days : null,
      };
    });
  if (tiers.length === 0) {
    return {
      eligibility: { eligible: false, reason: "no_offers" },
      tiers,
    };
  }
  const eligibility = await getEducatorEligibility({ account_id });
  return {
    eligibility: {
      ...eligibility,
      message: educatorEligibilityMessage(eligibility) || undefined,
    },
    tiers,
  };
}
