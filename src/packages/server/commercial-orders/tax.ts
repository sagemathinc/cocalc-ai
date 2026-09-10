/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { CommercialOrder } from "@cocalc/util/commercial-orders";

export function commercialTaxPolicy(terms: Record<string, unknown> = {}): {
  enabled: boolean;
  taxCode?: string;
} {
  const invoice = terms.invoice as Record<string, unknown> | undefined;
  if (invoice?.automatic_tax == null || invoice.automatic_tax === false) {
    return { enabled: false };
  }
  if (invoice.automatic_tax !== true) {
    throw Error("invoice automatic_tax must be a boolean");
  }
  if (
    typeof invoice.tax_code !== "string" ||
    !/^txcd_\d{8}$/.test(invoice.tax_code)
  ) {
    throw Error(
      "automatic tax requires a reviewed invoice tax_code (txcd_ followed by 8 digits)",
    );
  }
  const address = invoice.billing_address as
    | Record<string, unknown>
    | undefined;
  if (
    typeof address?.country !== "string" ||
    !/^[A-Za-z]{2}$/.test(address.country)
  ) {
    throw Error("automatic tax requires a reviewed billing country");
  }
  return { enabled: true, taxCode: invoice.tax_code };
}

export function assertCommercialAutomaticTax(
  provider: {
    automatic_tax?: { enabled?: boolean; status?: string | null } | null;
  },
  order: Pick<CommercialOrder, "terms_snapshot">,
): void {
  const { enabled } = commercialTaxPolicy(order.terms_snapshot);
  if (provider.automatic_tax?.enabled !== enabled) {
    throw Error("Stripe tax configuration does not match the approved order");
  }
  if (enabled && provider.automatic_tax?.status !== "complete") {
    throw Error(
      "Stripe automatic tax calculation is not complete; review the customer address and tax settings",
    );
  }
}
