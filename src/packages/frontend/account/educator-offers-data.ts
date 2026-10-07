/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Lightweight educational-offer helpers (no payment UI imports), shared by the
// membership page card and the course seat checkout.

import { useEffect, useState } from "react";

import type {
  EducatorOfferTier,
  EducatorOffers,
} from "@cocalc/conat/hub/api/purchases";
import { getEducatorOffers } from "@cocalc/frontend/purchases/api";
import openSupport from "@cocalc/frontend/support/open";
import { currency } from "@cocalc/util/misc";

export function educatorTermProduct(tier: { membership_class: string }) {
  return {
    type: "membership-package" as const,
    kind: "team" as const,
    membership_class: tier.membership_class,
    seat_count: 1,
    metadata: { educator_term: true },
  };
}

export function educatorPriceSummary(tier: EducatorOfferTier): string {
  const parts: string[] = [];
  if (tier.price_monthly != null) {
    parts.push(`${currency(tier.price_monthly)}/month`);
  }
  if (tier.price_yearly != null) {
    parts.push(`${currency(tier.price_yearly)}/year`);
  }
  if (tier.term_price != null && tier.term_days != null) {
    parts.push(
      `${currency(tier.term_price)} for one ${tier.term_days}-day term`,
    );
  }
  return parts.join(" · ");
}

export function requestEducatorApproval(email?: string) {
  openSupport({
    type: "purchase",
    subject: "Request educator verification for educational membership",
    body: `I teach at an academic institution and would like to buy an educational membership${
      email ? ` with my verified email address ${email}` : ""
    }.\n\nInstitution:\nCourse(s) I teach:\nLink to a page showing my teaching role:\n`,
    required: "Institution:\nCourse(s) I teach:",
    hideExtra: true,
  });
}

export function useEducatorOffers(): {
  offers: EducatorOffers | null;
  error: string;
  loading: boolean;
} {
  const [offers, setOffers] = useState<EducatorOffers | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  useEffect(() => {
    let canceled = false;
    Promise.resolve()
      .then(() => getEducatorOffers())
      .then((result) => {
        if (!canceled) setOffers(result);
      })
      .catch((err) => {
        if (!canceled) setError(`${err}`);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, []);
  return { offers, error, loading };
}
