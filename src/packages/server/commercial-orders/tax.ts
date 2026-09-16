/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import type Stripe from "stripe";

type StripeClient = InstanceType<typeof Stripe>;
type InvoiceLine = Awaited<
  ReturnType<StripeClient["invoices"]["listLineItems"]>
>["data"][number];

export async function assertCommercialInvoiceLineTax(
  stripe: Pick<StripeClient, "prices" | "products">,
  line: Pick<InvoiceLine, "pricing">,
  order: Pick<CommercialOrder, "terms_snapshot">,
): Promise<void> {
  const policy = commercialTaxPolicy(order.terms_snapshot);
  if (!policy.enabled) return;

  // Invoice lines expose price/product references, not the tax_code and
  // tax_behavior accepted by invoiceItems.create. Resolve fresh provider data
  // on every verification, including retries of already-finalized invoices.
  const details = line.pricing?.price_details;
  const priceId =
    typeof details?.price === "string" ? details.price : details?.price?.id;
  if (!priceId || !details?.product) {
    throw Error("Stripe invoice line tax settings cannot be verified");
  }
  const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
  const product =
    typeof price.product === "string"
      ? await stripe.products.retrieve(price.product)
      : price.product;
  if (
    price.id !== priceId ||
    price.tax_behavior !== "exclusive" ||
    product.id !== details.product ||
    product.deleted ||
    (typeof product.tax_code === "string"
      ? product.tax_code
      : product.tax_code?.id) !== policy.taxCode
  ) {
    throw Error("Stripe invoice line tax settings do not match reviewed terms");
  }
}

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
